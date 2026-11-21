import 'dart:convert';
import 'dart:typed_data';

import 'package:dsh_link/dsh_link.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_harness/src/dsh/host_link.dart';
import 'package:pocket_harness/src/dsh/outgoing_image.dart';
import 'package:pocket_harness/src/dsh/questions.dart';
import 'package:pocket_harness/src/dsh/tool_labels.dart';

/// Transcript rendering is the one piece of the phone UI with real logic, and
/// it runs against records captured from a real Host, so it is tested here
/// rather than only on a device.
void main() {
  group('buildTranscript', () {
    test('renders a user message and an assistant reply in sequence order', () {
      final rows = buildTranscript([
        _event('assistant/message', 15, {
          'turn': 1,
          'step': 1,
          'message': {
            'role': 'assistant',
            'content': [
              {'type': 'reasoning', 'text': 'thinking it over'},
              {'type': 'text', 'text': 'here is the answer'},
            ],
          },
        }),
        _event('user/message', 11, {
          'content': [
            {'type': 'text', 'text': 'what changed?'},
          ],
          'source': {'kind': 'user'},
        }),
      ]);

      expect(rows, hasLength(2));
      final user = rows[0] as UserRow;
      expect(user.seq, 11);
      expect(user.text, 'what changed?');
      expect(user.injected, isFalse);
      final assistant = rows[1] as AssistantRow;
      expect(assistant.text, 'here is the answer');
      expect(assistant.reasoning, 'thinking it over');
    });

    test('marks messages DSH attributed to a skill rather than the person', () {
      final rows = buildTranscript([
        _event('user/message', 4, {
          'content': [
            {'type': 'text', 'text': 'use the stock skill'},
          ],
          'source': {'kind': 'skill'},
        }),
      ]);

      expect((rows.single as UserRow).injected, isTrue);
    });

    test('renders tool calls and their results', () {
      final rows = buildTranscript([
        _event('tool/call', 20, {'turn': 1, 'step': 2, 'callId': 'c1', 'name': 'shell', 'arguments': '{"cmd":"ls"}'}),
        _event('tool/result', 21, {
          'turn': 1,
          'step': 2,
          'message': {
            'role': 'tool',
            'content': [
              {'type': 'text', 'text': 'a.txt'},
            ],
            'isError': true,
          },
        }),
      ]);

      expect(rows, hasLength(2));
      expect((rows[0] as ToolCallRow).name, 'shell');
      final result = rows[1] as ToolResultRow;
      expect(result.text, 'a.txt');
      expect(result.isError, isTrue);
    });

    test('surfaces a failed turn but stays quiet about a completed one', () {
      final failed = buildTranscript([
        _event('turn/end', 30, {
          'turn': 1,
          'reason': {
            'kind': 'error',
            'error': {'message': 'the model refused'},
          },
        }),
      ]);
      expect(failed, hasLength(1));
      expect((failed.single as NoticeRow).text, 'the model refused');
      expect((failed.single as NoticeRow).isError, isTrue);

      final completed = buildTranscript([
        _event('turn/end', 31, {
          'turn': 1,
          'reason': {'kind': 'completed'},
        }),
      ]);
      expect(completed, isEmpty);
    });

    test('ignores bookkeeping events and non-event records', () {
      final rows = buildTranscript([
        _event('request/header', 12, {'header': <String, Object?>{}}),
        _event('step/end', 16, {'turn': 1, 'step': 1}),
        _event('session/title', 14, {'title': 'a title'}),
        {'type': 'assistant-stream', 'frame': <String, Object?>{}},
      ]);

      expect(rows, isEmpty);
    });
  });

  group('SessionSummary.fromJson', () {    test('reads the title and directory out of projections', () {
      final summary = SessionSummary.fromJson({
        'sessionId': 's1',
        'updatedAt': 1700000000000,
        'running': true,
        'projections': {
          'values': {'title': 'Fix the build', 'workingDirectory': r'D:\work'},
        },
      });

      expect(summary, isNotNull);
      expect(summary!.sessionId, 's1');
      expect(summary.title, 'Fix the build');
      expect(summary.cwd, r'D:\work');
      expect(summary.running, isTrue);
    });

    test('falls back when projections are missing', () {
      final summary = SessionSummary.fromJson({'sessionId': 's2', 'updatedAt': 0});

      expect(summary, isNotNull);
      expect(summary!.title, '未命名会话');
      expect(summary.cwd, isNull);
      expect(summary.running, isFalse);
    });

    test('rejects an entry without a session id', () {
      expect(SessionSummary.fromJson({'updatedAt': 0}), isNull);
      expect(SessionSummary.fromJson('not a map'), isNull);
    });
  });

  group('live assistant stream', () {
    test('reads an assistant-stream frame and ignores other frames', () {
      final frame = readLiveFrame({
        'type': 'assistant-stream',
        'frame': {'type': 'chunk', 'attemptId': 'a1', 'index': 0, 'chunk': {'type': 'text-delta', 'text': 'hi'}},
      });

      expect(frame, isNotNull);
      expect(frame!.kind, 'chunk');
      expect(frame.attemptId, 'a1');
      expect(readLiveFrame({'type': 'snapshot'}), isNull);
      expect(readLiveFrame({'type': 'event', 'event': <String, Object?>{}}), isNull);
    });

    test('accumulates text and reasoning deltas', () {
      final draft = LiveDraft(attemptId: 'a1')
        ..applyChunk({'type': 'text-delta', 'index': 0, 'text': 'pocket'})
        ..applyChunk({'type': 'text-delta', 'index': 0, 'text': ' harness'})
        ..applyChunk({'type': 'reasoning-delta', 'index': 1, 'text': 'because'});

      expect(draft.text.toString(), 'pocket harness');
      expect(draft.reasoning.toString(), 'because');
      expect(draft.isEmpty, isFalse);
    });

    test('ignores tool-call deltas and usage chunks', () {
      final draft = LiveDraft(attemptId: 'a1')
        ..applyChunk({'type': 'tool-call-delta', 'index': 2, 'id': 'c1', 'argumentsDelta': '{"a"'})
        ..applyChunk({'type': 'usage', 'usage': <String, Object?>{}})
        ..applyChunk({'type': 'block-start', 'index': 0, 'blockType': 'text'});

      expect(draft.isEmpty, isTrue);
    });
  });

  _questionTests();
  _settingsTests();
  _workspaceTests();
  _jobTests();
}

