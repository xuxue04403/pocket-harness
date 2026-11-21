import 'dart:async';
import 'dart:typed_data';

import 'package:image_picker/image_picker.dart';
import 'package:material_ui/material_ui.dart';

import '../dsh/host_link.dart';
import '../dsh/outgoing_image.dart';
import '../dsh/questions.dart';
import '../dsh/tool_labels.dart';
import 'files_page.dart';
import 'jobs_page.dart';
import 'model_sheet.dart';
import 'skill_sheet.dart';

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

  /// Images staged for the next prompt.
  ///
  /// DSH sends text and images together in one message, so the composer holds
  /// them until the person presses send; staging also lets them remove one
  /// without retyping the message.
  final List<OutgoingImage> _pendingImages = [];

  /// The model route this session is on, shown in the app bar.
  ///
  /// DSH projects the selection rather than returning it from `follow`, so this
  /// is read once on open and refreshed whenever the person changes it here. A
  /// change made on the desktop mid-conversation stays unseen until the next
  /// open, which keeps the app bar from flickering on every frame.
  ModelSelection? _selection;
  bool _loadingSelection = true;

  /// The agent's current todo list, or null when it has never written one.
  ///
  /// The desktop pins this above the transcript while a turn runs; on a phone
  /// the same panel is what keeps a long autonomous run legible, because the
  /// transcript alone only shows what has already happened.
  List<TodoItem>? _todos;
  bool _todosOpen = true;

  /// Whether the person has seen the list at least once, so the panel does not
  /// spring open again after they collapse it.
  bool _todosTouched = false;

  /// When the running turn started, so the page can count up like the desktop.
  ///
  /// The desktop prints `深度求索中，用时 2分13秒` under a running turn; keeping the
  /// same line here is what tells a person the phone is still connected and the
  /// computer is still working, rather than stalled.
  DateTime? _turnStarted;
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    _start();
    _listenForQuestions();
    unawaited(_loadSelection());
    unawaited(_loadTodos());
  }

  /// Starts or stops the one-second clock that drives the running-turn footer.
  void _syncTicker() {
    if (_turnStarted == null) {
      _ticker?.cancel();
      _ticker = null;
      return;
    }
    _ticker ??= Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
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

  Future<void> _loadTodos() async {
    try {
      final todos = await widget.link.todos(widget.sessionId);
      if (!mounted) return;
      setState(() => _todos = todos);
    } on Object {
      // The list is a convenience, not the conversation: a Host that cannot
      // project it still has a usable chat page.
    }
  }

  Future<void> _openFiles() async {
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => FilesPage(link: widget.link, sessionId: widget.sessionId),
      ),
    );
  }

  Future<void> _openJobs() async {
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => JobsPage(link: widget.link, sessionId: widget.sessionId),
      ),
    );
  }

  /// Copies this conversation into a new one and opens it.
  ///
  /// The Host cuts at the latest completed turn, so the copy carries the same
  /// history, working directory and preset. That is the shape a person wants on
  /// a phone: try a different direction without losing the run that led here.
  Future<void> _fork() async {
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final forked = await widget.link.fork(widget.sessionId);
      if (!mounted) return;
      // Push rather than replace: the source stays one step back, because the
      // usual reason to branch is to compare the two.
      await navigator.push(
        MaterialPageRoute(
          builder: (_) => ChatPage(
            link: widget.link,
            sessionId: forked,
            title: widget.title,
          ),
        ),
      );
    } on Object catch (error) {
      messenger.showSnackBar(SnackBar(content: Text('分支失败：${_describe(error)}')));
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
        if (eventType == 'turn/start') {
          _turnStarted = DateTime.now();
          _syncTicker();
        }
        // The durable message supersedes whatever the live draft accumulated,
        // so the two never show the same text twice.
        if (eventType == 'assistant/message' || eventType == 'turn/end') _draft = null;
        if (eventType == 'turn/end') {
          _turnStarted = null;
          _syncTicker();
        }
        if (eventType == 'todo/write') {
          final payload = event is Map<String, Object?> ? event['data'] : null;
          final todos = readTodoWrite(payload);
          _todos = todos.isEmpty ? null : todos;
          // A fresh plan is worth showing even if the panel was collapsed for
          // the previous one; the person asked for it by starting a new turn.
          if (!_todosTouched) _todosOpen = true;
        }
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
          _turnStarted ??= DateTime.now();
          _syncTicker();
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
    final images = List<OutgoingImage>.of(_pendingImages);
    if ((text.isEmpty && images.isEmpty) || _sending) return;
    setState(() => _sending = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await widget.link.promptContent(widget.sessionId, [
        if (text.isNotEmpty) {'type': 'text', 'text': text},
        for (final image in images) image.toPart(),
      ], mode: mode);
      _composer.clear();
      if (mounted) setState(_pendingImages.clear);
    } on Object catch (error) {
      messenger.showSnackBar(SnackBar(content: Text('$error')));
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  /// Picks one image from the gallery and stages it for the next prompt.
  ///
  /// The picker returns a path rather than bytes, so this reads the file and
  /// rejects anything DSH would not accept instead of letting the Host fail the
  /// whole prompt after the person has already typed a message.
  Future<void> _pickImage() async {
    final messenger = ScaffoldMessenger.of(context);
    final XFile? picked;
    try {
      picked = await ImagePicker().pickImage(source: ImageSource.gallery, imageQuality: 88);
    } on Object catch (error) {
      messenger.showSnackBar(SnackBar(content: Text('打开相册失败：$error')));
      return;
    }
    if (picked == null || !mounted) return;
    final file = picked;
    final mediaType =
        OutgoingImage.mediaTypeFor(file.path) ?? OutgoingImage.mediaTypeFor(file.name);
    if (mediaType == null) {
      messenger.showSnackBar(const SnackBar(content: Text('只支持 PNG、JPEG、WebP、GIF 图片。')));
      return;
    }
    final bytes = await file.readAsBytes();
    if (!mounted) return;
    setState(() {
      _pendingImages.add(OutgoingImage(bytes: bytes, mediaType: mediaType, name: file.name));
    });
  }

  /// Inserts `/name` for the chosen skill, matching what the desktop composer
  /// accepts, and leaves the cursor after it so a message can follow.
  Future<void> _insertSkill() async {
    final skill = await showSkillSheet(
      context,
      skills: widget.link.skills(widget.sessionId),
    );
    if (skill == null || !mounted) return;
    final existing = _composer.text;
    final prefix = existing.isEmpty || existing.endsWith(' ') || existing.endsWith('\n') ? existing : '$existing ';
    _composer.text = '$prefix/${skill.name} ';
    _composer.selection = TextSelection.collapsed(offset: _composer.text.length);
  }

  Future<void> _cancel() async {    final messenger = ScaffoldMessenger.of(context);
    try {
      await widget.link.cancel(widget.sessionId);
    } on Object catch (error) {
      messenger.showSnackBar(SnackBar(content: Text('$error')));
    }
  }

  @override
  void dispose() {
    _ticker?.cancel();
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
            onPressed: _openFiles,
            icon: const Icon(Icons.folder_open_outlined),
            tooltip: '工作区文件',
          ),
          IconButton(
            onPressed: _openJobs,
            icon: const Icon(Icons.task_alt_outlined),
            tooltip: '后台任务',
          ),
          IconButton(
            onPressed: _pickModel,
            icon: const Icon(Icons.tune),
            tooltip: '选择模型',
          ),
          // The actions that change the conversation rather than read it live
          // here; one menu keeps the bar from becoming a row of identical icons.
          PopupMenuButton<String>(
            tooltip: '更多',
            onSelected: (value) {
              if (value == 'fork') unawaited(_fork());
            },
            itemBuilder: (context) => const [
              PopupMenuItem(
                value: 'fork',
                child: ListTile(
                  leading: Icon(Icons.call_split),
                  title: Text('分支出一个副本'),
                  contentPadding: EdgeInsets.zero,
                ),
              ),
            ],
          ),
          // Only while a turn is actually running: an always-visible stop button
          // on an idle conversation is a button that does nothing.
          if (_turnStarted != null)
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
          if (_todos case final todos?)
            _TodoPanel(
              items: todos,
              open: _todosOpen,
              onToggle: () => setState(() {
                _todosTouched = true;
                _todosOpen = !_todosOpen;
              }),
            ),
          Expanded(child: _body()),
          if (_pendingImages.isNotEmpty)
            _PendingStrip(
              images: _pendingImages,
              onRemove: (index) => setState(() => _pendingImages.removeAt(index)),
            ),
          _Composer(
            controller: _composer,
            sending: _sending,
            onSend: () => _send(),
            onSteer: () => _send(mode: 'steer'),
            onSkill: _insertSkill,
            onImage: _pickImage,
          ),
        ],
      ),
    );
  }

  Widget _body() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    final draft = _draft;
    final showDraft = draft != null && !draft.isEmpty;
    final running = _turnStarted;
    if (_rows.isEmpty && !showDraft && running == null) return const _EmptyTranscript();
    final count = _rows.length + (showDraft ? 1 : 0) + (running != null ? 1 : 0);
    return ListView.builder(
      controller: _scroll,
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      itemCount: count,
      itemBuilder: (context, index) {
        if (index < _rows.length) {
          return _TranscriptTile(
            row: _rows[index],
            link: widget.link,
            sessionId: widget.sessionId,
            onLoadOlder: index == 0 ? _loadOlder : null,
          );
        }
        if (showDraft && index == _rows.length) return _LiveTile(draft: draft);
        return _RunningFooter(started: running!, onStop: _cancel);
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
///
/// This is the row that makes the phone feel alive: text appears as DSH emits
/// it, the thinking block stays open while it grows, and a blinking caret marks
/// where the next token will land.
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
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (reasoning.isNotEmpty) _Reasoning(text: reasoning, live: true),
          // Plain text rather than a selectable span: the draft is transient, and
          // a selectable node is invisible to screen readers and to the
          // accessibility tree the UI tests read.
          if (text.isNotEmpty) Text('$text▍', style: theme.textTheme.bodyMedium),
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
                    reasoning.isEmpty ? '等待首字…' : '思考中…',
                    style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.outline),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _TranscriptTile extends StatelessWidget {
  const _TranscriptTile({
    required this.row,
    required this.link,
    required this.sessionId,
    this.onLoadOlder,
  });

  final TranscriptRow row;
  final HostLink link;
  final String sessionId;
  final VoidCallback? onLoadOlder;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final child = switch (row) {
      UserRow(:final text, :final injected, :final images) => _Bubble(
        alignEnd: true,
        muted: injected,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (images.isNotEmpty)
              _AttachmentStrip(sessionId: sessionId, link: link, images: images),
            if (text.isNotEmpty) Text(text, style: theme.textTheme.bodyMedium),
          ],
        ),
      ),
      AssistantRow(:final text, :final reasoning, :final images) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (reasoning != null) _Reasoning(text: reasoning),
            if (images.isNotEmpty)
              _AttachmentStrip(sessionId: sessionId, link: link, images: images),
            if (text.isNotEmpty) SelectableText(text, style: theme.textTheme.bodyMedium),
          ],
        ),
      ),
      ToolCallRow(:final name, :final arguments) => _ToolCard(
        icon: Icons.terminal,
        title: toolVerb(name),
        subject: toolSubject(arguments),
        body: prettyJson(arguments),
        bodyLabel: '参数',
      ),
      ToolResultRow(:final text, :final isError) => _ToolCard(
        icon: isError ? Icons.error_outline : Icons.check_circle_outline,
        title: isError ? '工具失败' : '工具结果',
        subject: summarizeBody(text),
        body: text,
        bodyLabel: '输出',
        isError: isError,
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

/// The images a message carries, painted from the Host's attachment store.
///
/// The wire never carries image bytes inside an event: DSH stores each image
/// once and the message records a reference. So each thumbnail is a small
/// request, cached by attachment id, and a failure shows a labelled box rather
/// than an invisible gap — a missing picture should say so.
class _AttachmentStrip extends StatefulWidget {
  const _AttachmentStrip({required this.sessionId, required this.link, required this.images});

  final String sessionId;
  final HostLink link;
  final List<ImageAttachment> images;

  /// Bytes survive a scroll away and back, keyed by the durable attachment id.
  static final Map<String, Uint8List> _cache = <String, Uint8List>{};

  @override
  State<_AttachmentStrip> createState() => _AttachmentStripState();
}

class _AttachmentStripState extends State<_AttachmentStrip> {
  late List<Future<Uint8List>> _futures = _load();

  List<Future<Uint8List>> _load() {
    return [
      for (final image in widget.images)
        _AttachmentStrip._cache[image.attachmentId] != null
            ? Future<Uint8List>.value(_AttachmentStrip._cache[image.attachmentId]!)
            : widget.link.attachment(widget.sessionId, image).then((bytes) {
                _AttachmentStrip._cache[image.attachmentId] = bytes;
                return bytes;
              }),
    ];
  }

  @override
  void didUpdateWidget(covariant _AttachmentStrip oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.sessionId != widget.sessionId ||
        oldWidget.images.length != widget.images.length) {
      _futures = _load();
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Wrap(
        spacing: 6,
        runSpacing: 6,
        children: [
          for (var index = 0; index < widget.images.length; index += 1)
            ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: SizedBox(
                width: 140,
                height: 140,
                child: FutureBuilder<Uint8List>(
                  future: _futures[index],
                  builder: (context, snapshot) {
                    if (snapshot.hasError) {
                      return Container(
                        color: theme.colorScheme.surfaceContainerHighest,
                        alignment: Alignment.center,
                        padding: const EdgeInsets.all(6),
                        child: Text(
                          '图片读取失败',
                          textAlign: TextAlign.center,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: theme.colorScheme.error,
                          ),
                        ),
                      );
                    }
                    final bytes = snapshot.data;
                    if (bytes == null) {
                      return Container(
                        color: theme.colorScheme.surfaceContainerHighest,
                        alignment: Alignment.center,
                        child: const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      );
                    }
                    return Image.memory(
                      bytes,
                      fit: BoxFit.cover,
                      // A corrupt image must not take the transcript down.
                      errorBuilder: (context, error, stack) => Container(
                        color: theme.colorScheme.surfaceContainerHighest,
                        alignment: Alignment.center,
                        child: Text('无法显示', style: theme.textTheme.bodySmall),
                      ),
                    );
                  },
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// The footer under a running turn: `深度求索中，用时 2分13秒`, plus a stop button.
///
/// The desktop prints the same line while a turn is in flight, and it is the
/// only signal that separates "the computer is thinking hard" from "the phone
/// lost the link" — the clock moving is the proof.
class _RunningFooter extends StatelessWidget {
  const _RunningFooter({required this.started, required this.onStop});

  final DateTime started;
  final VoidCallback onStop;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final elapsed = DateTime.now().difference(started);
    final minutes = elapsed.inMinutes;
    final seconds = elapsed.inSeconds.remainder(60);
    final label = minutes > 0 ? '深度求索中，用时 $minutes分$seconds秒' : '深度求索中，用时 $seconds秒';
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 6, 4, 10),
      child: Row(
        children: [
          SizedBox(
            width: 12,
            height: 12,
            child: CircularProgressIndicator(strokeWidth: 2, color: theme.colorScheme.outline),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              label,
              style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.outline),
            ),
          ),
          TextButton(onPressed: onStop, child: const Text('停止')),
        ],
      ),
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
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  _open ? Icons.expand_less : Icons.expand_more,
                  size: 16,
                  color: theme.colorScheme.outline,
                ),
                const SizedBox(width: 4),
                Icon(Icons.psychology_outlined, size: 14, color: theme.colorScheme.outline),
                const SizedBox(width: 4),
                Expanded(
                  child: Text(
                    _open ? '思考' : '思考 · ${firstLine(widget.text, limit: 46)}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.outline),
                  ),
                ),
              ],
            ),
          ),
          if (_open)
            Padding(
              padding: const EdgeInsets.only(top: 4, left: 20),
              child: SelectableText(
                widget.text,
                style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.outline),
              ),
            ),
        ],
      ),
    );
  }
}

