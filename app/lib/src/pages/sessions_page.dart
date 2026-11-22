import 'package:dsh_link/dsh_link.dart';
import 'package:material_ui/material_ui.dart';

import '../dsh/host_link.dart';
import '../storage/host_store.dart';
import 'chat_page.dart';
import 'new_session_sheet.dart';
import 'search_page.dart';
import 'settings_page.dart';

/// Connects to one Host and lists its sessions.
///
/// The connection lives here rather than inside the chat screen so leaving a
/// session and coming back does not pay for a new Noise handshake.
class SessionsPage extends StatefulWidget {
  const SessionsPage({super.key, required this.store, required this.ticket});

  final HostStore store;
  final PairingTicket ticket;

  @override
  State<SessionsPage> createState() => _SessionsPageState();
}

class _SessionsPageState extends State<SessionsPage> {
  Future<List<SessionSummary>>? _sessions;
  HostLink? _link;
  String? _error;

  /// The directory the newest session lives in, offered as the default for the
  /// next one. People work in the same project for a stretch, so retyping the
  /// path each time is the common annoyance this removes.
  String? _lastCwd;

  /// The last list the Host returned, so the search page can name its hits.
  List<SessionSummary> _loaded = const [];

  @override
  void initState() {
    super.initState();
    _sessions = _load();
  }

  Future<List<SessionSummary>> _load() async {
    setState(() {
      _error = null;
    });
    try {
      final identity = await widget.store.identity();
      final link = await HostLink.connect(widget.ticket, identity);
      if (!mounted) {
        await link.close();
        return const [];
      }
      // The AppBar's actions watch [_link], and they are built by the Scaffold
      // rather than by the FutureBuilder below, so this assignment has to be a
      // rebuild of its own; otherwise the buttons stay disabled until an
      // unrelated setState happens.
      setState(() {
        _link = link;
      });
      final sessions = await link.sessions();
      // Kept for the search page, which labels a hit with the title a person
      // knows rather than a session id.
      _loaded = sessions;
      for (final session in sessions) {
        if (session.cwd != null && session.cwd!.isNotEmpty) {
          _lastCwd = session.cwd;
          break;
        }
      }
      return sessions;
    } on Object catch (error) {
      if (mounted) setState(() => _error = _describe(error));
      rethrow;
    }
  }

  /// Turns a transport failure into something a person can act on.
  String _describe(Object error) {
    if (error is LinkRefusedError) {
      return switch (error.reason) {
        'not-paired' => '这台电脑还不认识这部手机。请在电脑日志里取最新的配对码重新扫描。',
        'pairing-expired' => '配对码已过期。请打开电脑上的 Pocket Harness 日志，扫描当前的配对码。',
        'bad-proof' => '配对码不匹配。请扫描电脑上当前的配对码。',
        _ => '电脑拒绝了这次连接（${error.reason}）。',
      };
    }
    if (error is RpcException) return '${error.code}: ${error.message}';
    return '连不上这台电脑。请确认手机和电脑在同一网络，并且 Harness 正在运行。\n\n$error';
  }

  Future<void> _refresh() async {
    // setState's callback must be synchronous: handing it the future itself
    // trips the framework's own assertion and leaves the list stale.
    final pending = _load();
    setState(() {
      _sessions = pending;
    });
    await pending;
  }