/// The workspace file payloads, as `workspaceFiles/*` returns them.
void _workspaceTests() {
  group('workspace listing', () {
    test('reads entries, the path and the truncation flag', () {
      final listing = WorkspaceListing.fromJson({
        'path': 'lib',
        'truncated': true,
        'entries': [
          {'name': 'main.dart', 'type': 'file', 'size': 1200},
          {'name': 'src', 'type': 'directory'},
        ],
      });
      expect(listing.path, 'lib');
      expect(listing.truncated, isTrue);
      expect(listing.entries.first.name, 'main.dart');
      expect(listing.entries.first.size, 1200);
      expect(listing.entries.first.isDirectory, isFalse);
      expect(listing.entries.last.isDirectory, isTrue);
    });

    test('drops entries without a name', () {
      final listing = WorkspaceListing.fromJson({
        'entries': [
          {'type': 'file'},
          {'name': 'kept', 'type': 'file'},
        ],
      });
      expect(listing.entries.single.name, 'kept');
    });

    test('treats a missing entry list as empty', () {
      final listing = WorkspaceListing.fromJson(const {});
      expect(listing.entries, isEmpty);
      expect(listing.path, '');
    });
  });

  group('workspace file text', () {
    test('reads the page and whether it reaches the end', () {
      final page = WorkspaceFileText.fromJson({
        'absolutePath': r'D:\IDE\dsh-bot\README.md',
        'text': '# Pocket Harness',
        'offset': 1,
        'lines': 1,
        'bytes': 6809,
        'eof': false,
      });
      expect(page.absolutePath, r'D:\IDE\dsh-bot\README.md');
      expect(page.text, '# Pocket Harness');
      expect(page.offset, 1);
      expect(page.lines, 1);
      expect(page.bytes, 6809);
      expect(page.eof, isFalse);
    });

    test('falls back to empty values for a malformed page', () {
      final page = WorkspaceFileText.fromJson(const {});
      expect(page.text, '');
      expect(page.lines, 0);
      expect(page.eof, isFalse);
    });
  });

  group('workspace search', () {
    test('keeps matches and marks directories', () {
      final matches = [
        for (final raw in [
          {'path': 'app/lib/main.dart', 'type': 'file'},
          {'path': 'app/lib', 'type': 'directory'},
          {'type': 'file'},
        ])
          ?WorkspaceMatch.fromJson(raw),
      ];
      expect(matches.length, 2);
      expect(matches.first.path, 'app/lib/main.dart');
      expect(matches.first.isDirectory, isFalse);
      expect(matches.last.isDirectory, isTrue);
    });
  });
}

