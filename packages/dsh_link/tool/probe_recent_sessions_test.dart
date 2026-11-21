@TestOn('vm')
library;

// Prints the newest sessions with the fields the phone shows, so a session made
// from the app can be checked against what the Host actually recorded.
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

  test('prints the newest sessions', () async {
    final link = await LinkClient.connect(ticket, DeviceIdentity.generate());
    try {
      final value = await link.rpc.call('session/list', const {'_request': <String, Object?>{}});
      final items = value['items'] as List;
      for (final item in items.take(3)) {
        final map = item as Map<String, Object?>;
        final projections = map['projections'] as Map<String, Object?>?;
        final values = projections?['values'] as Map<String, Object?>?;
        stdout.writeln(jsonEncode({
          'sessionId': map['sessionId'],
          'cwd': map['cwd'],
          'title': values?['title'],
          'agentPreset': values?['agentPreset'],
          'blank': map['blank'],
        }));
      }
    } finally {
      await link.close();
    }
  }, timeout: const Timeout(Duration(seconds: 60)));
}
