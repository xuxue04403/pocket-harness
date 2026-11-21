import 'dart:async';
import 'dart:convert';

import 'package:material_ui/material_ui.dart';

import '../dsh/host_link.dart';
import '../dsh/questions.dart';
import 'model_sheet.dart';

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

  /// Questions this Host is waiting on, oldest first.
  ///
  /// An approval blocks the turn until somebody answers it, so it sits above the
  /// composer where the person is already looking; the desktop may be showing
  /// the same prompt at the same time, and whichever answers first wins.
  final List<PendingQuestion> _questions = [];
  StreamSubscription<PendingQuestion>? _questionStream;

  /// The model route this session is on, shown in the app bar.
  ///
  /// DSH projects the selection rather than returning it from `follow`, so this
  /// is read once on open and refreshed whenever the person changes it here. A
  /// change made on the desktop mid-conversation stays unseen until the next
  /// open, which keeps the app bar from flickering on every frame.
  ModelSelection? _selection;
  bool _loadingSelection = true;

  @override
  void initState() {
    super.initState();
    _start();
    _listenForQuestions();
    unawaited(_loadSelection());
  }

  Future<void> _loadSelection() async {
    try {
      final selection = await widget.link.selection(widget.sessionId);
      if (!mounted) return;
      setState(() {
        _selection = selection;
        _loadingSelection = false;
      });
    } on Object {
      // A missing selection is cosmetic: the picker still works, and the
      // transcript is unaffected, so this never becomes an error banner.
      if (!mounted) return;
      setState(() => _loadingSelection = false);
    }
  }

  Future<void> _pickModel() async {
    final selected = await showModelPicker(
      context,
      catalog: widget.link.modelCatalog(),
      current: Future.value(_selection),
      onSelect: (choice, effort) => widget.link.selectModel(
        widget.sessionId,
        choice,
        reasoningEffort: effort,
      ),
    );
    if (selected == null || !mounted) return;
    setState(() => _selection = selected);
  }

  void _listenForQuestions() {
    _questionStream = widget.link.questions.listen(
      (question) {
        if (!mounted) return;
        setState(() => _questions.add(question));
      },
      onError: (Object error) {
        if (!mounted) return;
        setState(() => _error ??= '这台电脑没有开放审批转发：$error');
      },
    );
    // Opening the stream is what claims approvals for this phone; a Host that
    // refuses it leaves the composer usable and approvals on the desktop.
    unawaited(widget.link.startQuestions());
  }

  Future<void> _answerQuestion(PendingQuestion question, {required _Answer choice}) async {
    setState(() => _questions.remove(question));
    final messenger = ScaffoldMessenger.of(context);
    try {
      switch (choice) {
        case _Answer.approve:
          await widget.link.approve(question);
        case _Answer.reject:
          await widget.link.reject(question);
        case _Answer.delegate:
          await widget.link.delegate(question);
      }
    } on Object catch (error) {
      messenger.showSnackBar(SnackBar(content: Text('$error')));
    }
  }

  /// Collects one choice per sub-question, then replies once.
  Future<void> _askChoice(ChoiceQuestion question) async {
    final picked = await showDialog<Map<String, List<String>>>(
      context: context,
      builder: (context) => _ChoiceDialog(question: question),
    );
    if (picked == null || !mounted) return;
    setState(() => _questions.remove(question));
    final messenger = ScaffoldMessenger.of(context);
    try {
      await widget.link.answerChoice(question, picked);
    } on Object catch (error) {
      messenger.showSnackBar(SnackBar(content: Text('$error')));
    }
  }

  void _start() {
    _follow = widget.link.follow(widget.sessionId).listen(
      _onFrame,
      onError: (Object error) {
        if (mounted) setState(() => _error = _describe(error));
      },
      onDone: () {
        if (mounted) setState(() => _error ??= '电脑端关闭了这个会话的实时连接。');
      },
    );
  }

  /// Turns a dropped link into something worth reading.
  ///
  /// The heartbeat reports a dead-but-open socket as a `StateError`, whose text
  /// is written for developers; a phone user needs to know the connection is
  /// gone and what to do about it.
  String _describe(Object error) {
    if (error is StateError) {
      if ('$error'.contains('stopped answering')) {
        return '连接已经断了（电脑没有回应心跳）。请返回上一页重新连接。';
      }
      if ('$error'.contains('closed')) return '连接已关闭。请返回上一页重新连接。';
    }
    return '$error';
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
    unawaited(_questionStream?.cancel());
    unawaited(_follow?.cancel());
    _composer.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(widget.title, maxLines: 1, overflow: TextOverflow.ellipsis),
            _AppBarModelLine(
              selection: _selection,
              loading: _loadingSelection,
              onTap: _pickModel,
            ),
          ],
        ),
        actions: [
          IconButton(
            onPressed: _pickModel,
            icon: const Icon(Icons.tune),
            tooltip: '选择模型',
          ),
          IconButton(
            onPressed: _cancel,
            icon: const Icon(Icons.stop_circle_outlined),
            tooltip: '中止本轮',
          ),
        ],
      ),
      body: Column(
        children: [
          if (_error != null) _ErrorBanner(message: _error!),
          if (_questions.isNotEmpty)
            _QuestionBar(
              questions: _questions,
              onApproval: (question, approved) => _answerQuestion(
                question,
                choice: approved ? _Answer.approve : _Answer.reject,
              ),
              onChoice: _askChoice,
              onDelegate: (question) => _answerQuestion(question, choice: _Answer.delegate),
            ),
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

/// The model route, under the session title.
///
/// It reads as a subtitle because that is what it is: a property of this
/// conversation, tappable to change it.
class _AppBarModelLine extends StatelessWidget {
  const _AppBarModelLine({required this.selection, required this.loading, required this.onTap});

  final ModelSelection? selection;
  final bool loading;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final label = loading
        ? '读取模型…'
        : selection == null
            ? '默认模型 · 点击选择'
            : [selection!.model, if (selection!.reasoningEffort != null) selection!.reasoningEffort!]
                .join(' · ');
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.only(right: 8),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Flexible(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ),
            Icon(Icons.expand_more, size: 14, color: theme.colorScheme.onSurfaceVariant),
          ],
        ),
      ),
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
                      reasoning.isEmpty ? '运行中' : '思考中',
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
        title: isError ? '工具执行失败' : '工具结果',
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
            label: const Text('加载更早的消息'),
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
                  '思考过程',
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
                  hintText: '给电脑上的智能体发消息',
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
                tooltip: '发送',
              ),
            IconButton(
              onPressed: onSteer,
              icon: const Icon(Icons.bolt),
              tooltip: '插入到当前轮次',
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
            Text('这里还是空的', style: theme.textTheme.titleSmall),
            const SizedBox(height: 4),
            Text(
              '在下方发一条消息即可开始对话。',
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

/// What the person chose for one pending question.
enum _Answer { approve, reject, delegate }

/// The band of questions blocking the turn, above the composer.
///
/// Only the oldest question is expanded: a queue of five stale approvals is
/// noise, and DSH asks them one at a time anyway.
class _QuestionBar extends StatelessWidget {
  const _QuestionBar({
    required this.questions,
    required this.onApproval,
    required this.onChoice,
    required this.onDelegate,
  });

  final List<PendingQuestion> questions;
  final void Function(PendingQuestion question, bool approved) onApproval;
  final void Function(ChoiceQuestion question) onChoice;
  final void Function(PendingQuestion question) onDelegate;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final question = questions.first;
    return Container(
      width: double.infinity,
      color: theme.colorScheme.surfaceContainerHighest,
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.help_outline, size: 16, color: theme.colorScheme.primary),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  questions.length == 1
                      ? '这个工具在等你确认'
                      : '还有 ${questions.length} 个问题在等待回答',
                  style: theme.textTheme.labelMedium,
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(question.title, style: theme.textTheme.bodyMedium),
          const SizedBox(height: 8),
          if (question is ChoiceQuestion)
            Row(
              children: [
                FilledButton(
                  onPressed: () => onChoice(question),
                  child: const Text('回答'),
                ),
                const SizedBox(width: 8),
                TextButton(
                  onPressed: () => onDelegate(question),
                  child: const Text('回电脑上处理'),
                ),
              ],
            )
          else
            Wrap(
              spacing: 8,
              children: [
                FilledButton(
                  onPressed: () => onApproval(question, true),
                  child: const Text('允许一次'),
                ),
                OutlinedButton(
                  onPressed: () => onApproval(question, false),
                  child: const Text('拒绝'),
                ),
                TextButton(
                  onPressed: () => onDelegate(question),
                  child: const Text('回电脑上处理'),
                ),
              ],
            ),
        ],
      ),
    );
  }
}