/// A tool call or a tool result, in the shape the desktop uses: one line naming
/// the verb and what it acted on, with the details folded away behind it.
class _ToolCard extends StatefulWidget {
  const _ToolCard({
    required this.icon,
    required this.title,
    required this.body,
    required this.bodyLabel,
    this.subject = '',
    this.isError = false,
  });

  final IconData icon;
  final String title;
  final String subject;
  final String body;
  final String bodyLabel;
  final bool isError;

  @override
  State<_ToolCard> createState() => _ToolCardState();
}

class _ToolCardState extends State<_ToolCard> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final border = widget.isError ? theme.colorScheme.error : theme.colorScheme.outlineVariant;
    final foreground = widget.isError ? theme.colorScheme.error : theme.colorScheme.onSurfaceVariant;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 2),
      decoration: BoxDecoration(
        border: Border(left: BorderSide(color: border, width: 2.5)),
        color: theme.colorScheme.surfaceContainerLow,
        borderRadius: const BorderRadius.only(
          topRight: Radius.circular(8),
          bottomRight: Radius.circular(8),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: widget.body.isEmpty ? null : () => setState(() => _open = !_open),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(10, 8, 8, 8),
              child: Row(
                children: [
                  Icon(widget.icon, size: 15, color: foreground),
                  const SizedBox(width: 6),
                  Text(
                    widget.title,
                    style: theme.textTheme.labelMedium?.copyWith(color: foreground),
                  ),
                  if (widget.subject.isNotEmpty) ...[
                    Text(
                      ' · ',
                      style: theme.textTheme.labelMedium?.copyWith(color: foreground),
                    ),
                    Expanded(
                      child: Text(
                        widget.subject,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                  ] else
                    const Spacer(),
                  if (widget.body.isNotEmpty)
                    Icon(
                      _open ? Icons.expand_less : Icons.expand_more,
                      size: 16,
                      color: theme.colorScheme.outline,
                    ),
                ],
              ),
            ),
          ),
          if (_open)
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    widget.bodyLabel,
                    style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.outline),
                  ),
                  const SizedBox(height: 2),
                  SelectableText(
                    widget.body,
                    style: theme.textTheme.bodySmall?.copyWith(fontFamily: 'monospace'),
                  ),
                ],
              ),
            ),
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
    required this.onSkill,
    required this.onImage,
  });

  final TextEditingController controller;
  final bool sending;
  final VoidCallback onSend;
  final VoidCallback onSteer;
  final VoidCallback onSkill;
  final VoidCallback onImage;

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
            IconButton(
              onPressed: onImage,
              icon: const Icon(Icons.image_outlined),
              tooltip: '插入图片',
            ),
            IconButton(
              onPressed: onSkill,
              icon: const Icon(Icons.auto_awesome_outlined),
              tooltip: '插入技能',
            ),
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

