import 'dart:async';
import 'dart:convert';

import 'package:material_ui/material_ui.dart';

import '../dsh/host_link.dart';

/// One conversation: opening snapshot, live events, and the composer.
///
/// DSH streams a snapshot and then one frame per durable event, so the page
/// keeps an ordered list of rows and appends as frames arrive. A rebuild is
/// requested per frame; the list is small enough that this stays cheap on a
/// phone, and it avoids a second source of truth for ordering.
class ChatPage extends StatefulWidget {
  const ChatPage({super.key, required this.link, required this.sessionId, required this.title});

  final HostLink link;
  final String sessionId;
  final String title;

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  final ScrollController _scroll = ScrollController();
  final TextEditingController _composer = TextEditingController();
  final List<TranscriptRow> _rows = [];

  StreamSubscription<Map<String, Object?>>? _follow;
  String? _error;
  bool _loading = true;
  bool _sending = false;

  /// The attempt DSH is writing right now, if any.
  ///
  /// This is the only row that is not backed by a durable event: it exists so a
  /// running turn shows text instead of an empty screen, and it is dropped as
  /// soon as DSH commits the attempt as an `assistant/message`.
  LiveDraft? _draft;

  @override
  void initState() {
    super.initState();
    _start();
  }

  void _start() {
    _follow = widget.link.follow(widget.sessionId).listen(
      _onFrame,
      onError: (Object error) {
        if (mounted) setState(() => _error = '$error');
      },
      onDone: () {
        if (mounted) setState(() => _error ??= 'The computer closed this session stream.');
      },
    );
  }

  void _onFrame(Map<String, Object?> frame) {
    final type = frame['type'];
    if (type == 'snapshot') {
      final records = frame['records'];
      final rows = buildTranscript(records is List ? records : const []);
      setState(() {
        _loading = false;
        _rows
          ..clear()
          ..addAll(rows);
        _draft = null;
      });
      _scrollToEnd();
      return;
    }
    if (type == 'event') {
      final row = buildTranscript([frame]).firstOrNull;
      final event = frame['event'];
      final eventType = event is Map<String, Object?> ? event['type'] : null;
      setState(() {
        if (row != null) {
          // A replacement surface op can re-send a sequence the page already
          // shows; drop the stale copy instead of rendering both.
          _rows.removeWhere((existing) => existing.seq == row.seq);
          _rows.add(row);
          _rows.sort((left, right) => left.seq.compareTo(right.seq));
        }
        // The durable message supersedes whatever the live draft accumulated,
        // so the two never show the same text twice.
        if (eventType == 'assistant/message' || eventType == 'turn/end') _draft = null;
      });
      _scrollToEnd();
      return;
    }
    final live = readLiveFrame(frame);
    if (live == null) return;
    setState(() {
      switch (live.kind) {
        case 'start':
          _draft = LiveDraft(attemptId: live.attemptId);
        case 'chunk':
          final draft = _draft;
          if (draft == null || draft.attemptId != live.attemptId) {
            _draft = LiveDraft(attemptId: live.attemptId)..applyChunk(live.chunk);
          } else {
            draft.applyChunk(live.chunk);
          }
        case 'end':
          if (_draft?.attemptId == live.attemptId) _draft = null;
      }
    });
    _scrollToEnd();
  }

