@TestOn('vm')
library;

// Reads the real model catalog from the running Harness so the phone's model
// picker is written against measured data instead of a guess.
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

  test('the model catalog and one selection round-trip', () async {
    final link = await LinkClient.connect(ticket, DeviceIdentity.generate());
    try {
      final catalog = await link.rpc.call('session/modelCatalog', const {});
      File(r'D:\IDE\dsh-bot\probe\samples\model_catalog.json')
          .writeAsStringSync(const JsonEncoder.withIndent('  ').convert(catalog));
      final groups = catalog['groups'];
      expect(groups, isA<List>());
      stdout.writeln('default=${catalog['default']}');
      for (final group in groups as List) {
        final map = group as Map<String, Object?>;
        final models = map['models'] as List;
        stdout.writeln('provider ${map['id']} (${map['name']}): '
            '${models.map((m) => (m as Map<String, Object?>)['id']).join(', ')}');
        final first = models.first as Map<String, Object?>;
        stdout.writeln('  first model keys: ${first.keys.toList()}');
        if (first['reasoning'] != null) {
          stdout.writeln('  reasoning: ${first['reasoning']}');
        }
      }

      final sessions = await link.rpc.call('session/list', const {'_request': <String, Object?>{}});
      final items = sessions['items'] as List;
      final id = (items.first as Map<String, Object?>)['sessionId'] as String;
      final state = await link.rpc.call('session/state', {
        'request': {'sessionId': id},
      });
      stdout.writeln('state keys: ${state.keys.toList()}');
      stdout.writeln('state=$state');
    } finally {
      await link.close();
    }
  }, timeout: const Timeout(Duration(seconds: 60)));
}