/// The images staged for the next prompt, each removable before sending.
///
/// Staging lives above the composer because DSH takes text and images in one
/// message: the picture has to be visible while the person finishes typing, and
/// it has to be possible to drop it without clearing the message.
class _PendingStrip extends StatelessWidget {
  const _PendingStrip({required this.images, required this.onRemove});

  final List<OutgoingImage> images;
  final void Function(int index) onRemove;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SizedBox(
      height: 76,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(12, 4, 12, 4),
        itemCount: images.length,
        separatorBuilder: (context, index) => const SizedBox(width: 8),
        itemBuilder: (context, index) {
          final image = images[index];
          return Stack(
            clipBehavior: Clip.none,
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: Image.memory(
                  image.bytes,
                  width: 68,
                  height: 68,
                  fit: BoxFit.cover,
                  errorBuilder: (context, error, stack) => Container(
                    width: 68,
                    height: 68,
                    color: theme.colorScheme.surfaceContainerHighest,
                    alignment: Alignment.center,
                    child: Text('无法预览', style: theme.textTheme.bodySmall),
                  ),
                ),
              ),
              Positioned(
                top: -6,
                right: -6,
                child: IconButton(
                  onPressed: () => onRemove(index),
                  iconSize: 16,
                  visualDensity: VisualDensity.compact,
                  style: IconButton.styleFrom(
                    backgroundColor: theme.colorScheme.surface,
                    side: BorderSide(color: theme.colorScheme.outlineVariant),
                  ),
                  icon: const Icon(Icons.close),
                  tooltip: '移除图片',
                ),
              ),
            ],
          );
        },
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

