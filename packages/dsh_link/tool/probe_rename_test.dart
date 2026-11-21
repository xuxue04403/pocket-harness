@TestOn('vm')
library;

// Checks `session/rename` against the live Host: the parameter shape, and that
// the Host normalizes the title instead of echoing it. Run against a running
// Harness so a wrong parameter name fails loudly rather than silently.
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

  test('renames a session and returns the accepted title', () async {
    final link = await LinkClient.connect(ticket, DeviceIdentity.generate());
    try {
      final created = await link.rpc.call('session/create', {'request': <String, Object?>{}});
      final sessionId = created['sessionId'] as String;
      stdout.writeln('created $sessionId');

      final value = await link.rpc.call('session/rename', {
        'request': {'sessionId': sessionId, 'title': '  pocket harness rename probe  '},
      });
      stdout.writeln('rename -> $value');

      final title = value['title'];
      expect(title, isA<String>());
      // The Host trims; whatever it returns is what the list will show.
      expect((title as String).trim(), title);
      expect(title, contains('pocket harness rename probe'));
      expect(value['seq'], isA<int>());

      final projections = await link.rpc.call('session/projections', {
        'request': {'sessionId': sessionId},
      });
      final values = projections['values'] as Map<String, Object?>;
      stdout.writeln('projected title: ${values['title']}');
      expect(values['title'], title);
    } finally {
      await link.close();
    }
  });
}