  Future<void> _create() async {
    final link = _link;
    if (link == null) return;
    final messenger = ScaffoldMessenger.of(context);
    // The roster is fetched once per sheet; a Host that cannot answer falls back
    // to "use the computer's default" rather than blocking session creation.
    final choice = await showNewSessionSheet(
      context,
      presets: link.presets(),
      initialCwd: _lastCwd,
    );
    if (choice == null || !mounted) return;
    try {
      final id = await link.createSession(cwd: choice.cwd, agentPreset: choice.agentPreset);
      if (!mounted) return;
      await _open(id, choice.cwd == null ? '新建会话' : _basename(choice.cwd!), cwd: choice.cwd);
      _refresh();
    } on Object catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(_describe(error))));
    }
  }

  Future<void> _open(String sessionId, String title, {String? cwd}) async {
    final link = _link;
    if (link == null) return;
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) =>
            ChatPage(link: link, sessionId: sessionId, title: title, cwd: cwd),
      ),
    );
    // The session list carries activity order and titles, both of which move
    // while a conversation runs.
    if (mounted) _refresh();
  }

  Future<void> _settings() async {
    final link = _link;
    if (link == null) return;
    await Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => SettingsPage(link: link)),
    );
    // A changed default model only shows up in the next new session, but the
    // list also carries titles that the desktop may have renamed meanwhile.
    if (mounted) _refresh();
  }

  Future<void> _search() async {
    final link = _link;
    if (link == null) return;
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => SearchPage(
          sessions: _loaded,
          contentSearch: link.search,
          onOpen: (sessionId, title) => _openFromSearch(context, sessionId, title),
        ),
      ),
    );
  }

  /// Opens a hit from the search page, which stays below it in the stack.
  Future<void> _openFromSearch(BuildContext context, String sessionId, String title) async {
    final link = _link;
    if (link == null) return;
    await Navigator.of(context).push(
      MaterialPageRoute(
          builder: (_) =>
              ChatPage(link: link, sessionId: sessionId, title: title),
      ),
    );
    if (mounted) _refresh();
  }

  Future<void> _rename(SessionSummary session) async {
    final link = _link;
    if (link == null) return;
    final messenger = ScaffoldMessenger.of(context);
    final title = await showDialog<String>(
      context: context,
      builder: (_) => _RenameDialog(initial: session.title),
    );
    final trimmed = title?.trim() ?? '';
    if (trimmed.isEmpty || trimmed == session.title || !mounted) return;
    try {
      await link.rename(session.sessionId, trimmed);
      if (mounted) await _refresh();
    } on Object catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(_describe(error))));
    }
  }

  @override
  void dispose() {
    final link = _link;
    if (link != null) unawaitedClose(link);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final link = _link;
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(widget.ticket.hostName, maxLines: 1, overflow: TextOverflow.ellipsis),
            if (link != null)
              // Which route is in use matters to the person holding the phone: a
              // relay is slower and depends on a third party being up, so it is
              // shown rather than hidden behind a generic "connected".
              Text(
                link.route == LinkRoute.lan ? '局域网直连' : '经中继',
                style: Theme.of(context).textTheme.labelSmall,
              ),
          ],
        ),
        actions: [
          IconButton(
            onPressed: _link == null ? null : _create,
            icon: const Icon(Icons.add_comment_outlined),
            tooltip: '新建会话',
          ),
          IconButton(
            onPressed: _link == null ? null : _search,
            icon: const Icon(Icons.search),
            tooltip: '搜索会话内容',
          ),
          IconButton(
            onPressed: _link == null ? null : _settings,
            icon: const Icon(Icons.tune),
            tooltip: '电脑设置',
          ),
          IconButton(
            onPressed: _refresh,
            icon: const Icon(Icons.refresh),
            tooltip: '刷新',
          ),
        ],
      ),
      body: FutureBuilder<List<SessionSummary>>(
        future: _sessions,
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return _ConnectionProblem(
              message: _error ?? _describe(snapshot.error!),
              onRetry: _refresh,
            );
          }
          final sessions = snapshot.data ?? const <SessionSummary>[];
          if (sessions.isEmpty) {
            return _NoSessions(onCreate: _link == null ? null : _create);
          }
          return RefreshIndicator(
            onRefresh: _refresh,
            child: ListView.separated(
              itemCount: sessions.length,
              separatorBuilder: (_, _) => const Divider(height: 1),
              itemBuilder: (context, index) {
                final session = sessions[index];
                return ListTile(
                  leading: session.running
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.chat_bubble_outline),
                  title: Text(session.title, maxLines: 1, overflow: TextOverflow.ellipsis),
                  subtitle: Text(
                    session.cwd ?? _relative(session.updatedAt),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  onTap: () => _open(session.sessionId, session.title, cwd: session.cwd),
                  onLongPress: () => _rename(session),
                );
              },
            ),
          );
        },
      ),
    );
  }
}

/// Fire-and-forget close, kept out of widget code for readability.
void unawaitedClose(HostLink link) {
  link.close().catchError((Object _) {});
}

String _relative(DateTime time) {
  if (time.millisecondsSinceEpoch == 0) return '时间未知';
  final delta = DateTime.now().difference(time);
  if (delta.inMinutes < 1) return '刚刚';
  if (delta.inHours < 1) return '${delta.inMinutes} 分钟前';
  if (delta.inDays < 1) return '${delta.inHours} 小时前';
  if (delta.inDays < 30) return '${delta.inDays} 天前';
  return '${time.year}-${_two(time.month)}-${_two(time.day)}';
}

String _two(int value) => value.toString().padLeft(2, '0');

/// The last path segment, for a chat title that fits on one line.
String _basename(String path) {
  final trimmed = path.endsWith(r'\') || path.endsWith('/') ? path.substring(0, path.length - 1) : path;
  final cut = trimmed.lastIndexOf(RegExp(r'[\\/]'));
  final name = cut == -1 ? trimmed : trimmed.substring(cut + 1);
  return name.isEmpty ? trimmed : name;
}

class _RenameDialog extends StatefulWidget {
  const _RenameDialog({required this.initial});

  final String initial;

  @override
  State<_RenameDialog> createState() => _RenameDialogState();
}

class _RenameDialogState extends State<_RenameDialog> {
  late final TextEditingController _controller = TextEditingController(text: widget.initial);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('重命名会话'),
      content: TextField(
        controller: _controller,
        autofocus: true,
        maxLength: 120,
        decoration: const InputDecoration(
          labelText: '标题',
          hintText: '留空则取消',
        ),
        onSubmitted: (value) => Navigator.of(context).pop(value),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('取消')),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(_controller.text),
          child: const Text('保存'),
        ),
      ],
    );
  }
}

class _ConnectionProblem extends StatelessWidget {
  const _ConnectionProblem({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.link_off, size: 48, color: theme.colorScheme.error),
            const SizedBox(height: 16),
            Text('连接失败', style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            Text(message, textAlign: TextAlign.center, style: theme.textTheme.bodyMedium),
            const SizedBox(height: 24),
            FilledButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh),
              label: const Text('重试'),
            ),
          ],
        ),
      ),
    );
  }
}

class _NoSessions extends StatelessWidget {
  const _NoSessions({required this.onCreate});

  final VoidCallback? onCreate;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.forum_outlined, size: 48, color: theme.colorScheme.primary),
            const SizedBox(height: 16),
            Text('还没有会话', style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            Text(
              '在这里新建一个，或先在电脑上打开某个会话，再下拉刷新。',
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium,
            ),
            const SizedBox(height: 24),
            FilledButton.icon(
              onPressed: onCreate,
              icon: const Icon(Icons.add_comment_outlined),
              label: const Text('新建会话'),
            ),
          ],
        ),
      ),
    );
  }
}