/// Collects one answer per sub-question of a choice prompt.
class _ChoiceDialog extends StatefulWidget {
  const _ChoiceDialog({required this.question});

  final ChoiceQuestion question;

  @override
  State<_ChoiceDialog> createState() => _ChoiceDialogState();
}

class _ChoiceDialogState extends State<_ChoiceDialog> {
  final Map<String, Set<String>> _selected = {};

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AlertDialog(
      title: const Text('回答问题'),
      content: SizedBox(
        width: double.maxFinite,
        child: ListView(
          shrinkWrap: true,
          children: [
            for (final question in widget.question.questions) ...[
              if (question.header != null)
                Text(question.header!, style: theme.textTheme.labelSmall),
              Text(question.question, style: theme.textTheme.bodyMedium),
              if (question.detail != null)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(question.detail!, style: theme.textTheme.bodySmall),
                ),
              const SizedBox(height: 4),
              for (final option in question.options)
                CheckboxListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  controlAffinity: ListTileControlAffinity.leading,
                  value: _selected[question.id]?.contains(option.label) ?? false,
                  title: Text(option.label, style: theme.textTheme.bodyMedium),
                  subtitle: option.description == null ? null : Text(option.description!),
                  onChanged: (checked) {
                    setState(() {
                      final chosen = _selected.putIfAbsent(question.id, () => <String>{});
                      if (checked ?? false) {
                        // Single-select prompts replace the previous pick; a
                        // multi-select one accumulates.
                        if (!question.multiSelect) chosen.clear();
                        chosen.add(option.label);
                      } else {
                        chosen.remove(option.label);
                      }
                    });
                  },
                ),
              const SizedBox(height: 12),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: () {
            Navigator.of(context).pop(<String, List<String>>{
              for (final entry in _selected.entries) entry.key: entry.value.toList(),
            });
          },
          child: const Text('提交回答'),
        ),
      ],
    );
  }
}
