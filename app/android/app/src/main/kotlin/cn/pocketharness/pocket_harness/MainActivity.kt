package cn.pocketharness.pocket_harness

import android.os.Handler
import android.os.Looper
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.util.concurrent.ConcurrentHashMap

/**
 * 本机 dsh 需要的两件原生能力：拿到 APK 的 nativeLibraryDir，以及启动子进程并逐行读输出。
 *
 * 为什么不在 Dart 侧起进程：Dart 的 Process.start 在 Android 上走的是同一个 exec，
 * 但父进程是 Flutter 的 UI 线程池，子进程没有自己的会话，`dsh web` 起监听后
 * 一旦 Flutter 引擎重建就会连坐。这里用 ProcessBuilder 直接管，生命周期跟着 Activity 走。
 */
class MainActivity : FlutterActivity() {
    private val runs = ConcurrentHashMap<String, Process>()
    private var events: EventChannel.EventSink? = null
    private val main = Handler(Looper.getMainLooper())

    /// sink 是空的这段时间里产生的输出。
    ///
    /// EventChannel 的 `onListen` 要跨一次平台往返才到。而 proot 跑一条
    /// `node --version && dsh --version` 只要 150 ms —— 如果这时直接把事件丢掉，
    /// 调用方永远等不到 exit，界面就一直停在「还没装」。
    ///
    /// 但它必须有上限：`onCancel` 之后 sink 是 null，而 proot 的输出照旧在写
    /// （`npm install -g` 一条要跑二十分钟、打上万行）。没有上限的话，只要订阅
    /// 断过一次（切后台、引擎重建、页面 dispose），之后每一行都会永远留在内存里。
    /// 只在这个列表上做增删的都是主线程代码（emit 走 Handler.post，onListen 本来
    /// 就在主线程），所以用普通 ArrayDeque，不需要并发结构。
    private val pending = java.util.ArrayDeque<Map<String, Any>>()

    /// 上次补发之后，哪些 tag 的输出被丢过。补发时给每个 tag 先发一条说明。
    private val droppedTags = LinkedHashSet<String>()

    /// 把动态链接的 proot 需要的 .so 摆成它要找的名字。
    ///
    /// jniLibs 里的文件只能叫 `lib*.so`（否则 AGP 不会装进 nativeLibraryDir），
    /// 而 Termux 版 proot 的 DT_NEEDED 写的是 `libtalloc.so.2`。从数据目录
    /// dlopen 是允许的（只有 exec 被禁），所以在 files/lib 里放一份规范名字的
    /// 副本，再用 LD_LIBRARY_PATH 指过去。
    private fun prepareLibDir(): String {
        val dir = File(filesDir, "lib")
        dir.mkdirs()
        val rename = mapOf(
            "libtalloc.so" to "libtalloc.so.2",
            // 另外两个保持原名，只是搬一份到可写目录，好让 LD_LIBRARY_PATH
            // 只指一个地方就能覆盖全部依赖（nativeLibraryDir 里是 AGP 装好的
            // 原始名字，但那里不能保证每次都在搜索路径里）。
            "libandroid-shmem.so" to "libandroid-shmem.so",
            // Termux 版 proot 在 exec 目标前会 exec 这个 loader。它默认从
            // ../libexec/proot/loader 找，用 PROOT_LOADER 指到 nativeLibraryDir
            // 里的副本（jniLibs 只能叫 lib*.so，AGP 才会装进去）。
            "libproot-loader.so" to "libproot-loader.so",
        )
        rename.forEach { (from, to) ->
            val source = File(applicationInfo.nativeLibraryDir, from)
            val target = File(dir, to)
            if (source.exists() && (!target.exists() || target.length() != source.length())) {
                source.copyTo(target, overwrite = true)
            }
        }
        return dir.absolutePath
    }

