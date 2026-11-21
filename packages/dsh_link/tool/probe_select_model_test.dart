@TestOn('vm')
library;

// Proves the model picker's two calls work against a real Host: read the
// session's current route, then move it — and confirms DSH accepts the exact
// parameter names and the reasoning-effort field.
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

  test('reads a catalog, then moves one session and reads it back', () async {
    final link = await LinkClient.connect(ticket, DeviceIdentity.generate());
    try {
      final catalog = await link.rpc.call('session/modelCatalog', const {});
      final groups = catalog['groups'] as List;
      final gateway = groups.firstWhere(
        (g) => (g as Map<String, Object?>)['id'] == 'gateway',
        orElse: () => groups.first,
      ) as Map<String, Object?>;
      final models = gateway['models'] as List;
      final target = models.first as Map<String, Object?>;

      final sessions = await link.rpc.call('session/list', const {'_request': <String, Object?>{}});
      final id = ((sessions['items'] as List).first as Map<String, Object?>)['sessionId'] as String;

      final before = await link.rpc.call('session/projections', {
        'request': {'sessionId': id},
      });
      stdout.writeln('before: ${(before['values'] as Map)['modelSelection']}');

      final value = await link.rpc.call('session/selectModel', {
        'request': {
          'sessionId': id,
          'provider': gateway['id'],
          'model': target['id'],
          'reasoningEffort': 'low',
        },
      });
      stdout.writeln('selected: ${value['selected']}');
      expect(value['selected'], isA<Map<String, Object?>>());

      final after = await link.rpc.call('session/projections', {
        'request': {'sessionId': id},
      });
      final selection = (after['values'] as Map)['modelSelection'] as Map;
      stdout.writeln('after: $selection');
      expect((selection['next'] as Map)['model'], target['id']);
    } finally {
      await link.close();
    }
  }, timeout: const Timeout(Duration(seconds: 90)));
}