/// What the person chose for one pending question.
enum _Answer { approve, reject, delegate }

/// The band of questions blocking the turn, above the composer.
///
/// Only the oldest question is expanded: a queue of five stale approvals is
/// noise, and DSH asks them one at a time anyway.
/// The agent's plan, pinned above the transcript like the desktop's todo panel.
///
/// Collapsed it shows one line — done/total and the item being worked on — which
/// is the part worth glancing at while a turn runs. Expanded it lists every item
/// with its state, so a person can see how far along a long autonomous run is
/// without reading the whole transcript.
class _TodoPanel extends StatelessWidget {
  const _TodoPanel({required this.items, required this.open, required this.onToggle});

  final List<TodoItem> items;
  final bool open;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final done = items.where((item) => item.isDone).length;
    final active = items.where((item) => item.isRunning).firstOrNull;
    final summary = active?.content ?? items.firstWhere((item) => !item.isDone, orElse: () => items.last).content;
    return Container(
      width: double.infinity,
      color: theme.colorScheme.surfaceContainerHigh,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: onToggle,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
              child: Row(
                children: [
                  Icon(
                    open ? Icons.expand_more : Icons.chevron_right,
                    size: 16,
                    color: theme.colorScheme.outline,
                  ),
                  const SizedBox(width: 4),
                  Icon(Icons.checklist, size: 16, color: theme.colorScheme.primary),
                  const SizedBox(width: 6),
                  Text('待办 $done/${items.length}', style: theme.textTheme.labelMedium),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      summary,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.outline),
                    ),
                  ),
                ],
              ),
            ),
          ),
          if (open)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final item in items) _TodoLine(item: item),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _TodoLine extends StatelessWidget {
  const _TodoLine({required this.item});

  final TodoItem item;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = item.isDone
        ? theme.colorScheme.outline
        : item.isRunning
        ? theme.colorScheme.primary
        : theme.colorScheme.onSurfaceVariant;
    final icon = item.isDone
        ? Icons.check_circle_outline
        : item.isRunning
        ? Icons.radio_button_checked
        : Icons.radio_button_unchecked;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 14, color: color),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              item.content,
              style: theme.textTheme.bodySmall?.copyWith(
                color: color,
                decoration: item.isDone ? TextDecoration.lineThrough : null,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

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