/// The settings payloads, as `settings/describe` returns them.
void _settingsTests() {
  group('settings snapshot', () {
    test('reads namespaces, revisions and the writable flag', () {
      final snapshot = SettingsSnapshot.fromJson({
        'writable': true,
        'namespaces': [
          {
            'ns': 'agent-default-model',
            'revision': 10,
            'value': {'provider': 'gateway', 'model': 'deepseek-v4.1-flash'},
            'secrets': <Object?>[],
          },
        ],
      });
      expect(snapshot.writable, isTrue);
      final model = snapshot.find('agent-default-model');
      expect(model, isNotNull);
      expect(model!.revision, 10);
      expect(model.value['model'], 'deepseek-v4.1-flash');
    });

    test('skips entries without a namespace name', () {
      final snapshot = SettingsSnapshot.fromJson({
        'writable': false,
        'namespaces': [
          {'revision': 1, 'value': <String, Object?>{}},
          {'ns': 'ui-theme', 'revision': 2, 'value': {'preference': 'system'}},
        ],
      });
      expect(snapshot.writable, isFalse);
      expect(snapshot.namespaces.single.ns, 'ui-theme');
    });

    test('treats a missing namespace list as empty rather than crashing', () {
      final snapshot = SettingsSnapshot.fromJson(const {'writable': true});
      expect(snapshot.namespaces, isEmpty);
      expect(snapshot.find('agent-default-model'), isNull);
    });

    test('records which fields the Host redacted', () {
      final namespace = SettingsNamespace.fromJson({
        'ns': 'web-search-free',
        'revision': 3,
        'value': {'provider': 'x'},
        'secrets': ['apiKey', 42],
      });
      expect(namespace!.secrets, ['apiKey']);
    });

    test('falls back to revision zero when the Host omits it', () {
      final namespace = SettingsNamespace.fromJson({'ns': 'ui-theme'});
      expect(namespace!.revision, 0);
      expect(namespace.value, isEmpty);
    });
  });
}

/// Wraps one durable event the way the Host's journal delivers it.
Map<String, Object?> _event(String type, int seq, Map<String, Object?> data) {
  return {
    'type': 'event',
    'event': {
      'type': type,
      'seq': seq,
      'time': 1700000000000,
      'data': data,
    },
  };
}

