@TestOn('vm')
library;

// Checks the pieces a "new session" sheet needs: the preset roster, and that
// create accepts a preset plus a working directory. Run against the live Host
// so a wrong parameter name fails loudly instead of silently.
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

  test('creates a session with a preset and a working directory', () async {
    final link = await LinkClient.connect(ticket, DeviceIdentity.generate());
    try {
      final roster = await link.rpc.call('agentPresets/list', const {});
      stdout.writeln('roster: ${jsonEncode(roster)}');
      final presets = roster['presets'] as List;
      final lean = presets.map((p) => p as Map<String, Object?>).firstWhere(
            (p) => p['id'] == 'lean',
            orElse: () => presets.first as Map<String, Object?>,
          );

      final created = await link.rpc.call('session/create', {
        'request': <String, Object?>{
          'agentPreset': lean['id'],
          'cwd': r'D:\IDE\dsh-bot',
        },
      });
      stdout.writeln('created: ${jsonEncode(created)}');
      expect(created['sessionId'], isA<String>());
      expect(created['agentPreset'], lean['id']);

      final sessions = await link.rpc.call('session/list', const {'_request': <String, Object?>{}});
      final match = (sessions['items'] as List)
          .map((s) => s as Map<String, Object?>)
          .firstWhere((s) => s['sessionId'] == created['sessionId']);
      stdout.writeln('listed: ${jsonEncode(match)}');
      final projections = match['projections'] as Map<String, Object?>;
      final values = projections['values'] as Map<String, Object?>;
      expect(values['agentPreset'], lean['id']);
      expect(match['cwd'], r'D:\IDE\dsh-bot');
    } finally {
      await link.close();
    }
  }, timeout: const Timeout(Duration(seconds: 90)));
}
