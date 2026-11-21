import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

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

/// One agent preset the Host offers for new sessions.
class AgentPreset {
  const AgentPreset({
    required this.id,
    this.name,
    this.description,
    this.isDefault = false,
  });

  final String id;
  final String? name;
  final String? description;
  final bool isDefault;

  /// What to show in a picker: the display name when the Host has one, because
  /// several built-in presets ship with an id and nothing else.
  String get label => name ?? id;

  /// Reads one entry of `agentPresets/list`.
  static AgentPreset? fromJson(Object? value) {
    if (value is! Map<String, Object?>) return null;
    final id = value['id'];
    if (id is! String || id.isEmpty) return null;
    final name = value['name'];
    final description = value['description'];
    return AgentPreset(
      id: id,
      name: name is String && name.isNotEmpty ? name : null,
      description: description is String && description.isNotEmpty ? description : null,
      isDefault: value['isDefault'] == true,
    );
  }
}

/// Filters sessions by a lowercase needle against the title and the directory.
///
/// The Host hands the whole session list over at once, so this is what makes
/// hundreds of sessions navigable even when the deployment disables the Host's
/// own content index. It lives beside the model rather than inside the page so
/// the matching rules can be tested without a widget tree.
List<SessionSummary> filterSessions(List<SessionSummary> sessions, String query) {
  final needle = query.trim().toLowerCase();
  if (needle.isEmpty) return const [];
  return sessions
      .where(
        (session) =>
            session.title.toLowerCase().contains(needle) ||
            (session.cwd?.toLowerCase().contains(needle) ?? false),
      )
      .toList();
}

/// One skill the session can invoke as `/name`.
///
/// The catalog is session-addressed: the Host resolves it from the session's
/// working directory and agent preset, so the same phone shows different skills
/// in different sessions, and the list is exactly what the model would see.
class SkillEntry {
  const SkillEntry({
    required this.name,
    required this.description,
    this.whenToUse,
    this.path,
    this.modelInvocable = false,
  });

  /// Kebab-case identifier, invoked as `/name`.
  final String name;
  final String description;
  final String? whenToUse;

  /// Absolute SKILL.md path when a filesystem provider supplies one.
  final String? path;

  /// Whether the model can also reach this skill on its own.
  final bool modelInvocable;

  static SkillEntry? fromJson(Object? value) {
    if (value is! Map<String, Object?>) return null;
    final name = value['name'];
    if (name is! String || name.isEmpty) return null;
    final description = value['description'];
    final whenToUse = value['whenToUse'];
    final path = value['path'];
    return SkillEntry(
      name: name,
      description: description is String ? description : '',
      whenToUse: whenToUse is String && whenToUse.isNotEmpty ? whenToUse : null,
      path: path is String && path.isNotEmpty ? path : null,
      modelInvocable: value['modelInvocable'] == true,
    );
  }
}

/// Filters skills by name, description, or when-to-use guidance.
List<SkillEntry> filterSkills(List<SkillEntry> skills, String query) {
  final needle = query.trim().toLowerCase();
  if (needle.isEmpty) return skills;
  return skills
      .where(
        (skill) =>
            skill.name.toLowerCase().contains(needle) ||
            skill.description.toLowerCase().contains(needle) ||
            (skill.whenToUse?.toLowerCase().contains(needle) ?? false),
      )
      .toList();
}

/// One session whose message content matched a search.
class SessionHit {
  const SessionHit({required this.sessionId, required this.snippet});

  final String sessionId;

  /// The matching text, as the Host excerpted it.
  final String snippet;

  static SessionHit? fromJson(Object? value) {
    if (value is! Map<String, Object?>) return null;
    final id = value['sessionId'];
    final snippet = value['snippet'];
    if (id is! String || id.isEmpty) return null;
    return SessionHit(sessionId: id, snippet: snippet is String ? snippet : '');
  }
}

/// What one search returned, including whether the Host truncated it.
class SessionSearchResult {
  const SessionSearchResult({this.hits = const [], this.hasMore = false});

  final List<SessionHit> hits;

  /// True when more sessions matched than the Host was willing to return.
  final bool hasMore;