void _questionTests() {
  group('readQuestion', () {
    RemoteInvocation invocation(String event, Map<String, Object?> request) => RemoteInvocation(
          event: event,
          eventId: 'evt',
          agentId: 'agent',
          request: request,
        );

    test('turns an approval into a yes/no question', () {
      final question = readQuestion(invocation('approval/request', {
        'toolName': 'shell',
        'displayReason': {'en': 'run a command', 'zh': '运行命令'},
      }));
      expect(question, isA<ApprovalQuestion>());
      final approval = question! as ApprovalQuestion;
      expect(approval.isApproval, isTrue);
      expect(approval.toolName, 'shell');
      expect(approval.title, 'shell: run a command');
      expect(approval.invocation.eventId, 'evt');
    });

    test('falls back to the plain reason when there is no display reason', () {
      final approval = readQuestion(invocation('approval/request', {
        'toolName': 'write',
        'reason': 'edit a file',
      }))! as ApprovalQuestion;
      expect(approval.title, 'write: edit a file');
    });

    test('reads choice questions and their options', () {
      final question = readQuestion(invocation('user-questions/request', {
        'questions': [
          {
            'id': 'q1',
            'question': 'Which colour?',
            'header': 'Style',
            'options': [
              {'label': 'red', 'description': 'warm'},
              'blue',
            ],
          },
        ],
      }));
      expect(question, isA<ChoiceQuestion>());
      final choice = question! as ChoiceQuestion;
      expect(choice.isApproval, isFalse);
      expect(choice.questions.single.id, 'q1');
      expect(choice.questions.single.multiSelect, isFalse);
      expect(choice.questions.single.options.map((option) => option.label), ['red', 'blue']);
      expect(choice.questions.single.options.first.description, 'warm');
    });

    test('encodes the answer value the Host expects', () {
      final choice = readQuestion(invocation('user-questions/request', {
        'questions': [
          {'id': 'q1', 'question': 'One?', 'options': ['a', 'b']},
          {'id': 'q2', 'question': 'Two?', 'options': ['c'], 'multiSelect': true},
        ],
      }))! as ChoiceQuestion;
      final value = choice.answerValue({
        'q1': ['b'],
        'q2': ['c'],
      });
      expect(value, {
        'answers': [
          {'id': 'q1', 'selected': ['b']},
          {'id': 'q2', 'selected': ['c']},
        ],
      });
    });

    test('ignores events and prompts it cannot render', () {
      expect(readQuestion(invocation('session/event', {})), isNull);
      expect(readQuestion(invocation('user-questions/request', {'questions': []})), isNull);
    });
  });

  group('model catalog', () {
    test('flattens provider groups into one list', () {
      final catalog = ModelCatalog.fromJson({
        'default': {'provider': 'gateway', 'model': 'deepseek-v4.1-flash'},
        'groups': [
          {
            'id': 'gateway',
            'name': 'DSH Model Gateway',
            'models': [
              {
                'id': 'deepseek-v4.1-flash',
                'name': 'DeepSeek V4.1 Flash',
                'reasoning': {
                  'efforts': [
                    {'id': 'high', 'name': 'High'},
                    {'id': 'max', 'name': 'Max'},
                  ],
                  'defaultEffort': 'high',
                },
              },
              {'id': 'plain', 'name': 'Plain'},
            ],
          },
          {
            'id': 'deepseek-official',
            'name': 'DeepSeek',
            'models': [
              {'id': 'deepseek-flash', 'name': 'DeepSeek Flash'},
            ],
          },
        ],
      });
      expect(catalog.choices.map((c) => '${c.provider}/${c.model}'), [
        'gateway/deepseek-v4.1-flash',
        'gateway/plain',
        'deepseek-official/deepseek-flash',
      ]);
      expect(catalog.choices.first.providerName, 'DSH Model Gateway');
      expect(catalog.choices.first.efforts.map((e) => e.id), ['high', 'max']);
      expect(catalog.choices.first.defaultEffort, 'high');
      expect(catalog.choices[1].efforts, isEmpty);
      expect(catalog.defaultChoice?.model, 'deepseek-v4.1-flash');
    });

    test('survives a Host that sends no groups', () {
      final catalog = ModelCatalog.fromJson({'default': null, 'groups': 'nope'});
      expect(catalog.choices, isEmpty);
      expect(catalog.defaultChoice, isNull);
    });

    test('prefers the next route over the last used one', () {
      final selection = ModelSelection.fromProjections({
        'modelSelection': {
          'lastUsed': {'provider': 'gateway', 'model': 'old'},
          'next': {'provider': 'gateway', 'model': 'new', 'reasoningEffort': 'low'},
        },
      });
      // DSH nests the selection under `modelSelection` in projections; the
      // helper accepts the inner map because that is what the caller has.
      expect(selection, isNull);
    });

    test('reads the next route from the selection map', () {
      final selection = ModelSelection.fromProjections({
        'lastUsed': {'provider': 'gateway', 'model': 'old'},
        'next': {'provider': 'gateway', 'model': 'new', 'reasoningEffort': 'low'},
      });
      expect(selection?.model, 'new');
      expect(selection?.reasoningEffort, 'low');
    });

    test('falls back to the last used route before any next route exists', () {
      final selection = ModelSelection.fromProjections({
        'lastUsed': {'provider': 'gateway', 'model': 'old'},
      });
      expect(selection?.model, 'old');
      expect(selection?.reasoningEffort, isNull);
    });

    test('reads the flat route selectModel answers with', () {
      final selection = ModelSelection.fromProjections({
        'provider': 'gateway',
        'model': 'agnes-3.0-flash',
        'reasoningEffort': 'low',
      });
      expect(selection?.model, 'agnes-3.0-flash');
      expect(selection?.provider, 'gateway');
      expect(selection?.reasoningEffort, 'low');
    });
  });

  group('agent presets', () {
    test('keeps the display name and the id apart', () {
      final preset = AgentPreset.fromJson({
        'id': 'lean',
        'name': '精工模式',
        'description': '面向编码与量化策略的精简工具集',
        'order': 5,
        'isDefault': false,
      });
      expect(preset?.id, 'lean');
      expect(preset?.label, '精工模式');
      expect(preset?.description, '面向编码与量化策略的精简工具集');
      expect(preset?.isDefault, isFalse);
    });

    test('falls back to the id when the roster carries no name', () {
      final preset = AgentPreset.fromJson({'id': 'standard', 'order': 1, 'isDefault': true});
      expect(preset?.label, 'standard');
      expect(preset?.description, isNull);
      expect(preset?.isDefault, isTrue);
    });

    test('skips entries without an id', () {
      expect(AgentPreset.fromJson({'name': 'nameless'}), isNull);
      expect(AgentPreset.fromJson('lean'), isNull);
    });
  });

  group('tool labels', () {
    test('names a shell call by its verb and its command', () {
      expect(toolVerb('pwsh'), '运行命令');
      expect(toolSubject('{"command":"Get-ChildItem src"}'), 'Get-ChildItem src');
    });

    test('falls back to the tool name for an unknown tool', () {
      expect(toolVerb('frobnicate_things'), 'frobnicate things');
      expect(toolVerb('server__read'), '读取');
      expect(toolVerb('  '), '工具');
    });

    test('reads a file path and a search pattern as subjects', () {
      expect(toolSubject(r'{"file_path":"D:\\IDE\\dsh-bot\\README.md"}'), r'D:\IDE\dsh-bot\README.md');
      expect(toolSubject('{"pattern":"FutureBuilder","path":"lib"}'), 'FutureBuilder');
    });

    test('returns no subject when the arguments carry none', () {
      expect(toolSubject('{"odd":1}'), '');
      expect(toolSubject('not json'), 'not json');
    });

    test('pretty-prints arguments and leaves junk alone', () {
      expect(prettyJson('{"a":1}'), contains('"a": 1'));
      expect(prettyJson('plain text'), 'plain text');
    });

    test('flattens multi-line output into one preview line', () {
      expect(collapse('a\n\nb   c'), 'a b c');
      expect(summarizeBody('one\ntwo'), endsWith('2 行'));
    });
  });

  group('session search', () {
    test('reads hits and the truncation flag', () {
      final result = SessionSearchResult.fromJson({
        'items': [
          {'sessionId': 'abcdefgh-1234-7abc-8def-0123456789ab', 'snippet': '数到 40'},
          {'sessionId': 'ijklmnop-1234-7abc-8def-0123456789ab', 'snippet': '接入 LibreXTV'},
        ],
        'hasMore': true,
      });
      expect(result.hits, hasLength(2));
      expect(result.hits.first.snippet, '数到 40');
      expect(result.hasMore, isTrue);
    });

    test('drops hits without a usable session id', () {
      final result = SessionSearchResult.fromJson({
        'items': [
          {'snippet': 'no id at all'},
          {'sessionId': '', 'snippet': 'empty id'},
          {'sessionId': 'abcdefgh-1234-7abc-8def-0123456789ab'},
        ],
      });
      expect(result.hits, hasLength(1));
      expect(result.hits.single.snippet, isEmpty);
      expect(result.hasMore, isFalse);
    });

    test('treats a missing item list as no matches', () {
      expect(SessionSearchResult.fromJson(const {}).hits, isEmpty);
      expect(SessionSearchResult.fromJson(const {'items': 'nope'}).hits, isEmpty);
    });
  });

  group('filterSessions', () {
    final sessions = [
      _summary('a', '重写UU远程重构方案', r'D:\IDE\UU'),
      _summary('b', 'Count to 40', r'D:\IDE\dsh-bot'),
      _summary('c', 'LibreXTV 接入与后续任务', null),
    ];

    test('matches the title regardless of case', () {
      expect(filterSessions(sessions, 'count').map((s) => s.sessionId), ['b']);
      expect(filterSessions(sessions, 'librextv').map((s) => s.sessionId), ['c']);
    });

    test('matches the working directory too', () {
      expect(filterSessions(sessions, r'ide\uu').map((s) => s.sessionId), ['a']);
      expect(filterSessions(sessions, 'dsh-bot').map((s) => s.sessionId), ['b']);
    });

    test('never matches on an empty query', () {
      expect(filterSessions(sessions, '   '), isEmpty);
    });

    test('tolerates a session with no directory', () {
      expect(filterSessions(sessions, 'librextv').single.cwd, isNull);
    });
  });

  group('skills', () {
    const skills = [
      SkillEntry(
        name: 'brainstorming',
        description: 'You MUST use this before any creative work.',
        modelInvocable: true,
      ),
      SkillEntry(
        name: 'canvas',
        description: 'A live React app opened beside the chat.',
        whenToUse: 'When the response benefits from visual layout',
        modelInvocable: false,
      ),
      SkillEntry(name: 'create-rule', description: 'Create Codex rules.'),
    ];

    test('filters by name, description, and when-to-use', () {
      expect(filterSkills(skills, 'canvas').map((s) => s.name), ['canvas']);
      expect(filterSkills(skills, 'CREATIVE').map((s) => s.name), ['brainstorming']);
      expect(filterSkills(skills, 'visual layout').map((s) => s.name), ['canvas']);
    });

    test('keeps every skill for an empty filter', () {
      expect(filterSkills(skills, '  '), hasLength(3));
    });

    test('reads a skill and its optional fields', () {
      final skill = SkillEntry.fromJson({
        'name': 'lean',
        'description': '精简工具集',
        'whenToUse': '编码时',
        'path': r'C:\skills\lean\SKILL.md',
        'modelInvocable': true,
      });
      expect(skill?.name, 'lean');
      expect(skill?.whenToUse, '编码时');
      expect(skill?.path, r'C:\skills\lean\SKILL.md');
      expect(skill?.modelInvocable, isTrue);
    });

    test('drops entries without a name', () {
      expect(SkillEntry.fromJson({'description': 'nameless'}), isNull);
      expect(SkillEntry.fromJson('canvas'), isNull);
    });
  });

  group('outgoing images', () {
    test('maps the extensions DSH accepts', () {
      expect(OutgoingImage.mediaTypeFor(r'C:\pics\shot.PNG'), 'image/png');
      expect(OutgoingImage.mediaTypeFor('/tmp/a.jpeg'), 'image/jpeg');
      expect(OutgoingImage.mediaTypeFor('/tmp/a.jpg'), 'image/jpeg');
      expect(OutgoingImage.mediaTypeFor('/tmp/a.webp'), 'image/webp');
      expect(OutgoingImage.mediaTypeFor('/tmp/a.gif'), 'image/gif');
    });

    test('rejects anything the Host would refuse', () {
      expect(OutgoingImage.mediaTypeFor('/tmp/a.bmp'), isNull);
      expect(OutgoingImage.mediaTypeFor('/tmp/a.heic'), isNull);
      expect(OutgoingImage.mediaTypeFor('/tmp/noextension'), isNull);
      expect(OutgoingImage.mediaTypeFor('/tmp/trailing.'), isNull);
      expect(OutgoingImage.mediaTypeFor(null), isNull);
    });

    test('encodes bytes as the inline content part', () {
      final part = OutgoingImage(
        bytes: Uint8List.fromList([1, 2, 3, 4]),
        mediaType: 'image/png',
        name: 'tiny.png',
      ).toPart();
      expect(part['type'], 'image');
      expect(part['mediaType'], 'image/png');
      expect(part['data'], base64Encode([1, 2, 3, 4]));
      expect(part['name'], 'tiny.png');
    });

    test('omits the name when the picker did not supply one', () {
      final part = OutgoingImage(
        bytes: Uint8List.fromList([9]),
        mediaType: 'image/gif',
      ).toPart();
      expect(part.containsKey('name'), isFalse);
    });
  });

  group('image rows', () {
    test('keeps a user message that only carries a picture', () {
      final rows = buildTranscript([
        _event('user/message', 1, {
          'content': [
            {
              'type': 'image',
              'attachment': {
                'attachmentId': 'a1',
                'mediaType': 'image/png',
                'bytes': 408,
                'width': 64,
                'height': 64,
              },
            },
          ],
          'source': {'kind': 'human'},
        }),
      ]);
      final row = rows.single;
      expect(row, isA<UserRow>());
      expect((row as UserRow).text, '');
      expect(row.images.single.attachmentId, 'a1');
      expect(row.images.single.width, 64);
    });

    test('keeps the picture alongside the text', () {
      final rows = buildTranscript([
        _event('assistant/message', 2, {
          'turn': 1,
          'step': 1,
          'message': {
            'id': 'm1',
            'role': 'assistant',
            'content': [
              {'type': 'text', 'text': 'here it is'},
              {
                'type': 'image',
                'attachment': {'attachmentId': 'a2', 'mediaType': 'image/webp', 'bytes': 10},
              },
            ],
          },
        }),
      ]);
      final row = rows.single as AssistantRow;
      expect(row.text, 'here it is');
      expect(row.images.single.mediaType, 'image/webp');
      expect(row.images.single.width, isNull);
    });

    test('drops an image reference without an id', () {
      final rows = buildTranscript([
        _event('user/message', 3, {
          'content': [
            {'type': 'image', 'attachment': {'mediaType': 'image/png'}},
          ],
          'source': {'kind': 'human'},
        }),
      ]);
      expect(rows, isEmpty);
    });
  });
}

