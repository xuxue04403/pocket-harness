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
    this.agentAvailable = true,
    this.blank = false,
    this.lastPromptAt,
    this.origin,
  });

  final String sessionId;
  final String title;
  final DateTime updatedAt;
  final bool running;
  final String? cwd;

  /// Whether an agent is attached to this session *right now*.
  ///
  /// This is not "has this session ever had an agent": the Host computes it as
  /// `agents.get(id)?.session === session`, so every session reads false the
  /// moment the Host restarts, and a cold row is hard-coded false. Filtering on
  /// it looked right while one long-running Host had an agent parked in the
  /// folder and would have emptied the whole list after a restart.
  final bool agentAvailable;

  /// Whether no turn has ever started here — "new session" makes one of these.
  ///
  /// Not the filter either: an abandoned prompt has already started a turn, so
  /// the seven ghost sessions all read `blank: false` just like real ones.
  final bool blank;

  /// When a person last sent a message into this session, or null if never.
  ///
  /// This is the only durable answer to "did somebody actually use this". The
  /// Host advances it on `user/message` events whose source is the user, so it
  /// survives restarts, and the ghost sessions — a system prompt delivered
  /// into a fresh session that then died before the agent attached — never
  /// collect one. A directory showed nine rows on the phone for exactly the
  /// two that the desktop lists, and this is what tells them apart.
  final DateTime? lastPromptAt;

  /// Whether a person has ever sent anything here.
  bool get used => lastPromptAt != null;

  /// What started this session: `subagent` for one an agent spawned itself.
  ///
  /// A subagent session carries the prompt its parent wrote, so it collects a
  /// `lastPromptAt` of its own and would otherwise pass every "somebody used
  /// this" test. The desktop sidebar drops them by origin and shows them
  /// nested under the parent instead; the phone has no nesting yet, so it drops
  /// them too rather than listing 334 internal work sessions as projects.
  final String? origin;

  /// Whether an agent opened this session on its own, rather than a person.
  bool get spawned => origin == 'subagent';

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
    // Not every row carries `projections` — the ones that never got an agent
    // come back with only the top-level fields, and the directory is in `cwd`
    // there. Reading the nested key alone filed those sessions under "no
    // directory", which is the other half of why the phone's tree did not look
    // like the computer's.
    final directory = workingDirectory is String && workingDirectory.isNotEmpty
        ? workingDirectory
        : value['cwd'] is String && (value['cwd'] as String).isNotEmpty
        ? value['cwd'] as String
        : null;
    final metadata = map['sessionListMetadata'];
    final prompted = metadata is Map<String, Object?> ? metadata['lastPromptAt'] : null;
    final updated = value['updatedAt'];
    return SessionSummary(
      sessionId: id,
      title: title is String && title.isNotEmpty ? title : '未命名会话',
      updatedAt: updated is num
          ? DateTime.fromMillisecondsSinceEpoch(updated.toInt())
          : DateTime.fromMillisecondsSinceEpoch(0),
      running: value['running'] == true,
      cwd: directory,
      agentAvailable: value['agentAvailable'] != false,
      blank: value['blank'] == true,
      lastPromptAt: prompted is num
          ? DateTime.fromMillisecondsSinceEpoch(prompted.toInt())
          : null,
      origin: value['origin'] is String ? value['origin'] as String : null,
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

/// One line of the agent's todo list.
///
/// DSH replaces the whole list on every `todo/write`, so an item needs no id:
/// the newest snapshot is the truth. Three statuses are all the desktop shows,
/// and they are what makes the panel worth reading — a list where everything is
/// `pending` says nothing, while one with a single `in_progress` line says what
/// the agent is doing right now.
class TodoItem {
  const TodoItem({required this.content, required this.status});

  final String content;

  /// `pending`, `in_progress` or `completed`; unknown values are kept verbatim
  /// so a newer Host does not make the panel disappear.
  final String status;

  bool get isDone => status == 'completed';
  bool get isRunning => status == 'in_progress';

  static TodoItem? fromJson(Object? value) {
    if (value is! Map<String, Object?>) return null;
    final content = value['content'];
    if (content is! String || content.trim().isEmpty) return null;
    final status = value['status'];
    return TodoItem(content: content.trim(), status: status is String ? status : 'pending');
  }
}

/// Reads the todo list out of a `session/projections` value bag.
///
/// `todos` is `null` before the first write, which is different from an empty
/// list: the panel stays hidden rather than claiming the agent has no plan.
List<TodoItem>? readTodos(Object? projectionsValues) {
  if (projectionsValues is! Map<String, Object?>) return null;
  final raw = projectionsValues['todos'];
  if (raw is! List) return null;
  final items = <TodoItem>[];
  for (final entry in raw) {
    final item = TodoItem.fromJson(entry);
    if (item != null) items.add(item);
  }
  return items;
}

/// Reads the todo list out of a `todo/write` event payload.
List<TodoItem> readTodoWrite(Object? payload) {
  if (payload is! Map<String, Object?>) return const [];
  final raw = payload['todos'];
  if (raw is! List) return const [];
  final items = <TodoItem>[];
  for (final entry in raw) {
    final item = TodoItem.fromJson(entry);
    if (item != null) items.add(item);
  }
  return items;
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

/// One configuration namespace as the Host resolves it right now.
///
/// DSH layers configuration (declared defaults, the profile document, the
/// environment) and resolves it per namespace. [value] is the result of that
/// layering, which is what a new session would inherit; [base] is what the
/// providers declare and [user] is only what this profile wrote.
class SettingsNamespace {
  const SettingsNamespace({
    required this.ns,
    required this.value,
    required this.revision,
    this.base = const {},
    this.user = const {},
    this.applies,
    this.secrets = const [],
  });

  final String ns;
  final Map<String, Object?> value;
  final Map<String, Object?> base;
  final Map<String, Object?> user;
  final int revision;

  /// How a write takes effect: DSH reports `live` for values it re-reads.
  final String? applies;

  /// Field names the Host redacted, so the phone can say "已在电脑上设置"
  /// instead of showing an empty box the person cannot fill.
  final List<String> secrets;

  static SettingsNamespace? fromJson(Object? input) {
    if (input is! Map<String, Object?>) return null;
    final ns = input['ns'];
    if (ns is! String || ns.isEmpty) return null;
    Map<String, Object?> map(Object? value) =>
        value is Map<String, Object?> ? value : const <String, Object?>{};
    final revision = input['revision'];
    final secrets = input['secrets'];
    final applies = input['applies'];
    return SettingsNamespace(
      ns: ns,
      value: map(input['value']),
      base: map(input['base']),
      user: map(input['user']),
      revision: revision is num ? revision.toInt() : 0,
      applies: applies is String ? applies : null,
      secrets: secrets is List ? [for (final name in secrets) if (name is String) name] : const [],
    );
  }
}

/// Everything `settings/describe` returned.
class SettingsSnapshot {
  const SettingsSnapshot({
    required this.writable,
    required this.namespaces,
  });

  /// False when the profile's settings document is read-only, in which case the
  /// phone must not offer to edit anything.
  final bool writable;
  final List<SettingsNamespace> namespaces;

  /// Looks one namespace up, or returns null when this Host has no such section.
  SettingsNamespace? find(String ns) {
    for (final namespace in namespaces) {
      if (namespace.ns == ns) return namespace;
    }
    return null;
  }

  static SettingsSnapshot fromJson(Map<String, Object?> value) {
    final namespaces = value['namespaces'];
    return SettingsSnapshot(
      writable: value['writable'] == true,
      namespaces: [
        if (namespaces is List)
          for (final entry in namespaces) ?SettingsNamespace.fromJson(entry),
      ],
    );
  }
}

/// One direct child of a workspace directory.
class WorkspaceEntry {
  const WorkspaceEntry({required this.name, required this.type, this.size});

  final String name;

  /// `directory` or `file`, as the Host reports it.
  final String type;
  final int? size;

  bool get isDirectory => type == 'directory';

  static WorkspaceEntry? fromJson(Object? input) {
    if (input is! Map<String, Object?>) return null;
    final name = input['name'];
    if (name is! String || name.isEmpty) return null;
    final type = input['type'];
    final size = input['size'];
    return WorkspaceEntry(
      name: name,
      type: type is String ? type : 'file',
      size: size is num ? size.toInt() : null,
    );
  }
}

/// One directory listing, keyed by the workspace-relative path it describes.
class WorkspaceListing {
  const WorkspaceListing({
    required this.path,
    required this.entries,
    required this.truncated,
  });

  /// Empty for the workspace root, `/`-joined below it.
  final String path;
  final List<WorkspaceEntry> entries;

  /// True when the Host's entry cap dropped children from [entries].
  final bool truncated;

  static WorkspaceListing fromJson(Map<String, Object?> value) {
    final entries = value['entries'];
    final path = value['path'];
    return WorkspaceListing(
      path: path is String ? path : '',
      entries: [
        if (entries is List)
          for (final entry in entries) ?WorkspaceEntry.fromJson(entry),
      ],
      truncated: value['truncated'] == true,
    );
  }
}

/// One page of a text file.
///
/// [eof] reports whether the page reaches the last line, so the reader knows a
/// short page means "done" rather than "the Host is still working".
class WorkspaceFileText {
  const WorkspaceFileText({
    required this.absolutePath,
    required this.text,
    required this.offset,
    required this.lines,
    required this.bytes,
    required this.eof,
  });

  final String absolutePath;
  final String text;
  final int offset;
  final int lines;
  final int bytes;
  final bool eof;

  static WorkspaceFileText fromJson(Map<String, Object?> value) {
    int number(Object? input) => input is num ? input.toInt() : 0;
    final path = value['absolutePath'];
    final text = value['text'];
    return WorkspaceFileText(
      absolutePath: path is String ? path : '',
      text: text is String ? text : '',
      offset: number(value['offset']),
      lines: number(value['lines']),
      bytes: number(value['bytes']),
      eof: value['eof'] == true,
    );
  }
}

/// One instruction file the agent loads, as the Host reports it.
class InstructionFile {
  const InstructionFile({
    required this.scope,
    required this.label,
    required this.path,
    required this.name,
    required this.bytes,
  });

  /// `global` for the user chain, `project` for the workspace chain.
  final String scope;

  /// Where it sits: `~/.dsh` or a project-relative directory like `packages/app`.
  final String label;

  /// Absolute path on the computer; this is what read and write take.
  final String path;
  final String name;
  final int bytes;

  /// True for the files loaded from the user's own home rather than a project.
  bool get isGlobal => scope == 'global';

  static InstructionFile? fromJson(Object? value) {
    if (value is! Map) return null;
    final path = value['path'];
    final name = value['name'];
    if (path is! String || name is! String) return null;
    final scope = value['scope'];
    final label = value['label'];
    final bytes = value['bytes'];
    return InstructionFile(
      scope: scope is String ? scope : 'project',
      label: label is String ? label : '.',
      path: path,
      name: name,
      bytes: bytes is num ? bytes.toInt() : 0,
    );
  }
}

/// Every instruction file that applies to one session directory.
class InstructionsSnapshot {
  const InstructionsSnapshot({
    required this.projectRoot,
    required this.cwd,
    required this.files,
  });

  /// Null when the directory is not inside a project.
  final String? projectRoot;

  /// The session directory the listing was computed for, if any.
  final String? cwd;
  final List<InstructionFile> files;

  static InstructionsSnapshot fromJson(Map<String, Object?> value) {
    final root = value['projectRoot'];
    final cwd = value['cwd'];
    final files = value['files'];
    return InstructionsSnapshot(
      projectRoot: root is String ? root : null,
      cwd: cwd is String ? cwd : null,
      files: [
        if (files is List) for (final file in files) ?InstructionFile.fromJson(file),
      ],
    );
  }
}

/// One hit from a workspace-wide name search.
class WorkspaceMatch {
  const WorkspaceMatch({required this.path, required this.type});

  /// `/`-joined path relative to the workspace root, never empty.
  final String path;
  final String type;

  bool get isDirectory => type == 'directory';

  static WorkspaceMatch? fromJson(Object? input) {
    if (input is! Map<String, Object?>) return null;
    final path = input['path'];
    if (path is! String || path.isEmpty) return null;
    final type = input['type'];
    return WorkspaceMatch(path: path, type: type is String ? type : 'file');
  }
}

/// A live, encrypted link to one Host, with the DSH calls the phone makes.
/// Every method here is a thin wrapper over one Typert endpoint; the arguments
/// are spelled exactly as the Host's descriptors require, because the gateway
/// validates parameter names.
/// One background job the Host is running for this session.
class JobSummary {
  const JobSummary({
    required this.id,
    required this.kind,
    required this.label,
    required this.status,
    required this.startedAt,
    this.progress,
    this.detail,
    this.finishedAt,
  });

  final String id;
  final String kind;
  final String label;
  final String status;
  final String? progress;
  final String? detail;
  final DateTime? startedAt;
  final DateTime? finishedAt;

  /// A job is still occupying the Host while it runs or drains a stop request.
  bool get isLive => status == 'running' || status == 'stopping';

  /// Chinese label for the lifecycle, because the wire statuses are English.
  String get statusLabel => switch (status) {
    'running' => '运行中',
    'stopping' => '停止中',
    'completed' => '已完成',
    'killed' => '已终止',
    'failed' => '失败',
    _ => status,
  };

  static JobSummary? fromJson(Object? value) {
    if (value is! Map<String, Object?>) return null;
    final id = value['id'];
    if (id is! String || id.isEmpty) return null;
    final label = value['label'];
    final started = value['startedAt'];
    final finished = value['finishedAt'];
    final progress = value['progress'];
    final detail = value['detail'];
    final kind = value['kind'];
    return JobSummary(
      id: id,
      kind: kind is String ? kind : 'job',
      label: label is String && label.isNotEmpty ? label : id,
      status: value['status'] is String ? value['status']! as String : 'unknown',
      progress: progress is String && progress.isNotEmpty ? progress : null,
      detail: detail is String && detail.isNotEmpty ? detail : null,
      startedAt: started is num
          ? DateTime.fromMillisecondsSinceEpoch(started.toInt())
          : null,
      finishedAt: finished is num
          ? DateTime.fromMillisecondsSinceEpoch(finished.toInt())
          : null,
    );
  }
}

/// One frame of a job's output stream, flattened for the UI.
class JobOutputFrame {
  const JobOutputFrame({
    required this.kind,
    this.text = '',
    this.job,
    this.lossy = false,
  });

  /// `opened`, `output`, or `status`.
  final String kind;

  /// Text appended by this frame; empty for the opening and closing anchors.
  final String text;

  /// The job projection carried by `opened` and `status`.
  final JobSummary? job;

  /// Earlier bytes were already evicted when this frame was read.
  final bool lossy;

  static JobOutputFrame? fromJson(Map<String, Object?> frame) {
    final type = frame['type'];
    if (type is! String) return null;
    switch (type) {
      case 'opened':
      case 'status':
        return JobOutputFrame(
          kind: type,
          job: JobSummary.fromJson(frame['job']),
        );
      case 'output':
        final chunks = frame['chunks'];
        final buffer = StringBuffer();
        if (chunks is List) {
          for (final chunk in chunks) {
            if (chunk is Map && chunk['text'] is String) {
              buffer.write(chunk['text'] as String);
            }
          }
        }
        return JobOutputFrame(
          kind: type,
          text: buffer.toString(),
          lossy: frame['lossy'] == true,
        );
      default:
        return null;
    }
  }
}

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
    Duration relayTimeout = const Duration(seconds: 20),
  }) async {
    // The relay budget is longer on purpose: a LAN socket either answers in
    // milliseconds or is not there, while a relay waits for the Host to be
    // woken and dial in. Sharing one timeout would give up on mobile data.
    final client = await LinkClient.connect(
      ticket,
      identity,
      timeout: timeout,
      relayTimeout: relayTimeout,
    );
    return HostLink._(client, ticket);
  }

  /// Asks the Host where it can currently be reached.
  ///
  /// A saved ticket is a snapshot: the LAN address it carries is whatever DHCP
  /// handed out the day the phone scanned, and it may predate a relay being
  /// configured at all. The Host knows the live answer, and an already-paired
  /// phone can ask for it over the link it just established — including over the
  /// relay, which is exactly the case where the stale ticket hurt.
  ///
  /// Returns null when the Host does not answer the call (an older plugin, or a
  /// Host that refuses), so callers can keep using the ticket they have.
  Future<PairingTicket?> refreshTicket() async {
    try {
      final value = await _client.rpc.call('pocketPairing/refresh', const {});
      final encoded = value['ticket'];
      if (encoded is! String || encoded.isEmpty) return null;
      return PairingTicket.decode(encoded);
    } on Object {
      return null;
    }
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

  /// Renames one session, returning the title the Host normalized it to.
  ///
  /// The Host decides the final spelling (it trims and bounds the text), so the
  /// caller must show this value rather than what was typed.
  Future<String> rename(String sessionId, String title) async {
    final value = await _client.rpc.call('session/rename', {
      'request': {'sessionId': sessionId, 'title': title},
    });
    final accepted = value['title'];
    if (accepted is! String || accepted.isEmpty) return title.trim();
    return accepted;
  }

  /// Every model this Host can route to right now.
  Future<ModelCatalog> modelCatalog() async {
    final value = await _client.rpc.call('session/modelCatalog', const {});
    return ModelCatalog.fromJson(value);
  }

  /// Copies a session up to [atSeq] into a new one, returning its id.
  ///
  /// Omitting [atSeq] asks the Host for the latest completed turn, which is the
  /// case a phone wants: try a different direction without losing the transcript
  /// that led here. The source session is untouched, and the copy carries the
  /// same working directory and agent preset because the Host rebuilds it from
  /// the records it copied.
  Future<String> fork(String sessionId, {int? atSeq}) async {
    final value = await _client.rpc.call('session/fork', {
      'request': {'sessionId': sessionId, 'atSeq': ?atSeq},
    });
    final forked = value['sessionId'];
    if (forked is! String || forked.isEmpty) {
      throw StateError('the Host did not return the forked session');
    }
    return forked;
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

  /// Reads this session's todo list, for the panel above the transcript.
  ///
  /// Returns null when the agent has never written a list, so the panel can stay
  /// out of the way instead of showing an empty box.
  Future<List<TodoItem>?> todos(String sessionId) async {
    final value = await _client.rpc.call('session/projections', {
      'request': {'sessionId': sessionId},
    });
    return readTodos(value['values']);
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
      final events = await RemoteEvents.open(_client.rpc);
      // The link may have been closed while the stream was being opened; the
      // stream would then be orphaned on the Host and still claim approvals for
      // a phone that is gone, so hand it straight back.
      if (_questions.isClosed) {
        await events.close();
        return;
      }
      _events = events;
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
      if (!_questions.isClosed) _questions.addError(error);
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

  /// Every settings namespace this Host exposes, with its effective values.
  ///
  /// DSH layers configuration (defaults, the profile document, the environment)
  /// and resolves it per namespace; what comes back here is the resolved value a
  /// new session would inherit, which is what the phone needs to show.
  Future<SettingsSnapshot> settings() async {
    final value = await _client.rpc.call('settings/describe', const {});
    return SettingsSnapshot.fromJson(value);
  }

  /// Replaces one namespace's value.
  ///
  /// The revision the caller last read travels with the write: the Host rejects
  /// a stale one with `settings/conflict` rather than overwriting a change made
  /// on the desktop in the meantime.
  Future<SettingsNamespace> updateSetting(
    SettingsNamespace namespace,
    Map<String, Object?> value,
  ) async {
    final answer = await _client.rpc.call('settings/update', {
      'ns': namespace.ns,
      'patch': value,
      'expectedRevision': namespace.revision,
    });
    final updated = SettingsNamespace.fromJson(answer);
    if (updated == null) throw StateError('电脑没有返回更新后的设置');
    return updated;
  }

  /// Lists one directory of a session's workspace.
  ///
  /// `workspaceFiles/list` takes the Session id on the wire rather than a path,
  /// because the Host derives the workspace root from the Session itself: a
  /// phone can browse a workspace only through a session that owns it. An empty
  /// path is refused by the Host, so the root is asked for as `.`.
  Future<WorkspaceListing> listDirectory(String sessionId, String path) async {
    final value = await _client.rpc.call('workspaceFiles/list', {
      'workspaceFileScopeId': sessionId,
      'path': path.trim().isEmpty ? '.' : path,
    });
    return WorkspaceListing.fromJson(value);
  }

  /// Reads one page of a UTF-8 text file.
  Future<WorkspaceFileText> readFile(
    String sessionId,
    String path, {
    int offset = 1,
    int limit = 400,
  }) async {
    final value = await _client.rpc.call('workspaceFiles/read', {
      'workspaceFileScopeId': sessionId,
      'path': path,
      'range': {'offset': offset, 'limit': limit},
    });
    return WorkspaceFileText.fromJson(value);
  }

  /// Searches entry names and workspace-relative paths.
  ///
  /// A query without `/` matches names; with `/` it matches paths. The Host
  /// refuses a blank query, so an empty phone query must never be sent.
  Future<List<WorkspaceMatch>> findFiles(String sessionId, String query) async {
    final value = await _client.rpc.call('workspaceFiles/search', {
      'workspaceFileScopeId': sessionId,
      'request': {
        'query': query,
        'excludedPaths': const <String>[],
        'includeHidden': false,
        'respectGitignore': true,
      },
    });
    final matches = value['matches'];
    return [
      if (matches is List) for (final match in matches) ?WorkspaceMatch.fromJson(match),
    ];
  }

  /// The instruction files the agent will load for a session's directory.
  ///
  /// DSH loads `AGENTS.md`-style files from a user-global chain and a project
  /// chain; the Host plugin answers which ones actually exist, in load order.
  /// Reading and writing them goes through the same plugin, because the Remote
  /// API can read workspace files but has no endpoint that writes one.
  Future<InstructionsSnapshot> instructions(String? cwd) async {
    final value = await _client.rpc.call('pocketInstructions/describe', {
      if (cwd != null && cwd.isNotEmpty) 'cwd': cwd,
    });
    return InstructionsSnapshot.fromJson(value);
  }

  /// Reads one instruction file.
  Future<String> instructionText(String path) async {
    final value = await _client.rpc.call('pocketInstructions/read', {'path': path});
    final text = value['text'];
    return text is String ? text : '';
  }

  /// Saves one instruction file, creating it only when [create] is set.
  ///
  /// The Host refuses any other file name or a directory that is not already an
  /// instruction scope, so the phone cannot use this to write arbitrary files.
  Future<int> saveInstruction(String path, String text, {bool create = false}) async {
    final value = await _client.rpc.call('pocketInstructions/write', {
      'path': path,
      'text': text,
      'create': create,
    });
    final bytes = value['bytes'];
    return bytes is int ? bytes : text.length;
  }

  /// The jobs this session can see, as the Host currently reports them.
  ///
  /// `job/list` is a whole-set stream, so the first frame is already the truth.
  /// It never completes, so this reads one frame and unsubscribes instead of
  /// waiting for an end that does not come.
  Future<List<JobSummary>> jobs(String sessionId) async {
    final frames = _client.rpc.openStream('job/list', {
      'request': {'sessionId': sessionId},
    });
    final frame = await frames.first;
    final rows = frame['jobs'];
    return [
      if (rows is List) for (final row in rows) ?JobSummary.fromJson(row),
    ];
  }

  /// Watches the session's job roster until the stream closes.
  Stream<List<JobSummary>> watchJobs(String sessionId) {
    return _client.rpc
        .openStream('job/list', {
          'request': {'sessionId': sessionId},
        })
        .map((frame) {
          final rows = frame['jobs'];
          return [
            if (rows is List) for (final row in rows) ?JobSummary.fromJson(row),
          ];
        });
  }

  /// Asks the Host to cancel one background job.
  ///
  /// The Host answers `requested` or `already-finished`. A job the roster no
  /// longer carries is an error, so the caller refreshes the roster afterwards.
  Future<String> killJob(String sessionId, String jobId) async {
    final value = await _client.rpc.call('job/kill', {
      'request': {'sessionId': sessionId, 'jobId': jobId},
    });
    final outcome = value['outcome'];
    return outcome is String ? outcome : 'requested';
  }

  /// Streams one job's output until it settles.
  ///
  /// The stream opens with an `opened` anchor, then batches of output, then a
  /// terminal `status` frame after which it closes by itself.
  Stream<JobOutputFrame> followJob(String jobId, {String? sessionId}) {
    return _client.rpc
        .openStream('job/follow', {
          'request': {'jobId': jobId, 'sessionId': ?sessionId},
        })
        .map(JobOutputFrame.fromJson)
        .where((frame) => frame != null)
        .cast<JobOutputFrame>();
  }

  Future<void> close() async {
    await _events?.close();
    _events = null;
    if (!_questions.isClosed) await _questions.close();
    // `_openQuestions` may still be in flight; clearing the memo lets a caller
    // that somehow starts again retry instead of reusing a future that already
    // resolved against closed controllers.
    _starting = null;
    await _client.close();
  }
}