  static SessionSearchResult fromJson(Map<String, Object?> value) {
    final items = value['items'];
    if (items is! List) return const SessionSearchResult();
    final hits = <SessionHit>[];
    for (final item in items) {
      final hit = SessionHit.fromJson(item);
      if (hit != null) hits.add(hit);
    }
    return SessionSearchResult(hits: hits, hasMore: value['hasMore'] == true);
  }
}

/// One model the Host can route to.
class ModelChoice {
  const ModelChoice({
    required this.provider,
    required this.providerName,
    required this.model,
    required this.name,
    this.description,
    this.efforts = const [],
    this.defaultEffort,
  });

  final String provider;
  final String providerName;
  final String model;
  final String name;
  final String? description;

  /// Reasoning efforts this exact route accepts, in provider order.
  final List<ModelEffort> efforts;
  final String? defaultEffort;

  String get label => '$name · $providerName';
}

/// One reasoning effort a model accepts.
class ModelEffort {
  const ModelEffort({required this.id, required this.name, this.description});

  final String id;
  final String name;
  final String? description;
}

/// The whole catalog, flattened for a picker.
class ModelCatalog {
  const ModelCatalog({required this.choices, required this.defaultChoice});

  final List<ModelChoice> choices;

  /// What the Host picks for a session that has never chosen; may be absent
  /// from [choices] when its provider is currently unroutable.
  final ({String provider, String model})? defaultChoice;

  /// Reads `session/modelCatalog`. Every provider group is flattened, because a
  /// phone picker shows one flat list rather than the desktop's grouped menu.
  static ModelCatalog fromJson(Map<String, Object?> value) {
    final choices = <ModelChoice>[];
    final groups = value['groups'];
    if (groups is List) {
      for (final group in groups) {
        if (group is! Map<String, Object?>) continue;
        final provider = group['id'];
        final providerName = group['name'];
        final models = group['models'];
        if (provider is! String || models is! List) continue;
        for (final model in models) {
          if (model is! Map<String, Object?>) continue;
          final id = model['id'];
          if (id is! String) continue;
          final reasoning = model['reasoning'];
          final efforts = <ModelEffort>[];
          String? defaultEffort;
          if (reasoning is Map<String, Object?>) {
            final raw = reasoning['efforts'];
            if (raw is List) {
              for (final effort in raw) {
                if (effort is! Map<String, Object?>) continue;
                final effortId = effort['id'];
                if (effortId is! String) continue;
                efforts.add(ModelEffort(
                  id: effortId,
                  name: effort['name'] is String ? effort['name']! as String : effortId,
                  description: effort['description'] is String ? effort['description']! as String : null,
                ));
              }
            }
            final fallback = reasoning['defaultEffort'];
            if (fallback is String) defaultEffort = fallback;
          }
          choices.add(ModelChoice(
            provider: provider,
            providerName: providerName is String ? providerName : provider,
            model: id,
            name: model['name'] is String ? model['name']! as String : id,
            description: model['description'] is String ? model['description']! as String : null,
            efforts: efforts,
            defaultEffort: defaultEffort,
          ));
        }
      }
    }
    final fallback = value['default'];
    ({String provider, String model})? defaultChoice;
    if (fallback is Map<String, Object?>) {
      final provider = fallback['provider'];
      final model = fallback['model'];
      if (provider is String && model is String) {
        defaultChoice = (provider: provider, model: model);
      }
    }
    return ModelCatalog(choices: choices, defaultChoice: defaultChoice);
  }
}

/// The model route a session is currently using.
class ModelSelection {
  const ModelSelection({required this.provider, required this.model, this.reasoningEffort});

  final String provider;
  final String model;
  final String? reasoningEffort;

  /// Reads a model route from either shape DSH returns.
  ///
  /// `session/projections` nests two routes under `modelSelection`: `next` is
  /// what the following turn will use, `lastUsed` what the previous one did.
  /// `session/selectModel` instead answers with the route itself, flat. The
  /// picker shows `next`, because that is what a change would replace.
  static ModelSelection? fromProjections(Object? value) {
    if (value is! Map<String, Object?>) return null;
    final map = value['provider'] is String ? value : (value['next'] ?? value['lastUsed']);
    if (map is! Map<String, Object?>) return null;
    final provider = map['provider'];
    final model = map['model'];
    if (provider is! String || model is! String) return null;
    final effort = map['reasoningEffort'];
    return ModelSelection(
      provider: provider,
      model: model,
      reasoningEffort: effort is String ? effort : null,
    );
  }
}

