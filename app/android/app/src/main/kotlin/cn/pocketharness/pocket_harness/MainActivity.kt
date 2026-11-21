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

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        EventChannel(flutterEngine.dartExecutor.binaryMessenger, EVENTS)
            .setStreamHandler(object : EventChannel.StreamHandler {
                override fun onListen(arguments: Any?, sink: EventChannel.EventSink?) {
                    events = sink
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
            builder.redirectErrorStream(false)
            val process = builder.start()
            runs[tag] = process
            pump(tag, "stdout", process.inputStream)
            pump(tag, "stderr", process.errorStream)
            Thread {
                val code = try {
                    process.waitFor()
                } catch (interrupted: InterruptedException) {
                    -1
                }
                runs.remove(tag)
                emit(mapOf("tag" to tag, "kind" to "exit", "code" to code))
            }.start()
            result.success(true)
        } catch (error: Exception) {
            result.error("start-failed", error.message ?: error.toString(), null)
        }
    }

    private fun pump(tag: String, kind: String, stream: java.io.InputStream) {
        Thread {
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
        }.start()
    }

    private fun emit(event: Map<String, Any>) {
        main.post { events?.success(event) }
    }

    override fun onDestroy() {
        runs.values.forEach { it.destroy() }
        runs.clear()
        super.onDestroy()
    }

    private companion object {
        const val CHANNEL = "cn.pocketharness/native"
        const val EVENTS = "cn.pocketharness/native/events"
    }
}
