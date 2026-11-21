@TestOn('vm')
library;

// Confirms `session/fork` on a real Harness before it gets a phone screen.
//
// The desktop can branch a conversation from an earlier turn. The wire shape is
// `{sessionId, atSeq?, allowMigration?}` answering `{sessionId}`, so the only
// question worth asking first is whether a fork shows up in the list with the
// records it was cut at.
import 'dart:convert';
import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

const _harnessExe = r'C:\Users\xuexu\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe';
const _ticketScript = r'D:\IDE\dsh-bot\probe\live-ticket.mjs';
const _ticketPath = r'D:\IDE\dsh-bot\probe\_live-ticket.txt';

void main() {
  late PairingTicket ticket;

  setUpAll(() async {
    final result = await Process.run(
      _harnessExe,
      [_ticketScript, _ticketPath],
      environment: {'ELECTRON_RUN_AS_NODE': '1'},
    );
    if (result.exitCode != 0) {
      markTestSkipped('no running Harness: ${result.stderr}');
      return;
    }
    ticket = PairingTicket.decode(File(_ticketPath).readAsStringSync().trim());
  });

  test('forks a session and reads the fork back', () async {
    final link = await LinkClient.connect(ticket, DeviceIdentity.generate());
    try {
      final created = await link.rpc.call('session/create', {
        'request': <String, Object?>{},
      });
      final sourceId = created['sessionId'] as String;
      await link.rpc.call('session/prompt', {
        'request': {
          'requestId': 'fork-probe-${DateTime.now().microsecondsSinceEpoch}',
          'sessionId': sourceId,
          'mode': 'queue',
          'content': [
            {'type': 'text', 'text': 'say hello'},
          ],
        },
      });
      // Give the turn a moment to commit an assistant message; a fork at the
      // latest completed turn is the case the phone will offer first.
      await Future<void>.delayed(const Duration(seconds: 20));

      final forked = await link.rpc.call('session/fork', {
        'request': {'sessionId': sourceId},
      });
      final forkId = forked['sessionId'];
      stdout.writeln('source=$sourceId fork=$forkId');
      expect(forkId, isA<String>());
      expect(forkId, isNot(sourceId));

      final list = await link.rpc.call('session/list', const {'_request': <String, Object?>{}});
      final ids = [
        for (final item in (list['items'] as List)) (item as Map<String, Object?>)['sessionId'],
      ];
      expect(ids, contains(forkId));

      final page = await link.rpc.call('session/page', {
        'request': {
          'address': {'kind': 'session', 'sessionId': forkId},
          'maxMessages': 10,
        },
      });
      final records = page['records'];
      stdout.writeln('fork records=${records is List ? records.length : 'none'}');
      final types = <String>{};
      if (records is List) {
        for (final record in records) {
          final event = (record as Map<String, Object?>)['event'];
          if (event is Map<String, Object?>) types.add('${event['type']}');
        }
      }
      stdout.writeln(jsonEncode({'types': types.toList()}));
    } finally {
      await link.close();
    }
  });
}
