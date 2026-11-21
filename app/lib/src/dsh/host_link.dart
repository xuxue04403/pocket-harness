import 'dart:async';

import 'package:dsh_link/dsh_link.dart';

import 'questions.dart';

/// One Host summary as the session list needs it.
class SessionSummary {
  const SessionSummary({
    required this.sessionId,
    required this.title,
    required this.updatedAt,
    required this.running,
    this.cwd,
  });

  final String sessionId;
  final String title;
  final DateTime updatedAt;
  final bool running;
  final String? cwd;

  /// Reads the fields the phone actually shows, tolerating anything missing.
  ///
  /// DSH nests user-visible metadata in `projections`, which is optional and
  /// grows over time; the list must keep working when a newer Host adds or
  /// drops a field, so every read falls back instead of throwing.
  static SessionSummary? fromJson(Object? value) {
    if (value is! Map<String, Object?>) return null;
    final id = value['sessionId'];
    if (id is! String || id.isEmpty) return null;
    final projections = value['projections'];
    final values = projections is Map<String, Object?> ? projections['values'] : null;
    final map = values is Map<String, Object?> ? values : const <String, Object?>{};
    final title = map['title'];
    final workingDirectory = map['workingDirectory'];
    final updated = value['updatedAt'];
    return SessionSummary(
      sessionId: id,
      title: title is String && title.isNotEmpty ? title : '未命名会话',
      updatedAt: updated is num
          ? DateTime.fromMillisecondsSinceEpoch(updated.toInt())
          : DateTime.fromMillisecondsSinceEpoch(0),
      running: value['running'] == true,
      cwd: workingDirectory is String ? workingDirectory : null,
    );
  }
}

/// One rendered row of a session transcript.
///
/// The transcript is built from DSH session events rather than from a bespoke
/// message format, so anything the desktop shows can be shown here.
sealed class TranscriptRow {
  const TranscriptRow({required this.seq});

  /// Durable sequence number this row came from; used to keep ordering stable.
  final int seq;
}

class UserRow extends TranscriptRow {
  const UserRow({required super.seq, required this.text, this.injected = false});

  final String text;

  /// Whether DSH attributed this to the agent rather than to the person.
  final bool injected;
}

class AssistantRow extends TranscriptRow {
  const AssistantRow({required super.seq, required this.text, this.reasoning});

  final String text;
  final String? reasoning;
}

class ToolCallRow extends TranscriptRow {
  const ToolCallRow({required super.seq, required this.name, required this.arguments});

  final String name;
  final String arguments;
}

class ToolResultRow extends TranscriptRow {
  const ToolResultRow({required super.seq, required this.text, required this.isError});

  final String text;
  final bool isError;
}

class NoticeRow extends TranscriptRow {
  const NoticeRow({required super.seq, required this.text, this.isError = false});

  final String text;
  final bool isError;
}

/// Turns DSH session events into transcript rows.
///
/// Unknown event types are skipped on purpose: the desktop records dozens of
/// bookkeeping events the phone has nothing to say about, and a newer Host may
/// add more. Only the events that carry conversation text become rows.
List<TranscriptRow> buildTranscript(Iterable<Object?> records) {
  final rows = <TranscriptRow>[];
  for (final record in records) {
    final row = _rowOf(record);
    if (row != null) rows.add(row);
  }
  rows.sort((left, right) => left.seq.compareTo(right.seq));
  return rows;
}

const Set<String> _injectedSources = {
  'skill',
  'cron',
  'subagent',
  'goal',
  'hook',
  'system',
  'compaction',
  'file-change',
};

TranscriptRow? _rowOf(Object? record) {
  if (record is! Map<String, Object?>) return null;
  if (record['type'] != 'event') return null;
  final event = record['event'];
  if (event is! Map<String, Object?>) return null;
  final type = event['type'];
  final seq = event['seq'];
  if (type is! String || seq is! num) return null;
  final data = event['data'];
  final payload = data is Map<String, Object?> ? data : const <String, Object?>{};

  switch (type) {
    case 'user/message':
      final text = _textOf(payload['content']);
      if (text.isEmpty) return null;
      final source = payload['source'];
      final kind = source is Map<String, Object?> ? '${source['kind']}' : '';
      return UserRow(seq: seq.toInt(), text: text, injected: _injectedSources.contains(kind));
    case 'assistant/message':
      final message = payload['message'];
      final content = message is Map<String, Object?> ? message['content'] : null;
      final text = _textOf(content, blockType: 'text');
      final reasoning = _textOf(content, blockType: 'reasoning');
      if (text.isEmpty && reasoning.isEmpty) return null;
      return AssistantRow(
        seq: seq.toInt(),
        text: text,
        reasoning: reasoning.isEmpty ? null : reasoning,
      );
    case 'tool/call':
      final name = payload['name'];
      final arguments = payload['arguments'];
      return ToolCallRow(
        seq: seq.toInt(),
        name: name is String ? name : 'tool',
        arguments: arguments is String ? arguments : '',
      );
    case 'tool/result':
      final message = payload['message'];
      final content = message is Map<String, Object?> ? message['content'] : null;
      final text = _textOf(content);
      final isError = message is Map<String, Object?> && message['isError'] == true;
      if (text.isEmpty && !isError) return null;
      return ToolResultRow(seq: seq.toInt(), text: text, isError: isError);
    case 'turn/end':
      final reason = payload['reason'];
      final kind = reason is Map<String, Object?> ? reason['kind'] : null;
      if (kind == null || kind == 'completed' || kind == 'aborted') return null;
      final error = reason is Map<String, Object?> ? reason['error'] : null;
      final message = error is Map<String, Object?> ? error['message'] : null;
      return NoticeRow(
        seq: seq.toInt(),
        text: message is String ? message : 'the turn ended: $kind',
        isError: true,
      );
    default:
      return null;
  }
}

