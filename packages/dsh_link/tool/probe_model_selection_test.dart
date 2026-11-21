@TestOn('vm')
library;

// Finds where a session's current model selection is visible, so the phone's
// model picker can show what is actually selected rather than guessing.
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

  test('where the current model selection shows up', () async {
    final link = await LinkClient.connect(ticket, DeviceIdentity.generate());
    try {
      final sessions = await link.rpc.call('session/list', const {'_request': <String, Object?>{}});
      final items = sessions['items'] as List;
      final withProjections = items.where((s) => (s as Map<String, Object?>)['projections'] != null);
      stdout.writeln('sessions with projections: ${withProjections.length}/${items.length}');
      final first = withProjections.first as Map<String, Object?>;
      final values = (first['projections'] as Map<String, Object?>)['values'] as Map<String, Object?>;
      stdout.writeln('projection keys: ${values.keys.toList()}');
      stdout.writeln('modelSelection=${jsonEncode(values['modelSelection'])}');

      final id = first['sessionId'] as String;
      final projections = await link.rpc.call('session/projections', {
        'request': {'sessionId': id},
      });
      File(r'D:\IDE\dsh-bot\probe\samples\session_projections.json')
          .writeAsStringSync(const JsonEncoder.withIndent('  ').convert(projections));
      stdout.writeln('projections payload keys: ${projections.keys.toList()}');
      final projValues = projections['values'] as Map<String, Object?>?;
      if (projValues != null) {
        stdout.writeln('modelSelection=${jsonEncode(projValues['modelSelection'])}');
      }
    } finally {
      await link.close();
    }
  }, timeout: const Timeout(Duration(seconds: 60)));
}