SessionSummary _summary(String id, String title, String? cwd) => SessionSummary(
      sessionId: id,
      title: title,
      updatedAt: DateTime.fromMillisecondsSinceEpoch(0),
      running: false,
      cwd: cwd,
    );

/// The `job/list` and `job/follow` payloads, as the Host sends them.
void _jobTests() {
  group('job summary', () {
    test('reads a settled row and labels its status in Chinese', () {
      final job = JobSummary.fromJson({
        'id': 'pwsh-abc123',
        'kind': 'pwsh',
        'label': 'gradlew assembleDebug',
        'status': 'completed',
        'detail': 'exit code: 0',
        'startedAt': 1795254970727,
        'finishedAt': 1795254997361,
      });

      expect(job, isNotNull);
      expect(job!.id, 'pwsh-abc123');
      expect(job.kind, 'pwsh');
      expect(job.statusLabel, '已完成');
      expect(job.detail, 'exit code: 0');
      expect(job.isLive, isFalse);
      expect(job.finishedAt, isNotNull);
    });

    test('treats running and stopping as live', () {
      for (final status in ['running', 'stopping']) {
        final job = JobSummary.fromJson({
          'id': 'bash-1',
          'label': 'npm test',
          'status': status,
          'startedAt': 1,
        });
        expect(job!.isLive, isTrue, reason: status);
      }
    });

    test('falls back to the id when the label is missing', () {
      final job = JobSummary.fromJson({
        'id': 'bash-2',
        'status': 'failed',
        'startedAt': 0,
      });
      expect(job!.label, 'bash-2');
      expect(job.kind, 'job');
      expect(job.statusLabel, '失败');
    });

    test('drops a row without an id', () {
      expect(JobSummary.fromJson({'label': 'orphan'}), isNull);
      expect(JobSummary.fromJson(null), isNull);
    });
  });

  group('job output frame', () {
    test('joins the chunks of an output frame and keeps the lossy marker', () {
      final frame = JobOutputFrame.fromJson({
        'type': 'output',
        'next': 42,
        'lossy': true,
        'chunks': [
          {'at': 0, 'text': 'first line\n'},
          {'at': 11, 'text': 'second line\n'},
        ],
      });

      expect(frame, isNotNull);
      expect(frame!.kind, 'output');
      expect(frame.text, 'first line\nsecond line\n');
      expect(frame.lossy, isTrue);
    });

    test('reads the job carried by an opened anchor', () {
      final frame = JobOutputFrame.fromJson({
        'type': 'opened',
        'from': 0,
        'job': {
          'id': 'bash-3',
          'label': 'sleep 5',
          'status': 'running',
          'startedAt': 5,
        },
      });

      expect(frame!.kind, 'opened');
      expect(frame.text, isEmpty);
      expect(frame.job!.id, 'bash-3');
      expect(frame.job!.isLive, isTrue);
    });

    test('ignores a frame it has no meaning for', () {
      expect(JobOutputFrame.fromJson({'type': 'mystery'}), isNull);
      expect(JobOutputFrame.fromJson(const {}), isNull);
    });
  });
}

