import 'package:dsh_link/dsh_link.dart';
import 'package:material_ui/material_ui.dart';

import '../dsh/host_link.dart';
import '../dsh/session_groups.dart';
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

  /// The ticket this page is dialling with.
  ///
  /// Seeded from the one that was scanned, then replaced by whatever the Host
  /// says is current once a link is up: the scanned copy can name a LAN address
  /// that DHCP has since handed to someone else, or predate a relay being set up
  /// at all. Keeping the refreshed one here means a retry in this page does not
  /// walk back into the stale address.
  PairingTicket? _ticket;

  /// The directory the newest session lives in, offered as the default for the
  /// next one. People work in the same project for a stretch, so retyping the
  /// path each time is the common annoyance this removes.
  String? _lastCwd;

  /// The last list the Host returned, so the search page can name its hits.
  List<SessionSummary> _loaded = const [];

  /// Projects the person folded shut. Kept by directory rather than by index so
  /// a refresh that reorders the tree does not open what was just closed.
  final Set<String> _collapsed = <String>{};

  /// Whether the default folding has happened for this page.
  ///
  /// The desktop sidebar opens on the project you are in and keeps the rest
  /// small; with 22 projects and 900-odd sessions an all-expanded list is the
  /// same wall of titles the grouping was meant to remove, only indented.
  bool _seeded = false;

  @override
  void initState() {
    super.initState();
    _sessions = _load();
  }

  Future<List<SessionSummary>> _load() async {
    // 每次重试都会新建一条链路，旧的那条必须在这里关掉：它可能还在握着
    // 电脑上的连接名额，而这个页面是唯一持有它的人。反复点「刷新」而不关，
    // 攒够八条之后电脑就开始拒新连接，表现成「越刷越连不上」。
    final previous = _link;
    setState(() {
      _link = null;
      _error = null;
    });
    if (previous != null) unawaitedClose(previous);
    try {
      final identity = await widget.store.identity();
      final link = await HostLink.connect(_ticket ?? widget.ticket, identity);
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
      await _adoptRefreshedTicket(link);
      // `session/list` carries every record the Host ever made, seed rows and
      // abandoned ones included: a folder the desktop shows one session for
      // came back as nine here. Show what the sidebar shows.
      final sessions = sessionsWorthShowing(await link.sessions());
      _seedCollapsed(sessions);
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

  /// Replaces the stored ticket with the Host's current one.
  ///
  /// This is what makes "scan once, then work from anywhere" true: the saved
  /// ticket names the addresses that were true at scan time, and the Host is the
  /// only party that knows the live ones. The refresh is best effort — an older
  /// Host answers with an error and the phone simply keeps what it has.
  Future<void> _adoptRefreshedTicket(HostLink link) async {
    final fresh = await link.refreshTicket();
    if (fresh == null) return;
    _ticket = fresh;
    // The store keys entries by Host id, so this replaces the scanned copy in
    // place rather than adding a second row for the same computer.
    try {
      await widget.store.saveHost(fresh);
    } on Object {
      // A phone that cannot write preferences still works for this run.
    }
  }

  /// Folds every project the first time a list arrives.
  ///
  /// The desktop sidebar shows projects first and sessions under the one you
  /// open. With 22 projects and 900-odd sessions an all-expanded list is the
  /// same wall of titles the grouping was meant to remove, only indented, so
  /// the page opens as a compact project index. This runs once per page, so a
  /// later refresh does not fold what the person just opened.
  void _seedCollapsed(List<SessionSummary> sessions) {
    if (_seeded) return;
    _seeded = true;
    _collapsed.addAll(projectsFoldedOnOpen(groupSessionsByProject(sessions)));
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
      presets: link.presets,
      initialCwd: _lastCwd,
    );
    if (choice == null || !mounted) return;
    try {
      final id = await link.createSession(cwd: choice.cwd, agentPreset: choice.agentPreset);
      if (!mounted) return;
      await _open(id, choice.cwd == null ? '新建会话' : basename(choice.cwd!), cwd: choice.cwd);
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

  void _toggle(String key) {
    setState(() {
      if (!_collapsed.remove(key)) _collapsed.add(key);
    });
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
          final groups = groupSessionsByProject(sessions);
          return RefreshIndicator(
            onRefresh: _refresh,
            child: ListView.builder(
              itemCount: groups.length,
              itemBuilder: (context, index) => _ProjectSection(
                group: groups[index],
                collapsed: _collapsed.contains(groups[index].key),
                onToggle: () => _toggle(groups[index].key),
                onOpen: (session) =>
                    _open(session.sessionId, session.title, cwd: session.cwd),
                onRename: _rename,
              ),
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

/// One project header with its sessions underneath.
///
/// The desktop groups sessions by project; the phone's flat list did not, so
/// four sessions from four folders looked like one undifferentiated wall of
/// "未命名会话". A section keeps the folder visible once, hangs its sessions off
/// a spine, and drops the path onto the header line, which is what the desktop
/// sidebar looks like and what makes a long list scannable by eye.
class _ProjectSection extends StatelessWidget {
  const _ProjectSection({
    required this.group,
    required this.collapsed,
    required this.onToggle,
    required this.onOpen,
    required this.onRename,
  });

  final SessionGroup group;
  final bool collapsed;
  final VoidCallback onToggle;
  final void Function(SessionSummary session) onOpen;
  final void Function(SessionSummary session) onRename;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final palette = theme.colorScheme;
    final open = !collapsed;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        InkWell(
          onTap: onToggle,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(8, 10, 12, 10),
            child: Row(
              children: [
                Icon(
                  open ? Icons.keyboard_arrow_down : Icons.keyboard_arrow_right,
                  size: 20,
                  color: palette.onSurfaceVariant,
                ),
                const SizedBox(width: 2),
                Icon(
                  group.key.isEmpty ? Icons.inbox_outlined : Icons.folder_outlined,
                  size: 17,
                  color: palette.onSurfaceVariant,
                ),
                const SizedBox(width: 6),
                Flexible(
                  child: Text(
                    group.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                // The parent path rides on the header instead of taking a row of
                // its own: two projects can share a folder name ("src", "app"),
                // and the tail of the path is enough to tell them apart.
                if (group.key.isNotEmpty) ...[
                  const SizedBox(width: 6),
                  Flexible(
                    child: Text(
                      _parentPath(group.key),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: palette.onSurfaceVariant,
                      ),
                    ),
                  ),
                ],
                const SizedBox(width: 6),
                if (group.running > 0)
                  Padding(
                    padding: const EdgeInsets.only(right: 4),
                    child: SizedBox(
                      width: 12,
                      height: 12,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: palette.primary,
                      ),
                    ),
                  ),
                Text(
                  '${group.sessions.length}',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: palette.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ),
        // A folded project still has to say something about what is inside it,
        // otherwise the index is 22 bare folder names. The newest title and its
        // age do that in one line.
        if (!open && group.sessions.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(left: 36, right: 16, bottom: 9),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    group.sessions.first.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: palette.onSurfaceVariant,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  _relative(group.sessions.first.updatedAt),
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: palette.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        // The spine is what turns a run of rows into a tree: without it every
        // session reads as a sibling of the project instead of a child.
        if (open)
          Padding(
            padding: const EdgeInsets.only(left: 18),
            child: Container(
              decoration: BoxDecoration(
                border: Border(
                  left: BorderSide(
                    color: palette.outlineVariant.withValues(alpha: 0.6),
                    width: 1,
                  ),
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final session in group.sessions)
                    _SessionRow(
                      session: session,
                      onTap: () => onOpen(session),
                      onLongPress: () => onRename(session),
                    ),
                ],
              ),
            ),
          ),
        Divider(height: 1, color: palette.outlineVariant.withValues(alpha: 0.4)),
      ],
    );
  }
}

/// Everything above the last segment of a path, for the header's dim suffix.
String _parentPath(String path) {
  final trimmed = path.endsWith('\\') || path.endsWith('/')
      ? path.substring(0, path.length - 1)
      : path;
  final cut = trimmed.lastIndexOf(RegExp(r'[\\/]'));
  if (cut <= 0) return trimmed;
  final head = trimmed.substring(0, cut);
  // "C:\a" would otherwise read as "C:", which says less than the folder name
  // already on screen.
  if (head.length <= 2 && head.endsWith(':')) return trimmed;
  return head;
}

/// One session inside a project.
class _SessionRow extends StatelessWidget {
  const _SessionRow({
    required this.session,
    required this.onTap,
    required this.onLongPress,
  });

  final SessionSummary session;
  final VoidCallback onTap;
  final VoidCallback onLongPress;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final palette = theme.colorScheme;
    final unknownTime = session.updatedAt.millisecondsSinceEpoch == 0;
    return InkWell(
      onTap: onTap,
      onLongPress: onLongPress,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 9, 16, 9),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 3),
              child: session.running
                  ? const SizedBox(
                      width: 12,
                      height: 12,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : Icon(
                      Icons.chat_bubble_outline,
                      size: 14,
                      color: palette.onSurfaceVariant,
                    ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                session.title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodyMedium,
              ),
            ),
            const SizedBox(width: 8),
            // The folder sits on the header now, so the row only has to say when,
            // and a right-aligned timestamp keeps the titles on one edge.
            Text(
              unknownTime ? '时间未知' : _relative(session.updatedAt),
              style: theme.textTheme.labelSmall?.copyWith(
                color: palette.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }
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
