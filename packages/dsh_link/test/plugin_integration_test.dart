@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

/// Drives the real plugin entry point (`host/index.js`), not a stand-in for it.
///
/// `link_integration_test.dart` pins the link layer; this file pins the plugin on
/// top of it — persistent identity in the credentials service, ticket issuing,
/// proof checking, key pinning on first pair, and the adapter into the Typert
/// gateway. Together they mean a green run covers the code that actually ships.
const String _harnessExe =
    r'C:\Users\xuexu\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe';
const String _hostScript = r'D:\IDE\dsh-bot\probe\plugin-host-smoke.mjs';

bool _hostAvailable() {
  return File(_hostScript).existsSync() && File(_harnessExe).existsSync();
}

void main() {
  group('the Host plugin over a LAN link', () {
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
          .timeout(const Duration(seconds: 60));
      // A Host that dies shows up as "connection refused" on the client, so keep
      // its own words visible instead of debugging a symptom.
      host.stderr.transform(utf8.decoder).listen(stderr.write);
      final announcement = jsonDecode(firstLine) as Map<String, Object?>;
      ticket = PairingTicket.decode(announcement['ticket']! as String);
    });

    tearDownAll(() async {
      if (!_hostAvailable()) return;
      host.kill();
      await host.exitCode.timeout(const Duration(seconds: 10), onTimeout: () => -1);
    });

    test('admits a scanned code and attributes calls to an owner Peer', () async {
      if (!_hostAvailable()) {
        markTestSkipped('the plugin smoke script or the Harness executable is missing');
        return;
      }
      final link = await LinkClient.connect(ticket, DeviceIdentity.generate());
      try {
        final reply = await link.rpc.call('test/echo', {'message': 'hello'});
        expect(reply['echoed'], {'message': 'hello'});
        // The plugin must hand the phone an owner Peer with interactions allowed;
        // anything less cannot open a stream or answer a forwarded event.
        expect(reply['principal'], 'owner');
        expect(reply['interactions'], 'answer');
      } finally {
        await link.close();
      }
    }, timeout: const Timeout(Duration(seconds: 60)));

    test('remembers a phone across connections and pins its key', () async {
      if (!_hostAvailable()) {
        markTestSkipped('the plugin smoke script or the Harness executable is missing');
        return;
      }
      final identity = DeviceIdentity.generate();
      final first = await LinkClient.connect(ticket, identity);
      await first.close();

      // The second connection proves the pinned-key path: no pairing secret is
      // consulted, so a stale or rotated code must not lock the phone out.
      final second = await LinkClient.connect(
        PairingTicket(
          hostDeviceId: ticket.hostDeviceId,
          hostPublicKey: ticket.hostPublicKey,
          hostName: ticket.hostName,
          lanEndpoints: ticket.lanEndpoints,
        ),
        identity,
      );
      try {
        final reply = await second.rpc.call('test/echo', {'reconnected': true});
        expect(reply['echoed'], {'reconnected': true});
      } finally {
        await second.close();
      }
    }, timeout: const Timeout(Duration(seconds: 60)));

    test('forwards a Host-side failure with its code and details', () async {
      if (!_hostAvailable()) {
        markTestSkipped('the plugin smoke script or the Harness executable is missing');
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

    test('streams through the link control endpoints', () async {
      if (!_hostAvailable()) {
        markTestSkipped('the plugin smoke script or the Harness executable is missing');
        return;
      }
      final link = await LinkClient.connect(ticket, DeviceIdentity.generate());
      try {
        final seen = await link.openStream('test/count', {'count': 5}).toList();
        expect(seen.map((event) => event['index']), [0, 1, 2, 3, 4]);
      } finally {
        await link.close();
      }
    }, timeout: const Timeout(Duration(seconds: 60)));

    test('rejects an unpaired phone that guesses the device id', () async {
      if (!_hostAvailable()) {
        markTestSkipped('the plugin smoke script or the Harness executable is missing');
        return;
      }
      await expectLater(
        LinkClient.connect(
          PairingTicket(
            hostDeviceId: ticket.hostDeviceId,
            hostPublicKey: ticket.hostPublicKey,
            hostName: ticket.hostName,
            lanEndpoints: ticket.lanEndpoints,
          ),
          DeviceIdentity.generate(),
        ),
        throwsA(isA<LinkRefusedError>().having((error) => error.reason, 'reason', 'not-paired')),
      );
    }, timeout: const Timeout(Duration(seconds: 60)));
  });
}
