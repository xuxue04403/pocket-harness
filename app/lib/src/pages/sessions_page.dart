import 'package:dsh_link/dsh_link.dart';
import 'package:material_ui/material_ui.dart';

import '../dsh/host_link.dart';
import '../storage/host_store.dart';
import 'chat_page.dart';

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
      final link = await HostLink.connect(widget.ticket, widget.store.identity());
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
      return await link.sessions();
    } on Object catch (error) {
      if (mounted) setState(() => _error = _describe(error));
      rethrow;
    }
  }

  /// Turns a transport failure into something a person can act on.
  String _describe(Object error) {
    if (error is LinkRefusedError) {
      return switch (error.reason) {
        'not-paired' => 'This computer does not recognise this phone yet. Scan a fresh pairing code from its log.',
        'pairing-expired' => 'The pairing code expired. Open the Pocket Harness log on the computer and scan the current code.',
        'bad-proof' => 'The pairing code did not match. Scan the current code from the computer.',
        _ => 'The computer refused the connection (${error.reason}).',
      };
    }
    if (error is RpcException) return '${error.code}: ${error.message}';
    return 'Could not reach the computer. Check that it is on the same network and Harness is running.\n\n$error';
  }

  Future<void> _refresh() async {
    setState(() => _sessions = _load());
  }

  Future<void> _create() async {
    final link = _link;
    if (link == null) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      final id = await link.createSession();
      if (!mounted) return;
      await _open(id, 'New session');
      _refresh();
    } on Object catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(_describe(error))));
    }
  }

  Future<void> _open(String sessionId, String title) async {
    final link = _link;
    if (link == null) return;
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => ChatPage(link: link, sessionId: sessionId, title: title),
      ),
    );
    // The session list carries activity order and titles, both of which move
    // while a conversation runs.
    if (mounted) _refresh();
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
                link.route == LinkRoute.lan ? 'Local network' : 'Relayed',
                style: Theme.of(context).textTheme.labelSmall,
              ),
          ],
        ),
        actions: [
          IconButton(
            onPressed: _link == null ? null : _create,
            icon: const Icon(Icons.add_comment_outlined),
            tooltip: 'New session',
          ),
          IconButton(
            onPressed: _refresh,
            icon: const Icon(Icons.refresh),
            tooltip: 'Refresh',
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
                  onTap: () => _open(session.sessionId, session.title),
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
  if (time.millisecondsSinceEpoch == 0) return 'unknown time';
  final delta = DateTime.now().difference(time);
  if (delta.inMinutes < 1) return 'just now';
  if (delta.inHours < 1) return '${delta.inMinutes} min ago';
  if (delta.inDays < 1) return '${delta.inHours} h ago';
  if (delta.inDays < 30) return '${delta.inDays} d ago';
  return '${time.year}-${_two(time.month)}-${_two(time.day)}';
}

String _two(int value) => value.toString().padLeft(2, '0');

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
            Text('Not connected', style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            Text(message, textAlign: TextAlign.center, style: theme.textTheme.bodyMedium),
            const SizedBox(height: 24),
            FilledButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh),
              label: const Text('Try again'),
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
            Text('No sessions yet', style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            Text(
              'Start one here, or open a session on the computer and pull to refresh.',
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium,
            ),
            const SizedBox(height: 24),
            FilledButton.icon(
              onPressed: onCreate,
              icon: const Icon(Icons.add_comment_outlined),
              label: const Text('New session'),
            ),
          ],
        ),
      ),
    );
  }
}
