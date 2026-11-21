@TestOn('vm')
library;

// Holds a real link open past a heartbeat interval and asserts the Host answers
// pings, so the watchdog cannot mistake a healthy idle link for a dead one.
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

  test('an idle link survives a fast heartbeat against the real Host', () async {
    final link = await LinkClient.connect(ticket, DeviceIdentity.generate(), heartbeat: false);
    try {
      var errors = 0;
      link.rpc.events.listen((_) {}, onError: (Object _) => errors++);
      // Far shorter than the production 25s, so the test does not wait.
      link.rpc.startHeartbeat(
        interval: const Duration(milliseconds: 300),
        timeout: const Duration(milliseconds: 400),
      );
      for (var round = 0; round < 4; round++) {
        await Future<void>.delayed(const Duration(milliseconds: 350));
        // Real traffic across every interval proves the link still works.
        final value = await link.rpc.call('session/list', const {'_request': <String, Object?>{}});
        expect(value['items'], isA<List>());
      }
      expect(errors, 0);
    } finally {
      await link.close();
    }
  }, timeout: const Timeout(Duration(seconds: 60)));
}
