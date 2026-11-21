@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

/// Runs the real Host link server (host/link.js) and talks to it from Dart.
///
/// This is the only test that pins the two production implementations together:
/// `packages/dsh_link` and `host/*.js` are written independently, so a mismatch
/// in the hello frame, the Noise prologue, the frame kinds or the RPC envelope
/// would show up here rather than on a phone.
const String _harnessExe =
    r'C:\Users\xuexu\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe';
const String _hostScript = r'D:\IDE\dsh-bot\probe\link-host-smoke.mjs';

bool _hostAvailable() {
  return File(_hostScript).existsSync() && File(_harnessExe).existsSync();
}

void main() {
  group('LAN link against the real Host server', () {
    late Process host;
    late PairingTicket ticket;

    setUpAll(() async {
      if (!_hostAvailable()) return;
      host = await Process.start(
        _harnessExe,
        [_hostScript],
        environment: {'ELECTRON_RUN_AS_NODE': '1'},
      );
      final firstLine = await host.stdout
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .first
          .timeout(const Duration(seconds: 30));
      final announcement = jsonDecode(firstLine) as Map<String, Object?>;
      ticket = PairingTicket.decode(announcement['ticket']! as String);
    });

    tearDownAll(() async {
      if (!_hostAvailable()) return;
      host.kill();
      await host.exitCode.timeout(const Duration(seconds: 10), onTimeout: () => -1);
    });

    test('completes the Noise handshake and a request/response round trip', () async {
      if (!_hostAvailable()) {
        markTestSkipped('the Host smoke script or the Harness executable is missing');
        return;
      }
      final identity = DeviceIdentity.generate();
      final link = await LinkClient.connect(ticket, identity);
      try {
        expect(link.channel.established, isTrue);
        final reply = await link.rpc.call('test/echo', {'message': 'hello from dart', 'count': 3});
        expect(reply['echoed'], {'message': 'hello from dart', 'count': 3});
        expect(reply['peer'], 'peer-under-test');
      } finally {
        await link.close();
      }
    }, timeout: const Timeout(Duration(seconds: 60)));

    test('surfaces a Host-side failure with its code and details', () async {
      if (!_hostAvailable()) {
        markTestSkipped('the Host smoke script or the Harness executable is missing');
        return;
      }
      final link = await LinkClient.connect(ticket, DeviceIdentity.generate());
      try {
        await expectLater(
          link.rpc.call('test/fail', {}),
          throwsA(isA<RpcException>()
              .having((error) => error.code, 'code', 'TEST_FAILURE')
              .having((error) => error.details['hint'], 'details.hint', 'expected')),
        );
      } finally {
        await link.close();
      }
    }, timeout: const Timeout(Duration(seconds: 60)));

    test('streams values until the Host ends the stream', () async {
      if (!_hostAvailable()) {
        markTestSkipped('the Host smoke script or the Harness executable is missing');
        return;
      }
      final link = await LinkClient.connect(ticket, DeviceIdentity.generate());
      try {
        final seen = await link.openStream('test/count', {'count': 4}).toList();
        expect(seen.map((event) => event['index']), [0, 1, 2, 3]);
      } finally {
        await link.close();
      }
    }, timeout: const Timeout(Duration(seconds: 60)));

    test('answers a forwarded question and reads the outcome back', () async {
      if (!_hostAvailable()) {
        markTestSkipped('the Host smoke script or the Harness executable is missing');
        return;
      }
      final link = await LinkClient.connect(ticket, DeviceIdentity.generate());
      try {
        final events = await RemoteEvents.open(link.rpc);
        addTearDown(events.close);
        expect(events.clientId, 'client-under-test');
        expect(events.home, '/home/test');

        final invocation = await events.invocations.first.timeout(const Duration(seconds: 10));
        expect(invocation.event, 'approval/request');
        expect(invocation.eventId, 'evt-1');
        expect(invocation.agentId, 'agent-under-test');
        expect(invocation.request['toolName'], 'shell');

        await events.answer(invocation, value: 'allowed-once');
        final recorded = await link.rpc.call('test/outcome', {});
        expect(recorded['outcomes'], [
          {
            'clientId': 'client-under-test',
            'eventId': 'evt-1',
            'outcome': {'kind': 'result', 'value': 'allowed-once'},
          }
        ]);
      } finally {
        await link.close();
      }
    }, timeout: const Timeout(Duration(seconds: 60)));

    test('refuses a client that does not know the pairing secret', () async {
      if (!_hostAvailable()) {
        markTestSkipped('the Host smoke script or the Harness executable is missing');
        return;
      }
      final forged = PairingTicket(
        hostDeviceId: ticket.hostDeviceId,
        hostPublicKey: ticket.hostPublicKey,
        hostName: ticket.hostName,
        lanEndpoints: ticket.lanEndpoints,
        pairingSecret: 'not-the-secret',
      );
      await expectLater(
        LinkClient.connect(forged, DeviceIdentity.generate()),
        throwsA(isA<LinkRefusedError>().having((error) => error.reason, 'reason', 'bad-proof')),
      );
    }, timeout: const Timeout(Duration(seconds: 60)));
  });
}