  void _scrollToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      _scroll.animateTo(
        _scroll.position.maxScrollExtent,
        duration: const Duration(milliseconds: 200),
        curve: Curves.easeOut,
      );
    });
  }

  Future<void> _loadOlder() async {
    if (_rows.isEmpty) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      final page = await widget.link.page(widget.sessionId, beforeSeq: _rows.first.seq);
      final records = page['records'];
      final older = buildTranscript(records is List ? records : const []);
      if (!mounted || older.isEmpty) return;
      setState(() {
        _rows
          ..removeWhere((row) => older.any((entry) => entry.seq == row.seq))
          ..addAll(older)
          ..sort((left, right) => left.seq.compareTo(right.seq));
      });
    } on Object catch (error) {
      messenger.showSnackBar(SnackBar(content: Text('$error')));
    }
  }

  Future<void> _send({String mode = 'queue'}) async {
    final text = _composer.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await widget.link.prompt(widget.sessionId, text, mode: mode);
      _composer.clear();
    } on Object catch (error) {
      messenger.showSnackBar(SnackBar(content: Text('$error')));
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _cancel() async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      await widget.link.cancel(widget.sessionId);
    } on Object catch (error) {
      messenger.showSnackBar(SnackBar(content: Text('$error')));
    }
  }

  @override
  void dispose() {
    unawaited(_follow?.cancel());
    _composer.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.title, maxLines: 1, overflow: TextOverflow.ellipsis),
        actions: [
          IconButton(
            onPressed: _cancel,
            icon: const Icon(Icons.stop_circle_outlined),
            tooltip: 'Stop the turn',
          ),
        ],
      ),
      body: Column(
        children: [
          if (_error != null) _ErrorBanner(message: _error!),
          Expanded(child: _body()),
          _Composer(
            controller: _composer,
            sending: _sending,
            onSend: () => _send(),
            onSteer: () => _send(mode: 'steer'),
          ),
        ],
      ),
    );
  }

  Widget _body() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    final draft = _draft;
    final showDraft = draft != null && !draft.isEmpty;
    if (_rows.isEmpty && !showDraft) return const _EmptyTranscript();
    final count = _rows.length + (showDraft ? 1 : 0);
    return ListView.builder(
      controller: _scroll,
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      itemCount: count,
      itemBuilder: (context, index) {
        if (index >= _rows.length) {
          return _LiveTile(draft: draft!);
        }
        return _TranscriptTile(
          row: _rows[index],
          onLoadOlder: index == 0 ? _loadOlder : null,
        );
      },
    );
  }
}

/// The in-flight assistant attempt, rendered from stream chunks.
class _LiveTile extends StatelessWidget {
  const _LiveTile({required this.draft});

  final LiveDraft draft;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final reasoning = draft.reasoning.toString();
    final text = draft.text.toString();
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: _Bubble(
        alignEnd: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (reasoning.isNotEmpty) _Reasoning(text: reasoning, live: true),
            if (text.isNotEmpty) Text(text, style: theme.textTheme.bodyMedium),
            if (text.isEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    SizedBox(
                      width: 12,
                      height: 12,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: theme.colorScheme.outline,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      reasoning.isEmpty ? 'Working' : 'Thinking',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.outline,
                      ),
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _TranscriptTile extends StatelessWidget {
  const _TranscriptTile({required this.row, this.onLoadOlder});

  final TranscriptRow row;
  final VoidCallback? onLoadOlder;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final child = switch (row) {
      UserRow(:final text, :final injected) => _Bubble(
        alignEnd: true,
        muted: injected,
        child: Text(text, style: theme.textTheme.bodyMedium),
      ),
      AssistantRow(:final text, :final reasoning) => _Bubble(
        alignEnd: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (reasoning != null) _Reasoning(text: reasoning),
            SelectableText(text, style: theme.textTheme.bodyMedium),
          ],
        ),
      ),
      ToolCallRow(:final name, :final arguments) => _ToolCard(
        title: name,
        body: _prettyJson(arguments),
        tone: theme.colorScheme.secondaryContainer,
      ),
      ToolResultRow(:final text, :final isError) => _ToolCard(
        title: isError ? 'Tool failed' : 'Tool result',
        body: text,
        tone: isError ? theme.colorScheme.errorContainer : theme.colorScheme.surfaceContainerHighest,
      ),
      NoticeRow(:final text, :final isError) => Row(
        children: [
          Icon(
            isError ? Icons.error_outline : Icons.info_outline,
            size: 16,
            color: isError ? theme.colorScheme.error : theme.colorScheme.outline,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              text,
              style: theme.textTheme.bodySmall?.copyWith(
                color: isError ? theme.colorScheme.error : theme.colorScheme.outline,
              ),
            ),
          ),
        ],
      ),
    };

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (onLoadOlder != null)
          TextButton.icon(
            onPressed: onLoadOlder,
            icon: const Icon(Icons.expand_less, size: 18),
            label: const Text('Load earlier messages'),
          ),
        Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: child),
      ],
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({required this.alignEnd, required this.child, this.muted = false});

  final bool alignEnd;
  final Widget child;
  final bool muted;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final background = alignEnd
        ? theme.colorScheme.primaryContainer
        : theme.colorScheme.surfaceContainerHigh;
    return Align(
      alignment: alignEnd ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.86),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: muted ? theme.colorScheme.surfaceContainerHighest : background,
          borderRadius: BorderRadius.circular(14),
        ),
        child: child,
      ),
    );
  }
}