/// Concatenates the text blocks of a content array.
String _textOf(Object? content, {String blockType = 'text'}) {
  if (content is! List) return '';
  final parts = <String>[];
  for (final block in content) {
    if (block is! Map<String, Object?>) continue;
    if (block['type'] != blockType) continue;
    final text = block['text'];
    if (text is String && text.isNotEmpty) parts.add(text);
  }
  return parts.join('\n').trim();
}

/// The assistant text of one attempt that is still being written.
///
/// DSH streams process-local `assistant-stream` frames before the attempt is
/// committed as an `assistant/message` event. Rendering them is what makes the
/// turn visible while it runs; they are dropped again as soon as the durable
/// message arrives, because that message is the copy that survives a reload.
class LiveDraft {
  LiveDraft({required this.attemptId});

  final String attemptId;
  final StringBuffer text = StringBuffer();
  final StringBuffer reasoning = StringBuffer();
  bool ended = false;

  bool get isEmpty => text.isEmpty && reasoning.isEmpty;

  /// Applies one `StreamChunk`; unknown chunk kinds are ignored on purpose.
  void applyChunk(Object? value) {
    if (value is! Map<String, Object?>) return;
    switch (value['type']) {
      case 'text-delta':
        final delta = value['text'];
        if (delta is String) text.write(delta);
      case 'reasoning-delta':
        final delta = value['text'];
        if (delta is String) reasoning.write(delta);
      // Tool arguments stream in as partial JSON, which cannot be rendered as
      // a call until the durable `tool/call` event commits it.
      default:
        break;
    }
  }
}

/// One decoded `assistant-stream` frame: a start, a chunk, or an end marker.
class LiveFrame {
  const LiveFrame({required this.kind, required this.attemptId, this.chunk});

  final String kind;
  final String attemptId;
  final Object? chunk;
}

/// Reads an `assistant-stream` follow frame, or returns null for other frames.
LiveFrame? readLiveFrame(Map<String, Object?> frame) {
  if (frame['type'] != 'assistant-stream') return null;
  final inner = frame['frame'];
  if (inner is! Map<String, Object?>) return null;
  final kind = inner['type'];
  final attemptId = inner['attemptId'];
  if (kind is! String || attemptId is! String) return null;
  return LiveFrame(kind: kind, attemptId: attemptId, chunk: inner['chunk']);
}

/// A live, encrypted link to one Host, with the DSH calls the phone makes.
///
/// Every method here is a thin wrapper over one Typert endpoint; the arguments
/// are spelled exactly as the Host's descriptors require, because the gateway
/// validates parameter names.
class HostLink {
  HostLink._(this._client, this.ticket);

  final LinkClient _client;
  final PairingTicket ticket;

  String get hostName => ticket.hostName;
  String get hostDeviceId => ticket.hostDeviceId;

  /// Whether this link is direct on the network or relayed across the internet.
  LinkRoute get route => _client.route;

  /// Where it connected, for the status line.
  String get endpoint => _client.endpoint;

  static Future<HostLink> connect(
    PairingTicket ticket,
    DeviceIdentity identity, {
    Duration timeout = const Duration(seconds: 10),
  }) async {
    final client = await LinkClient.connect(ticket, identity, timeout: timeout);
    return HostLink._(client, ticket);
  }

  /// Sessions ordered by activity, as the desktop sidebar shows them.
  Future<List<SessionSummary>> sessions() async {
    final value = await _client.rpc.call('session/list', const {'_request': <String, Object?>{}});
    final items = value['items'];
    if (items is! List) return const [];
    final summaries = <SessionSummary>[];
    for (final item in items) {
      final summary = SessionSummary.fromJson(item);
      if (summary != null) summaries.add(summary);
    }
    return summaries;
  }

  /// Creates a fresh session, optionally in [cwd].
  Future<String> createSession({String? cwd}) async {
    final value = await _client.rpc.call('session/create', {
      'request': {'cwd': ?cwd},
    });
    final id = value['sessionId'];
    if (id is! String || id.isEmpty) throw StateError('the Host did not return a session id');
    return id;
  }

