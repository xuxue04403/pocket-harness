import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_harness/src/dsh/host_link.dart';

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
      expect(summary!.title, 'Untitled session');
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