class _Reasoning extends StatefulWidget {
  const _Reasoning({required this.text, this.live = false});

  final String text;

  /// Live reasoning stays open while it streams, then collapses on commit.
  final bool live;

  @override
  State<_Reasoning> createState() => _ReasoningState();
}

class _ReasoningState extends State<_Reasoning> {
  late bool _open = widget.live;

  @override
  void didUpdateWidget(_Reasoning oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.live && !widget.live) _open = false;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: () => setState(() => _open = !_open),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  _open ? Icons.expand_less : Icons.expand_more,
                  size: 16,
                  color: theme.colorScheme.outline,
                ),
                const SizedBox(width: 4),
                Text(
                  'Reasoning',
                  style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.outline),
                ),
              ],
            ),
          ),
          if (_open)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                widget.text,
                style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.outline),
              ),
            ),
        ],
      ),
    );
  }
}

class _ToolCard extends StatelessWidget {
  const _ToolCard({required this.title, required this.body, required this.tone});

  final String title;
  final String body;
  final Color tone;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(color: tone, borderRadius: BorderRadius.circular(10)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: theme.textTheme.labelMedium),
          if (body.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              body,
              maxLines: 8,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall,
            ),
          ],
        ],
      ),
    );
  }
}

class _Composer extends StatelessWidget {
  const _Composer({
    required this.controller,
    required this.sending,
    required this.onSend,
    required this.onSteer,
  });

  final TextEditingController controller;
  final bool sending;
  final VoidCallback onSend;
  final VoidCallback onSteer;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Expanded(
              child: TextField(
                controller: controller,
                minLines: 1,
                maxLines: 5,
                textInputAction: TextInputAction.newline,
                decoration: InputDecoration(
                  hintText: 'Message the agent on your computer',
                  filled: true,
                  fillColor: theme.colorScheme.surfaceContainerHigh,
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(20),
                    borderSide: BorderSide.none,
                  ),
                  contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                ),
              ),
            ),
            const SizedBox(width: 8),
            if (sending)
              const Padding(
                padding: EdgeInsets.all(12),
                child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)),
              )
            else
              IconButton.filled(
                onPressed: onSend,
                icon: const Icon(Icons.send),
                tooltip: 'Send',
              ),
            IconButton(
              onPressed: onSteer,
              icon: const Icon(Icons.bolt),
              tooltip: 'Steer the running turn',
            ),
          ],
        ),
      ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      width: double.infinity,
      color: theme.colorScheme.errorContainer,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Text(
        message,
        style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onErrorContainer),
      ),
    );
  }
}

class _EmptyTranscript extends StatelessWidget {
  const _EmptyTranscript();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.forum_outlined, size: 40, color: theme.colorScheme.outline),
            const SizedBox(height: 12),
            Text('Nothing here yet', style: theme.textTheme.titleSmall),
            const SizedBox(height: 4),
            Text(
              'Send a message below to start the conversation.',
              textAlign: TextAlign.center,
              style: theme.textTheme.bodySmall,
            ),
          ],
        ),
      ),
    );
  }
}

/// Renders tool arguments, which DSH stores as a raw JSON string.
String _prettyJson(String raw) {
  if (raw.isEmpty) return '';
  try {
    final decoded = jsonDecode(raw);
    return const JsonEncoder.withIndent('  ').convert(decoded);
  } on FormatException {
    return raw;
  }
}