/// One image a message refers to, addressed by the Host's attachment store.
///
/// The bytes are not in the event: DSH stores the image once and records a
/// reference, and the phone fetches it with `session/attachment` when it needs
/// to paint it. That keeps history small and lets the same image be reused.
class ImageAttachment {
  const ImageAttachment({
    required this.attachmentId,
    required this.mediaType,
    required this.bytes,
    this.width,
    this.height,
    this.name,
  });

  final String attachmentId;
  final String mediaType;
  final int bytes;
  final int? width;
  final int? height;
  final String? name;

  static ImageAttachment? fromJson(Object? value) {
    if (value is! Map<String, Object?>) return null;
    final id = value['attachmentId'];
    final mediaType = value['mediaType'];
    if (id is! String || id.isEmpty || mediaType is! String) return null;
    final size = value['bytes'];
    final width = value['width'];
    final height = value['height'];
    final name = value['name'];
    return ImageAttachment(
      attachmentId: id,
      mediaType: mediaType,
      bytes: size is num ? size.toInt() : 0,
      width: width is num ? width.toInt() : null,
      height: height is num ? height.toInt() : null,
      name: name is String && name.isNotEmpty ? name : null,
    );
  }

  /// The reference shape `session/attachment` expects back.
  Map<String, Object?> toJson() => {
    'attachmentId': attachmentId,
    'mediaType': mediaType,
    'bytes': bytes,
    if (width != null) 'width': width,
    if (height != null) 'height': height,
    if (name != null) 'name': name,
  };
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
  const UserRow({
    required super.seq,
    required this.text,
    this.injected = false,
    this.images = const [],
  });

  final String text;

  /// Whether DSH attributed this to the agent rather than to the person.
  final bool injected;

  /// Images the person attached, in the order they were sent.
  final List<ImageAttachment> images;
}

class AssistantRow extends TranscriptRow {
  const AssistantRow({
    required super.seq,
    required this.text,
    this.reasoning,
    this.images = const [],
  });