    /// 诊断用：用 `adb shell am start -n .../.MainActivity --es selftest 1` 触发，
    /// 把 proot 在本应用 seccomp 环境下的真实退出码打进 logcat。
    /// 应用进程带 untrusted_app 的 seccomp 过滤器，而 `adb shell` / `su` 没有，
    /// 所以「命令行下能跑」不等于「应用里能跑」。
    private fun runSelfTest() {
        val tag = "PocketSelfTest"
        val lib = File(applicationInfo.nativeLibraryDir, "libproot.so").absolutePath
        val rootfs = File(filesDir, "dsh-root").absolutePath
        val tmp = File(filesDir, "tmp").absolutePath
        File(tmp).mkdirs()
        val libDir = prepareLibDir()
        val libs = "$libDir:${applicationInfo.nativeLibraryDir}"
        val cases = listOf(
            "probe-version" to (listOf(lib, "--version") to mapOf()),
            // 带 -r 但立刻 --version 退出：把「参数解析 / 路径规范化」和
            // 「真正开始跟踪子进程」两段分开。前者过、后者死，就说明死点在
            // ptrace/loader，而不是 rootfs 本身。
            "probe-r-version" to (listOf(lib, "-r", rootfs, "--version") to mapOf()),
            "probe-badroot" to (listOf(lib, "-r", "/nope/never", "--version") to mapOf()),
            // 真正 exec 一个 rootfs 里的二进制。下面几条在猜死点：
            //  - foreign 关掉 loader（proot 会先把自己抽到 TMPDIR 再 exec，
            //    而 Android 10 起应用数据目录里的文件不能 exec）；
            //  - kompat 关掉 process_vm 加速；
            //  - tmp 换一个目录，排除「loader 写不出去」。
            "probe-echo" to (
                listOf(lib, "-r", rootfs, "/bin/sh", "-c", "echo hi") to mapOf()
                ),
            // 不带 -r 直接 exec 一个系统二进制：如果这条也死，说明死点在
            // proot 的「启动子进程」本身（ptrace / personality / loader），
            // 与 rootfs 内容无关。
            "probe-noroot" to (
                listOf(lib, "/system/bin/echo", "hi") to mapOf()
                ),
            "probe-foreign" to (
                listOf(lib, "-r", rootfs, "/bin/sh", "-c", "echo hi")
                    to mapOf("PROOT_FORCE_FOREIGN_BINARY" to "1")
                ),
            "probe-kompat" to (
                listOf(lib, "-r", rootfs, "/bin/sh", "-c", "echo hi")
                    to mapOf("PROOT_FORCE_KOMPAT" to "1")
                ),
            "probe-verbose" to (
                listOf(
                    lib, "-v", "9", "-r", rootfs, "-b", "/proc", "-b", "/dev", "-b", "/sys",
                    "/bin/cat", "/etc/alpine-release"
                ) to mapOf()
                ),
        )
        cases.forEach { (name, pair) ->
            val argv = pair.first
            val extra = pair.second
            Thread {
                val started = System.currentTimeMillis()
                try {
                    val builder = ProcessBuilder(argv)
                    builder.environment().clear()
                    builder.environment()["PATH"] = "/system/bin:/system/xbin"
                    builder.environment()["HOME"] = filesDir.absolutePath
                    builder.environment()["PROOT_TMP_DIR"] = tmp
                    builder.environment()["PROOT_NO_SECCOMP"] = "1"
                    builder.environment()["LD_LIBRARY_PATH"] = libs
                    // loader 要被 exec，必须留在 nativeLibraryDir（数据目录里的
                    // 文件在 Android 10+ 不能 exec，报的是 Permission denied）。
                    builder.environment()["PROOT_LOADER"] =
                        File(applicationInfo.nativeLibraryDir, "libproot-loader.so").absolutePath
                    extra.forEach { (key, value) -> builder.environment()[key] = value }
                    val process = builder.start()
                    val out = process.inputStream.bufferedReader().readText().trim()
                    val err = process.errorStream.bufferedReader().readText().trim()
                    val code = process.waitFor()
                    val ms = System.currentTimeMillis() - started
                    android.util.Log.i(
                        tag,
                        "$name exit=$code ms=$ms out=[${out.take(200)}] err=[${err.take(300)}]"
                    )
                } catch (error: Exception) {
                    android.util.Log.i(tag, "$name threw: $error")
                }
            }.start()
        }
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        if (intent?.getStringExtra("selftest") != null) {
            runSelfTest()
        }

        EventChannel(flutterEngine.dartExecutor.binaryMessenger, EVENTS)
            .setStreamHandler(object : EventChannel.StreamHandler {
                override fun onListen(arguments: Any?, sink: EventChannel.EventSink?) {
                    events = sink
                    // 把订阅建立之前攒下的事件补发出去，顺序不变。
                    flushPending()
                }

                override fun onCancel(arguments: Any?) {
                    events = null
                }
            })

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL)
            .setMethodCallHandler { call, result -> handle(call, result) }
    }

    private fun handle(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            // proot 以 libproot.so 的身份随 APK 安装，唯一的可执行位置就是
            // nativeLibraryDir —— Android 10 起应用数据目录里的文件不能 exec。
            "paths" -> result.success(
                mapOf(
                    "nativeLibraryDir" to applicationInfo.nativeLibraryDir,
                    "filesDir" to filesDir.absolutePath,
                    "cacheDir" to cacheDir.absolutePath,
                    "abi" to android.os.Build.SUPPORTED_ABIS.firstOrNull().orEmpty(),
                )
            )
            "start" -> startRun(call, result)
            "stop" -> {
                val tag = call.argument<String>("tag") ?: ""
                val process = runs.remove(tag)
                process?.destroy()
                result.success(process != null)
            }
            "running" -> result.success(runs.keys.toList())
            // 进程没了但 UI 还开着时，把状态如实说出来，比悄悄返回空更好。
            "killAll" -> {
                runs.values.forEach { it.destroy() }
                runs.clear()
                result.success(true)
            }
            else -> result.notImplemented()
        }
    }

    private fun startRun(call: MethodCall, result: MethodChannel.Result) {
        val tag = call.argument<String>("tag") ?: return result.error("no-tag", "要有 tag", null)
        val argv = call.argument<List<String>>("argv")
        if (argv.isNullOrEmpty()) {
            return result.error("no-argv", "要有命令", null)
        }
        val cwdPath = call.argument<String>("cwd")
        val extraEnv = call.argument<Map<String, String>>("env").orEmpty()
        try {
            val builder = ProcessBuilder(argv)
            if (cwdPath != null) {
                val cwd = File(cwdPath)
                cwd.mkdirs()
                builder.directory(cwd)
            }
            // 不继承环境：手机上的 ANDROID_*、LD_PRELOAD 漏进 Alpine 会让
            // 动态链接器去加载安卓的 libc，症状是莫名其妙的 segfault。
            builder.environment().clear()
            builder.environment().putAll(
                mapOf("PATH" to "/system/bin:/system/xbin", "HOME" to filesDir.absolutePath)
            )
            // proot 自己要一个可写的临时目录（它在那里放下译好的代码与 unix socket）。
            // 默认走 $TMPDIR，而环境已清空 → `proot error: can't create temporary
            // file: Permission denied`，随后连带报 execve 找不到解释器，看起来像 rootfs 坏了。
            // 调用方可以通过 env 覆盖，但绝不能不给。
            builder.environment()["PROOT_TMP_DIR"] = File(filesDir, "tmp").absolutePath
            File(filesDir, "tmp").mkdirs()
            // proot 的 seccomp 加速在 untrusted_app 的 seccomp 过滤器下会被
            // 直接 SIGSYS 杀掉（退出码 159 = 128+31），stderr 一个字都没有。
            // 关掉加速只损失速度，功能不受影响。
            builder.environment()["PROOT_NO_SECCOMP"] = "1"
            // Termux 版 proot 是动态链接的（DT_NEEDED 里写的是 libtalloc.so.2），
            // 它是 ── 在应用里真正能跑的那个。详见 prepareLibDir()。
            builder.environment()["LD_LIBRARY_PATH"] = prepareLibDir()
            // loader 必须从 nativeLibraryDir 执行：Android 10 起数据目录里的
            // 文件不可 exec，指过去只会得到 `execve(...): Permission denied`。
            builder.environment()["PROOT_LOADER"] =
                File(applicationInfo.nativeLibraryDir, "libproot-loader.so").absolutePath
            extraEnv.forEach { (key, value) -> builder.environment()[key] = value }
            builder.redirectErrorStream(false)
            val process = builder.start()
            runs[tag] = process
            val outPump = pump(tag, "stdout", process.inputStream)
            val errPump = pump(tag, "stderr", process.errorStream)
            Thread {
                val code = try {
                    process.waitFor()
                } catch (interrupted: InterruptedException) {
                    -1
                }
                // 先等两个读线程把管道读干净再发 exit。
                // 不等的话，`node --version && dsh --version` 这种两行输出会
                // 丢最后一行 —— waitFor 和 readLine 是两条独立线程，谁先到不确定，
                // 而调用方一看到 exit 就不再收集了。
                outPump.join(2000)
                errPump.join(2000)
                runs.remove(tag)
                emit(mapOf("tag" to tag, "kind" to "exit", "code" to code))
            }.start()
            result.success(true)
        } catch (error: Exception) {
            result.error("start-failed", error.message ?: error.toString(), null)
        }
    }

    private fun pump(tag: String, kind: String, stream: java.io.InputStream): Thread {
        val thread = Thread {
            try {
                BufferedReader(InputStreamReader(stream)).use { reader ->
                    while (true) {
                        val line = reader.readLine() ?: break
                        emit(mapOf("tag" to tag, "kind" to kind, "line" to line))
                    }
                }
            } catch (_: Exception) {
                // 进程被杀时 readLine 会抛，这是正常路径。
            }
        }
        thread.start()
        return thread
    }

    private fun emit(event: Map<String, Any>) {
        main.post {
            val sink = events
            if (sink != null) {
                sink.success(event)
                return@post
            }
            // 攒到上限就丢最旧的一条，并且记住是哪个 tag 的输出被丢了。
            // 补发时如果只是少了几行，调用方分不清「还没输出」和「输出被丢」；
            // 一条明确的说明让界面能讲清楚。
            if (pending.size >= MAX_PENDING_EVENTS) {
                val evicted = pending.poll()
                val evictedTag = evicted?.get("tag") as? String
                if (!evictedTag.isNullOrEmpty()) droppedTags.add(evictedTag)
            }
            pending.add(event)
        }
    }

    /// 把攒下的事件补发出去，并顺带说明是否丢过。
    ///
    /// 丢弃标记按 tag 发：Dart 侧每个 `_runToEnd` 只认自己 tag 的帧，一条
    /// 没有 tag 的说明谁也收不到。
    private fun flushPending() {
        for (tag in droppedTags) {
            if (tag.isEmpty()) continue
            events?.success(
                mapOf(
                    "tag" to tag,
                    "kind" to "dropped",
                    "line" to "后台期间丢掉了部分输出（只保留最近 $MAX_PENDING_EVENTS 行）",
                )
            )
        }
        droppedTags.clear()
        while (true) {
            val event = pending.poll() ?: break
            events?.success(event)
        }
    }

    override fun onDestroy() {
        runs.values.forEach { it.destroy() }
        runs.clear()
        super.onDestroy()
    }

    private companion object {
        const val CHANNEL = "cn.pocketharness/native"
        const val EVENTS = "cn.pocketharness/native/events"

        /// 断订阅期间最多攒这么多行。`npm install -g` 一条命令会打上万行，
        /// 而它能跑二十分钟 —— 不留上限就是二十多分钟的纯内存增长。
        const val MAX_PENDING_EVENTS = 2000
    }
}
