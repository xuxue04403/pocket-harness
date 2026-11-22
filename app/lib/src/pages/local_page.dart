import 'dart:async';

import 'package:material_ui/material_ui.dart';

import '../local/local_commands.dart';
import '../local/local_host.dart';
import '../local/local_runner.dart';
import 'local_web_page.dart';

/// 在手机上本机跑 dsh：装一次、之后每次点一下启动。
///
/// 这一页的难点不在界面，而在如实。装一套 dsh 要下 1.6 GB、跑十来分钟，
/// 中间任何一步失败都必须说清楚是哪一步、失败在哪一行输出上，
/// 否则用户只会看到一个一直转的圈。
class LocalPage extends StatefulWidget {
  const LocalPage({super.key, this.runner});

  final LocalRunner? runner;

  @override
  State<LocalPage> createState() => _LocalPageState();
}

class _LocalPageState extends State<LocalPage> {
  late final LocalRunner _runner = widget.runner ?? LocalRunner();

  ProvisionProgress? _progress;
  String? _error;
  String? _url;
  bool _busy = false;
  bool _installed = false;

  @override
  void initState() {
    super.initState();
    unawaited(_check());
  }

  Future<void> _check() async {
    if (!LocalHost.supported) {
      setState(() => _error = '本机运行 dsh 只在 Android 上可用。');
      return;
    }
    try {
      final String output = await _runner.probe();
      final bool ready =
          output.contains('v2') && output.contains(kDshVersion);
      if (!mounted) return;
      setState(() {
        _installed = ready;
        // 探活的原始输出留在调试日志里：「装了却显示没装」时，这一行是
        // 唯一能看出 proot 到底说了什么的地方。
        debugPrint('本机 dsh 探活：${output.trim().replaceAll('\n', ' / ')}');
      });
    } on Object catch (error) {
      // 还没装过时这条命令必然失败，这不是错误，只说明要从头装。
      if (!mounted) return;
      setState(() => _installed = false);
      debugPrint('本机 dsh 探活失败：$error');
    }
  }

  Future<void> _install() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await _runner.provision(onProgress: (ProvisionProgress next) {
        if (!mounted) return;
        setState(() => _progress = next);
      });
      if (!mounted) return;
      setState(() => _installed = true);
    } on Object catch (error) {
      if (!mounted) return;
      setState(() => _error = '$error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _start() async {
    setState(() {
      _busy = true;
      _error = null;
      _progress = null;
    });
    try {
      final String url = await _runner.start();
      if (!mounted) return;
      setState(() => _url = url);
    } on Object catch (error) {
      if (!mounted) return;
      setState(() => _error = '$error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _stop() async {
    setState(() => _busy = true);
    try {
      await _runner.stop();
      if (!mounted) return;
      setState(() => _url = null);
    } on Object catch (error) {
      if (!mounted) return;
      setState(() => _error = '$error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _openUi() {
    final String? url = _url;
    if (url == null) return;
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => LocalWebPage(url: url)),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('在这台手机上跑 dsh')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          _summary(context),
          const SizedBox(height: 20),
          if (_progress != null) _progressCard(context, _progress!),
          if (_error != null) _errorCard(context, _error!),
          if (_busy) const Padding(
            padding: EdgeInsets.symmetric(vertical: 12),
            child: LinearProgressIndicator(),
          ),
          const SizedBox(height: 20),
          _actions(context),
          const SizedBox(height: 28),
          _notes(context),
        ],
      ),
    );
  }

  Widget _summary(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String state;
    if (_url != null) {
      state = '正在运行';
    } else if (_installed) {
      state = '已装好，点下面的按钮启动';
    } else {
      state = '还没装';
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('DeepSeek Harness 在这台手机上', style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            Text(state),
            const SizedBox(height: 12),
            Text(
              '装一次约 2.0 GB 磁盘、下载 1.6 GB。装好之后不需要电脑，'
              '但手机性能和内存都会明显吃紧（node 常驻约 300 MB）。',
              style: theme.textTheme.bodySmall,
            ),
          ],
        ),
      ),
    );
  }

  Widget _progressCard(BuildContext context, ProvisionProgress progress) {
    final ThemeData theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  progress.failed ? Icons.error_outline : Icons.downloading,
                  size: 18,
                  color: progress.failed ? theme.colorScheme.error : null,
                ),
                const SizedBox(width: 8),
                Expanded(child: Text(progress.step.label, style: theme.textTheme.titleSmall)),
              ],
            ),
            if (progress.fraction != null) ...[
              const SizedBox(height: 10),
              LinearProgressIndicator(value: progress.fraction),
            ],
            if (progress.detail.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(
                progress.detail,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodySmall,
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _errorCard(BuildContext context, String error) {
    final ThemeData theme = Theme.of(context);
    return Card(
      color: theme.colorScheme.errorContainer,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '没成功',
              style: theme.textTheme.titleSmall?.copyWith(
                color: theme.colorScheme.onErrorContainer,
              ),
            ),
            const SizedBox(height: 8),
            SelectableText(
              error,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onErrorContainer,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _actions(BuildContext context) {
    final List<Widget> buttons = <Widget>[];
    if (!_installed) {
      buttons.add(FilledButton.icon(
        onPressed: _busy ? null : _install,
        icon: const Icon(Icons.system_update_alt),
        label: Text(_busy ? '正在安装…' : '安装 dsh（约 1.6 GB 下载）'),
      ));
    } else if (_url == null) {
      buttons.add(FilledButton.icon(
        onPressed: _busy ? null : _start,
        icon: const Icon(Icons.play_arrow),
        label: Text(_busy ? '正在启动…' : '启动 dsh'),
      ));
      buttons.add(const SizedBox(height: 8));
      buttons.add(TextButton(
        onPressed: _busy ? null : _install,
        child: const Text('重新安装'),
      ));
    } else {
      buttons.add(FilledButton.icon(
        onPressed: _openUi,
        icon: const Icon(Icons.open_in_browser),
        label: const Text('打开界面'),
      ));
      buttons.add(const SizedBox(height: 8));
      buttons.add(OutlinedButton.icon(
        onPressed: _busy ? null : _stop,
        icon: const Icon(Icons.stop),
        label: const Text('停止'),
      ));
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: buttons);
  }

  Widget _notes(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('这条路是怎么走通的', style: theme.textTheme.titleSmall),
        const SizedBox(height: 8),
        Text(
          '· proot 以 libproot.so 的身份随 APK 安装，只能从 nativeLibraryDir 执行；\n'
          '· 解压用系统自带的 tar，rootfs 是 Alpine 3.21；\n'
          '· Node 必须从 edge 源装 24.x，并同时升级 libssl3/libcrypto3；\n'
          '· dsh 以 dsh web 的形式起在 127.0.0.1，界面用 WebView 打开带 token 的地址。',
          style: theme.textTheme.bodySmall,
        ),
      ],
    );
  }
}