  final String text;
  final String? reasoning;
  final List<ImageAttachment> images;
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
      final images = _imagesOf(payload['content']);
      if (text.isEmpty && images.isEmpty) return null;
      final source = payload['source'];
      final kind = source is Map<String, Object?> ? '${source['kind']}' : '';
      return UserRow(
        seq: seq.toInt(),
        text: text,
        injected: _injectedSources.contains(kind),
        images: images,
      );
    case 'assistant/message':
      final message = payload['message'];
      final content = message is Map<String, Object?> ? message['content'] : null;
      final text = _textOf(content, blockType: 'text');
      final reasoning = _textOf(content, blockType: 'reasoning');
      final images = _imagesOf(content);
      if (text.isEmpty && reasoning.isEmpty && images.isEmpty) return null;
      return AssistantRow(
        seq: seq.toInt(),
        text: text,
        reasoning: reasoning.isEmpty ? null : reasoning,
        images: images,
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

/// Collects the image references of a content array.
List<ImageAttachment> _imagesOf(Object? content) {
  if (content is! List) return const [];
  final images = <ImageAttachment>[];
  for (final block in content) {
    if (block is! Map<String, Object?>) continue;
    if (block['type'] != 'image') continue;
    final image = ImageAttachment.fromJson(block['attachment']);
    if (image != null) images.add(image);
  }
  return images;
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

  /// Creates a fresh session, optionally in [cwd] and with an agent preset.
  Future<String> createSession({String? cwd, String? agentPreset}) async {
    final value = await _client.rpc.call('session/create', {
      'request': {'cwd': ?cwd, 'agentPreset': ?agentPreset},
    });
    final id = value['sessionId'];
    if (id is! String || id.isEmpty) throw StateError('the Host did not return a session id');
    return id;
  }

  /// Every agent preset this Host offers for new sessions.
  ///
  /// The namespace is `agentPresets`, not `agentPreset`; the gateway rejects the
  /// kebab-case spelling with `no active Remote method exports this endpoint`.
  Future<List<AgentPreset>> presets() async {
    final value = await _client.rpc.call('agentPresets/list', const {});
    final entries = value['presets'];
    if (entries is! List) return const [];
    final presets = <AgentPreset>[];
    for (final entry in entries) {
      final preset = AgentPreset.fromJson(entry);
      if (preset != null) presets.add(preset);
    }
    return presets;
  }

  /// Searches message content across every session.
  ///
  /// A Host with hundreds of sessions cannot be browsed by scrolling, and the
  /// list is ordered by activity, so anything older than the first screenful is
  /// effectively unreachable without this. The Host caps the result at 20 and
  /// reports whether more matched, so the UI says so rather than pretending the
  /// list is complete.
  Future<SessionSearchResult> search(String query) async {
    final value = await _client.rpc.call('session/search', {
      'request': {'query': query},
    });
    return SessionSearchResult.fromJson(value);
  }

  /// Lists the skills this session can invoke.
  ///
  /// The namespace is `skills`, not `session/skills`: the Host mounts a separate
  /// session-addressed catalog service for it.
  Future<List<SkillEntry>> skills(String sessionId) async {
    final value = await _client.rpc.call('skills/list', {
      'request': {'sessionId': sessionId},
    });
    final entries = value['skills'];
    if (entries is! List) return const [];
    final skills = <SkillEntry>[];
    for (final entry in entries) {
      final skill = SkillEntry.fromJson(entry);
      if (skill != null) skills.add(skill);
    }
    return skills;
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
  Future<void> prompt(String sessionId, String text, {String mode = 'queue'}) {
    return promptContent(sessionId, [
      {'type': 'text', 'text': text},
    ], mode: mode);
  }

  /// Sends one prompt with arbitrary content parts.
  ///
  /// DSH accepts text and image parts together in one message; the Host promotes
  /// the base64 payload to a durable attachment, so this is the same path the
  /// desktop uses for drag-and-drop.
  Future<void> promptContent(
    String sessionId,
    List<Map<String, Object?>> content, {
    String mode = 'queue',
  }) async {
    await _client.rpc.call('session/prompt', {
      'request': {
        'requestId': newDeviceId(),
        'sessionId': sessionId,
        'mode': mode,
        'content': content,
      },
    });
  }

  /// Fetches the bytes behind one image reference.
  ///
  /// The Host answers with base64 because the wire is JSON; the phone only ever
  /// asks for images it is about to paint.
  Future<Uint8List> attachment(String sessionId, ImageAttachment image) async {
    final value = await _client.rpc.call('session/attachment', {
      'request': {'sessionId': sessionId, 'attachment': image.toJson()},
    });
    final data = value['data'];
    if (data is! String || data.isEmpty) {
      throw StateError('the Host did not return the image bytes');
    }
    return base64Decode(data);
  }

  /// Stops the running turn, keeping the session usable.
  Future<void> cancel(String sessionId) async {
    await _client.rpc.call('session/cancel', {
      'request': {'sessionId': sessionId},
    });
  }

  /// Every model this Host can route to right now.
  Future<ModelCatalog> modelCatalog() async {
    final value = await _client.rpc.call('session/modelCatalog', const {});
    return ModelCatalog.fromJson(value);
  }

  /// The model route one session is currently on, or null when the Host has not
  /// projected one yet (a brand-new session before its first turn).
  Future<ModelSelection?> selection(String sessionId) async {
    final value = await _client.rpc.call('session/projections', {
      'request': {'sessionId': sessionId},
    });
    final values = value['values'];
    return ModelSelection.fromProjections(values);
  }

  /// Points one session at [choice], optionally pinning a reasoning effort.
  ///
  /// This is a per-session override: the Host's own default stays untouched, so
  /// a new session still starts where the desktop would.
  Future<ModelSelection> selectModel(
    String sessionId,
    ModelChoice choice, {
    String? reasoningEffort,
  }) async {
    final value = await _client.rpc.call('session/selectModel', {
      'request': {
        'sessionId': sessionId,
        'provider': choice.provider,
        'model': choice.model,
        'reasoningEffort': ?reasoningEffort,
      },
    });
    final selected = ModelSelection.fromProjections(value['selected']);
    if (selected == null) throw StateError('the Host did not confirm the model selection');
    return selected;
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