  /// Follows one session, yielding the opening snapshot and then live frames.
  ///
  /// `activate` is required: without it DSH keeps the stream open but never
  /// sends a frame, because following is not supposed to wake an idle agent.
  /// `assistantStream` opts into process-local token frames so the phone can
  /// show text while the model is still writing.
  Stream<Map<String, Object?>> follow(String sessionId, {int maxMessages = 40}) {
    return _client.openStream('session/follow', {
      'request': {
        'address': {'kind': 'session', 'sessionId': sessionId},
        'maxMessages': maxMessages,
        'activate': true,
        'assistantStream': true,
      },
    });
  }

  /// Loads one page of older history, for scrolling up.
  Future<Map<String, Object?>> page(String sessionId, {required int beforeSeq, int maxMessages = 40}) {
    return _client.rpc.call('session/page', {
      'request': {
        'address': {'kind': 'session', 'sessionId': sessionId},
        'beforeSeq': beforeSeq,
        'maxMessages': maxMessages,
      },
    });
  }

  /// Sends a prompt to a session.
  ///
  /// [mode] is `queue` while the agent is working and `steer` to interrupt it,
  /// mirroring the desktop composer's two buttons.
  Future<void> prompt(String sessionId, String text, {String mode = 'queue'}) async {
    await _client.rpc.call('session/prompt', {
      'request': {
        'requestId': newDeviceId(),
        'sessionId': sessionId,
        'mode': mode,
        'content': [
          {'type': 'text', 'text': text},
        ],
      },
    });
  }

  /// Stops the running turn, keeping the session usable.
  Future<void> cancel(String sessionId) async {
    await _client.rpc.call('session/cancel', {
      'request': {'sessionId': sessionId},
    });
  }

  /// The questions this Host is waiting on, as they arrive.
  ///
  /// Call [startQuestions] once before listening. DSH hands a pending approval
  /// to whichever client claimed the event stream, so the subscription is kept
  /// for the life of the link: dropping it would silently push every future
  /// approval back to the desktop.
  Stream<PendingQuestion> get questions => _questions.stream;

  final StreamController<PendingQuestion> _questions = StreamController<PendingQuestion>.broadcast();
  RemoteEvents? _events;
  Future<void>? _starting;
  bool _questionStreamDead = false;

  /// Opens the forwarded-event stream. Safe to call twice.
  ///
  /// A Host that refuses it (older Harness, or one whose gateway has no event
  /// carrier) leaves [questions] empty rather than failing the whole link, so the
  /// phone still reads and writes sessions; only approvals stay on the desktop.
  Future<void> startQuestions() {
    return _starting ??= _openQuestions();
  }

  Future<void> _openQuestions() async {
    try {
      final events = _events = await RemoteEvents.open(_client.rpc);
      events.invocations.listen((invocation) {
        final question = readQuestion(invocation);
        if (question == null) {
          // Unrenderable questions go back to the desktop rather than hanging:
          // an unanswered waterfall would block the turn forever.
          unawaited(events.answer(invocation, delegate: true));
          return;
        }
        if (events.isCancelled(invocation)) return;
        if (!_questions.isClosed) _questions.add(question);
      }, onError: (Object error, StackTrace stack) {
        _questionStreamDead = true;
        if (!_questions.isClosed) _questions.addError(error, stack);
      });
    } catch (error) {
      _questionStreamDead = true;
      _questions.addError(error);
    }
  }

  /// Whether the Host refuses to forward questions to this phone.
  bool get questionsUnavailable => _questionStreamDead;

  /// Approves one tool run for this call only.
  Future<void> approve(PendingQuestion question) async {
    final events = _events;
    if (events == null) throw StateError('the question stream is not open');
    await events.answer(question.invocation, value: approvalAllowedOnce);
  }

  /// Refuses one tool run.
  Future<void> reject(PendingQuestion question) async {
    final events = _events;
    if (events == null) throw StateError('the question stream is not open');
    await events.answer(question.invocation, value: approvalRejected);
  }

  /// Answers a multiple-choice question.
  Future<void> answerChoice(
    ChoiceQuestion question,
    Map<String, List<String>> selections, {
    Map<String, String> custom = const {},
  }) async {
    final events = _events;
    if (events == null) throw StateError('the question stream is not open');
    await events.answer(question.invocation, value: question.answerValue(selections, custom: custom));
  }

  /// Hands a question to the next listener, i.e. the desktop.
  Future<void> delegate(PendingQuestion question) async {
    final events = _events;
    if (events == null) throw StateError('the question stream is not open');
    await events.answer(question.invocation, delegate: true);
  }

  Future<void> close() async {
    await _events?.close();
    _events = null;
    if (!_questions.isClosed) await _questions.close();
    await _client.close();
  }
}
