import 'dart:convert';
import 'dart:typed_data';

import 'package:dsh_link/dsh_link.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart' show SelectableText;
import 'package:pocket_harness/src/dsh/code_highlight.dart';
import 'package:pocket_harness/src/dsh/host_link.dart';
import 'package:pocket_harness/src/dsh/instruction_paths.dart';
// Parsing stays out of the widget layer for the same reason grouping does:
// a parse bug should be findable without pumping a frame.
import 'package:pocket_harness/src/dsh/markdown.dart';
import 'package:pocket_harness/src/dsh/outgoing_image.dart';
import 'package:pocket_harness/src/dsh/questions.dart';
import 'package:pocket_harness/src/dsh/scroll_follow.dart';
// The grouping is plain Dart, deliberately separate from the page: importing
// the page here would drag Flutter widgets into a test that does not need them.
import 'package:pocket_harness/src/dsh/session_groups.dart';
import 'package:pocket_harness/src/dsh/tool_labels.dart';
import 'package:pocket_harness/src/widgets/markdown_body.dart';

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

  group('SessionSummary.fromJson', () {
    test('reads the title and directory out of projections', () {
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

    test('reads the directory from cwd when the row carries no projections', () {
      final summary = SessionSummary.fromJson({
        'sessionId': 's3',
        'updatedAt': 1700000000000,
        'agentAvailable': true,
        'blank': false,
        'cwd': r'D:\IDE\zpan',
      });

      expect(summary, isNotNull);
      expect(summary!.title, '未命名会话');
      expect(summary.cwd, r'D:\IDE\zpan');
    });

    test('prefers the projected directory over cwd', () {
      final summary = SessionSummary.fromJson({
        'sessionId': 's4',
        'updatedAt': 1700000000000,
        'cwd': r'D:\stale',
        'projections': {
          'values': {'title': 'Analyse a transcript', 'workingDirectory': r'D:\IDE\zpan'},
        },
      });

      expect(summary!.title, 'Analyse a transcript');
      expect(summary.cwd, r'D:\IDE\zpan');
    });

    test('keeps an agent-less, still blank session flagged as a seed', () {
      final seeded = SessionSummary.fromJson({
        'sessionId': 's5',
        'updatedAt': 1700000000000,
        'agentAvailable': false,
        'blank': true,
        'cwd': r'D:\IDE\zpan',
      });

      expect(seeded!.agentAvailable, isFalse);
      expect(seeded.blank, isTrue);
    });

    test('assumes a session is real when the Host omits the flags', () {
      final summary = SessionSummary.fromJson({'sessionId': 's6', 'updatedAt': 0});

      expect(summary!.agentAvailable, isTrue);
      expect(summary.blank, isFalse);
      expect(summary.lastPromptAt, isNull);
      expect(summary.used, isFalse);
    });

    test('reads the last human prompt out of the list metadata', () {
      final summary = SessionSummary.fromJson({
        'sessionId': 's7',
        'updatedAt': 1700000000000,
        'projections': {
          'values': {
            'title': '分析 DeepSeek 对话分享',
            'sessionListMetadata': {'blank': false, 'lastPromptAt': 1700000000123},
          },
        },
      });

      expect(summary!.used, isTrue);
      expect(
        summary.lastPromptAt!.millisecondsSinceEpoch,
        1700000000123,
      );
    });

    test('treats a never-prompted session as unused even after a turn began', () {
      final summary = SessionSummary.fromJson({
        'sessionId': 's8',
        'updatedAt': 1700000000000,
        'projections': {
          'values': {
            'title': 'You are a third-person note-taker.',
            'sessionListMetadata': {'blank': false, 'lastPromptAt': null},
          },
        },
      });

      expect(summary!.used, isFalse);
      expect(summary.blank, isFalse);
    });
  });

  group('groupSessionsByProject', () {
    SessionSummary session(String id, String? cwd, int updatedAt, {bool running = false}) =>
        SessionSummary(
          sessionId: id,
          title: id,
          updatedAt: DateTime.fromMillisecondsSinceEpoch(updatedAt),
          running: running,
          cwd: cwd,
        );

    test('puts each directory in its own section', () {
      final groups = groupSessionsByProject([
        session('a', r'D:\IDE\dsh-bot', 3000),
        session('b', r'D:\IDE\UU', 2000),
        session('c', r'D:\IDE\dsh-bot', 1000),
      ]);

      expect(groups.map((group) => group.key), [r'D:\IDE\dsh-bot', r'D:\IDE\UU']);
      expect(groups.first.sessions.map((s) => s.sessionId), ['a', 'c']);
    });

    test('orders sections by their newest session, not by member order', () {
      // The Host sorts by activity, so the first row belongs to the newest
      // project — but bucketing reorders the members, and the sections have to
      // come out in the same order regardless.
      final groups = groupSessionsByProject([
        session('old', r'D:\one', 1000),
        session('newest', r'D:\two', 9000),
        session('middle', r'D:\three', 5000),
      ]);

      expect(groups.map((group) => group.key), [r'D:\two', r'D:\three', r'D:\one']);
    });

    test('collects sessions without a directory at the bottom', () {
      // A stale session with no directory must not push a real project down
      // just because it was touched a second ago.
      final groups = groupSessionsByProject([
        session('orphan', null, 9999),
        session('blank', '', 9998),
        session('real', r'D:\work', 1),
      ]);

      expect(groups.first.key, r'D:\work');
      expect(groups.last.key, '');
      expect(groups.last.sessions.map((s) => s.sessionId), ['orphan', 'blank']);
      expect(groups.last.label, '未指定目录');
    });

    test('labels a section with its folder name and counts what is running', () {
      final groups = groupSessionsByProject([
        session('a', r'D:\IDE\dsh-bot', 1000, running: true),
        session('b', r'D:\IDE\dsh-bot', 900, running: true),
        session('c', r'D:\IDE\dsh-bot', 800),
      ]);

      expect(groups.single.label, 'dsh-bot');
      expect(groups.single.running, 2);
      expect(groups.single.sessions, hasLength(3));
    });

    test('returns nothing for an empty list', () {
      expect(groupSessionsByProject(const []), isEmpty);
    });

    test('folds every project when the page first opens', () {
      // The page is a project index, not a session list: opening 900 sessions
      // across 22 projects is the wall the grouping was meant to remove.
      final groups = groupSessionsByProject([
        session('a', r'D:\IDE\dsh-bot', 1000),
        session('b', null, 900),
      ]);

      expect(projectsFoldedOnOpen(groups), {r'D:\IDE\dsh-bot', ''});
      expect(projectsFoldedOnOpen(const []), isEmpty);
    });
  });

  group('sessionsWorthShowing', () {
    SessionSummary row(
      String id, {
      bool blank = false,
      bool agentAvailable = false,
      int? lastPromptAt,
      String? origin,
    }) => SessionSummary(
      sessionId: id,
      title: id,
      updatedAt: DateTime.fromMillisecondsSinceEpoch(1000),
      running: false,
      agentAvailable: agentAvailable,
      blank: blank,
      lastPromptAt: lastPromptAt == null
          ? null
          : DateTime.fromMillisecondsSinceEpoch(lastPromptAt),
      origin: origin,
    );

    test('keeps a conversation somebody has sent a message to', () {
      final shown = sessionsWorthShowing([row('used', lastPromptAt: 5000)]);

      expect(shown.map((session) => session.sessionId), ['used']);
    });

    test('keeps a session made by the new-session button', () {
      // No turn has started, so `blank` is true and there is no prompt yet; the
      // row must stay or the button looks broken.
      final shown = sessionsWorthShowing([row('fresh', blank: true)]);

      expect(shown.map((session) => session.sessionId), ['fresh']);
    });

    test('drops start-up failures: a turn started but nobody ever spoke', () {
      // The reported shape: one real session and seven rows where a system
      // prompt was spliced into a fresh session and no agent bound, all in the
      // same folder. The desktop listed one; the phone listed nine. Those rows
      // carry `blank: false` because a turn began, and `agentAvailable` only by
      // accident of the Host's uptime, so neither flag separates them.
      final shown = sessionsWorthShowing([
        row('real', lastPromptAt: 5000),
        row('failed-start'),
        row('failed-start'),
      ]);

      expect(shown.map((session) => session.sessionId), ['real']);
    });

    test('survives a Host restart, when no agent is attached anywhere', () {
      // After a restart every row reads `agentAvailable: false`; a filter on
      // that flag would empty the list. Real conversations must still show.
      final shown = sessionsWorthShowing([
        row('old-a', lastPromptAt: 1000),
        row('old-b', lastPromptAt: 2000),
      ]);

      expect(shown.map((session) => session.sessionId), ['old-a', 'old-b']);
    });

    test('drops subagent sessions even though they carry a prompt', () {
      // 334 of 957 rows are sessions an agent spawned. Their parent writes the
      // prompt, so they look used to every other test; the desktop drops them
      // with `if (session.origin === 'subagent') return false`.
      final shown = sessionsWorthShowing([
        row('mine', lastPromptAt: 5000),
        row('child', lastPromptAt: 6000, origin: 'subagent'),
        row('child-blank', blank: true, origin: 'subagent'),
      ]);

      expect(shown.map((session) => session.sessionId), ['mine']);
    });

    test('returns an empty list unchanged', () {
      expect(sessionsWorthShowing(const []), isEmpty);
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
  _todoTests();
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


/// The todo panel reads two very different payloads: a projection value bag
/// (`session/projections`) and a live `todo/write` event. Both are covered here
/// because a mismatch between them is silent — the panel just never appears.
void _todoTests() {
  group('todo items', () {
    test('reads content and status', () {
      final item = TodoItem.fromJson({'content': '  写测试  ', 'status': 'in_progress'});
      expect(item?.content, '写测试');
      expect(item?.isRunning, isTrue);
      expect(item?.isDone, isFalse);
    });

    test('drops entries without usable content', () {
      expect(TodoItem.fromJson({'status': 'pending'}), isNull);
      expect(TodoItem.fromJson({'content': '   '}), isNull);
      expect(TodoItem.fromJson('nope'), isNull);
    });

    test('keeps an unknown status verbatim instead of hiding the row', () {
      final item = TodoItem.fromJson({'content': '未来状态', 'status': 'blocked'});
      expect(item?.status, 'blocked');
      expect(item?.isDone, isFalse);
      expect(item?.isRunning, isFalse);
    });

    test('treats a missing status as pending', () {
      expect(TodoItem.fromJson({'content': 'x'})?.status, 'pending');
    });
  });

  group('todos projection', () {
    test('reads the list out of a projection value bag', () {
      final todos = readTodos({
        'todos': [
          {'content': 'a', 'status': 'completed'},
          {'content': 'b', 'status': 'in_progress'},
        ],
      });
      expect(todos?.map((item) => item.content), ['a', 'b']);
      expect(todos?.first.isDone, isTrue);
    });

    test('returns null before the first write, which is not an empty list', () {
      expect(readTodos({'todos': null}), isNull);
      expect(readTodos({'title': 'no todos key'}), isNull);
      expect(readTodos(null), isNull);
    });

    test('returns an empty list when every entry is unusable', () {
      expect(readTodos({'todos': [{'status': 'pending'}]}), isEmpty);
    });
  });

  group('todo write', () {
    test('reads the snapshot a live event carries', () {
      final todos = readTodoWrite({
        'todos': [
          {'content': '部署', 'status': 'pending'},
        ],
      });
      expect(todos.single.content, '部署');
    });

    test('answers empty for a malformed payload rather than throwing', () {
      expect(readTodoWrite(null), isEmpty);
      expect(readTodoWrite({'todos': 'nope'}), isEmpty);
    });
  });

  group('instruction files', () {
    test('reads the project root, the directory and the load order', () {
      final snapshot = InstructionsSnapshot.fromJson({
        'projectRoot': '/home/me/project',
        'cwd': '/home/me/project/packages/app',
        'files': [
          {
            'scope': 'global',
            'label': '~/.dsh',
            'path': '/home/me/.dsh/AGENTS.md',
            'name': 'AGENTS.md',
            'bytes': 120,
          },
          {
            'scope': 'project',
            'label': '.',
            'path': '/home/me/project/AGENTS.md',
            'name': 'AGENTS.md',
            'bytes': 400,
          },
        ],
      });
      expect(snapshot.projectRoot, '/home/me/project');
      expect(snapshot.files.first.isGlobal, isTrue);
      expect(snapshot.files.first.label, '~/.dsh');
      expect(snapshot.files.last.isGlobal, isFalse);
      expect(snapshot.files.last.bytes, 400);
    });

    test('a directory outside any project still reports the user chain', () {
      final snapshot = InstructionsSnapshot.fromJson({
        'projectRoot': null,
        'cwd': '/tmp/scratch',
        'files': [
          {
            'scope': 'global',
            'label': '~/.agents',
            'path': '/home/me/.agents/AGENTS.md',
            'name': 'AGENTS.md',
            'bytes': 8,
          },
        ],
      });
      expect(snapshot.projectRoot, isNull);
      expect(snapshot.files.single.label, '~/.agents');
    });

    test('skips a row without a path or a name instead of inventing one', () {
      final snapshot = InstructionsSnapshot.fromJson({
        'files': [
          {'scope': 'project', 'label': '.'},
          {'path': 42, 'name': 'AGENTS.md'},
          {'path': '/p/AGENTS.md', 'name': 'AGENTS.md'},
        ],
      });
      expect(snapshot.files.map((file) => file.path), ['/p/AGENTS.md']);
    });

    test('an empty listing is not an error', () {
      final snapshot = InstructionsSnapshot.fromJson({'files': <Object?>[]});
      expect(snapshot.files, isEmpty);
      expect(snapshot.cwd, isNull);
    });
  });

  group('instruction paths', () {
    test('offers exactly the four names the loader reads', () {
      expect(instructionFileNames, [
        'AGENTS.md',
        'CLAUDE.md',
        'AGENTS.local.md',
        'CLAUDE.local.md',
      ]);
    });

    test('every offered name has a hint and an unknown name has none', () {
      for (final name in instructionFileNames) {
        expect(instructionCandidateHint(name), isNotEmpty, reason: name);
      }
      expect(instructionCandidateHint('NOTES.md'), '');
    });

    test('joins with a backslash and never doubles a trailing separator', () {
      expect(instructionFilePath(r'D:\work\app', 'AGENTS.md'), r'D:\work\app\AGENTS.md');
      expect(instructionFilePath(r'D:\work\app\', 'AGENTS.md'), r'D:\work\app\AGENTS.md');
      expect(instructionFilePath('/home/me', 'AGENTS.md'), '/home/me/AGENTS.md');
      expect(instructionFilePath('/home/me/', 'AGENTS.md'), '/home/me/AGENTS.md');
      expect(instructionFilePath('', 'AGENTS.md'), 'AGENTS.md');
    });

    test('the project root wins over the session directory', () {
      expect(
        instructionCreateDirectory(projectRoot: r'D:\work\app', cwd: r'D:\work\app\src'),
        r'D:\work\app',
      );
    });

    test('a session without a project still offers its own directory', () {
      expect(instructionCreateDirectory(projectRoot: null, cwd: '/tmp/x'), '/tmp/x');
      expect(instructionCreateDirectory(projectRoot: '', cwd: '/tmp/x'), '/tmp/x');
    });

    test('nowhere legal means no create button', () {
      expect(instructionCreateDirectory(projectRoot: null, cwd: null), isNull);
      expect(instructionCreateDirectory(projectRoot: '', cwd: ''), isNull);
    });
  });

  group('message rendering', () {
    test('a fenced block keeps its language and body', () {
      final blocks = parseMarkdown('```dart\nvoid main() {}\n```');
      final code = blocks.single as MdCodeBlock;
      expect(code.language, 'dart');
      expect(code.code, 'void main() {}');
      expect(code.closed, isTrue);
    });

    test('an unclosed fence is still code while the reply streams in', () {
      // A reply is reparsed on every delta, so between the opening and closing
      // fence every message really is an unclosed fence. Treating it as text
      // would make the block change shape mid-stream.
      final blocks = parseMarkdown('```python\nprint(1)');
      final code = blocks.single as MdCodeBlock;
      expect(code.language, 'python');
      expect(code.code, 'print(1)');
      expect(code.closed, isFalse);
    });

    test('a reply with a heading, list, code and table parses in order', () {
      const reply = '''
## Summary

The build **failed**.

- delete `pubspec.lock`
- rerun

```bash
flutter pub get
```

| step | result |
| --- | --- |
| 1 | ok |
''';
      final kinds = parseMarkdown(reply)
          .map((block) => block.runtimeType.toString())
          .toList();
      expect(kinds, [
        'MdHeading',
        'MdParagraph',
        'MdListBlock',
        'MdCodeBlock',
        'MdTable',
      ]);
    });

    test('inline markers become spans, not literal asterisks', () {
      final spans = parseInline('a **b** and `c`');
      expect(spans.whereType<MdStrong>().length, 1);
      expect(spans.whereType<MdCodeSpan>().single.text, 'c');
      expect(inlineToPlainText(spans), 'a b and c');
    });

    test('a link keeps the label the reader sees', () {
      final link =
          parseInline('see [the docs](https://example.com)').whereType<MdLink>().single;
      expect(link.label, 'the docs');
      expect(link.url, 'https://example.com');
    });

    test('an unclosed marker stays literal instead of eating the text', () {
      expect(inlineToPlainText(parseInline('a **b')), 'a **b');
    });

    test('highlighting never changes the text it colours', () {
      const code = 'final a = 42; // note\nvoid main() { print("hi"); }';
      final spans = highlightCode(code, 'dart');
      expect(spans.map((span) => span.text).join(), code);
      expect(
        spans.any((span) => span.kind == CodeKind.keyword && span.text == 'final'),
        isTrue,
      );
      expect(
        spans.any((span) => span.kind == CodeKind.comment && span.text == '// note'),
        isTrue,
      );
    });

    test('an unknown fence tag is left uncoloured', () {
      expect(languageFor('notalanguage'), isNull);
      expect(highlightCode('x', 'notalanguage').single.kind, CodeKind.plain);
    });

    test('sql keywords are matched whatever the case', () {
      final spans = highlightCode("select a from t where b = 'x'", 'sql');
      expect(
        spans.where((span) => span.kind == CodeKind.keyword).map((span) => span.text),
        containsAll(<String>['select', 'from', 'where']),
      );
    });
  });

  // The parser tests above prove the markdown becomes the right blocks. These
  // prove the blocks reach the screen as the styling they were given: a phone
  // screenshot is the only other way to see colour, and it cannot tell a
  // correct palette from a wrong one that happens to look fine.
  group('markdown rendering', () {
    Widget wrap(Widget child) {
      return Directionality(
        textDirection: TextDirection.ltr,
        child: MediaQuery(
          data: const MediaQueryData(),
          child: DefaultTextStyle(
            style: const TextStyle(fontSize: 14),
            child: child,
          ),
        ),
      );
    }

    List<InlineSpan> spansOf(WidgetTester tester) {
      final spans = <InlineSpan>[];
      for (final rich in tester.widgetList<RichText>(find.byType(RichText))) {
        rich.text.visitChildren((span) {
          spans.add(span);
          return true;
        });
      }
      return spans;
    }

    testWidgets('a code block is coloured by the theme, not left plain', (
      tester,
    ) async {
      await tester.pumpWidget(
        wrap(
          const MarkdownBody(
            text: '```dart\nfinal a = 42; // note\n```',
            selectable: false,
            theme: MarkdownTheme.dark,
          ),
        ),
      );
      final colours = spansOf(
        tester,
      ).whereType<TextSpan>().map((span) => span.style?.color).toList();
      expect(colours, contains(MarkdownTheme.dark.keyword));
      expect(colours, contains(MarkdownTheme.dark.number));
      expect(colours, contains(MarkdownTheme.dark.comment));
      // Highlighting must not rewrite the code: the reader sees it verbatim.
      final text = spansOf(tester)
          .whereType<TextSpan>()
          .map((span) => span.text ?? '')
          .join();
      expect(text, contains('final a = 42; // note'));
    });

    testWidgets('an unfinished reply gets a blinking caret', (tester) async {
      await tester.pumpWidget(
        wrap(
          const MarkdownBody(
            text: 'writing',
            streaming: true,
            selectable: false,
            theme: MarkdownTheme.dark,
          ),
        ),
      );
      expect(find.byType(FadeTransition), findsOneWidget);
      await tester.pumpWidget(
        wrap(
          const MarkdownBody(
            text: 'writing',
            selectable: false,
            theme: MarkdownTheme.dark,
          ),
        ),
      );
      expect(find.byType(FadeTransition), findsNothing);
    });

    testWidgets('a finished reply is selectable and a live one is not', (
      tester,
    ) async {
      await tester.pumpWidget(
        wrap(
          const MarkdownBody(
            text: 'done',
            selectable: true,
            theme: MarkdownTheme.dark,
          ),
        ),
      );
      expect(find.byType(SelectableText), findsOneWidget);
      await tester.pumpWidget(
        wrap(
          const MarkdownBody(
            text: 'still going',
            streaming: true,
            selectable: false,
            theme: MarkdownTheme.dark,
          ),
        ),
      );
      expect(find.byType(SelectableText), findsNothing);
    });
  });

  group('scroll follow', () {
    test('follows the tail only when the reader is at the bottom', () {
      // A short conversation fits: there is nothing to get in the way of.
      expect(followsTail(0, 0), isTrue);
      expect(followsTail(1000, 1000), isTrue);
      // Within a message of the bottom still counts, because a fling never
      // lands exactly on the maximum.
      expect(followsTail(900, 1000), isTrue);
      // Reading history must not be interrupted by an arriving reply.
      expect(followsTail(400, 1000), isFalse);
      expect(followsTail(0, 5000), isFalse);
    });

    test('keeps the reader place when older messages are prepended', () {
      // 2000 tall, reading at 1500 (500 above the bottom); the list grows to
      // 8000, so the same content now ends 500 above 8000.
      expect(offsetHoldingDistance(1500, 2000, 8000), 7500);
      expect(offsetHoldingDistance(1500, 2000, 2000), 1500);
      // Never negative, never past the new end.
      expect(offsetHoldingDistance(10, 2000, 100), 0);
      expect(offsetHoldingDistance(0, 100, 50), 0);
    });
  });
}

