import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

void main() {
  group('PairingTicket', () {
    test('survives an encode/decode round trip', () {
      final ticket = PairingTicket(
        hostDeviceId: 'host-1',
        hostPublicKey: Uint8List.fromList(List.generate(32, (i) => i)),
        hostName: '书房的台式机',
        lanEndpoints: const ['192.168.1.7:7788', '[fe80::1]:7788'],
        relayUrl: 'wss://relay.example/ws',
        pairingSecret: 'secret-1',
        expiresAt: DateTime.utc(2026, 12, 1, 12),
      );
      final decoded = PairingTicket.decode(ticket.encode());
      expect(decoded.hostDeviceId, 'host-1');
      expect(decoded.hostPublicKey, ticket.hostPublicKey);
      expect(decoded.hostName, '书房的台式机');
      expect(decoded.lanEndpoints, ['192.168.1.7:7788', '[fe80::1]:7788']);
      expect(decoded.relayUrl, 'wss://relay.example/ws');
      expect(decoded.pairingSecret, 'secret-1');
      expect(decoded.expiresAt, DateTime.utc(2026, 12, 1, 12));
    });

    test('rejects a code from another scheme', () {
      expect(() => PairingTicket.decode('https://example.com/x'), throwsA(isA<FormatException>()));
    });

    test('rejects a truncated payload', () {
      expect(() => PairingTicket.decode('pocketharness://pair?t=@@@'), throwsA(isA<FormatException>()));
    });

    test('honours the expiry deadline', () {
      final ticket = PairingTicket(
        hostDeviceId: 'h',
        hostPublicKey: Uint8List(32),
        hostName: 'n',
        expiresAt: DateTime.utc(2026),
      );
      expect(ticket.isValidAt(DateTime.utc(2025)), isTrue);
      expect(ticket.isValidAt(DateTime.utc(2027)), isFalse);
    });
  });

  group('DeviceIdentity', () {
    test('derives a public key from a restored private key', () {
      final generated = DeviceIdentity.generate(deviceId: 'dev-1');
      final restored = DeviceIdentity.fromPrivateKey('dev-1', generated.privateKey);
      expect(restored.publicKey, generated.publicKey);
    });

    test('rejects a private key of the wrong length', () {
      expect(
        () => DeviceIdentity.fromPrivateKey('dev-1', Uint8List(31)),
        throwsA(isA<ArgumentError>()),
      );
    });
  });

  group('identifiers', () {
    test('generates a UUIDv7', () {
      final id = newDeviceId();
      expect(isUuidV7OrUlid(id), isTrue, reason: id);
      expect(id[14], '7');
    });

    test('rejects malformed identifiers', () {
      expect(isUuidV7OrUlid('not-a-uuid'), isFalse);
      expect(isUuidV7OrUlid('00000000-0000-4000-8000-000000000000'), isFalse);
      // Crockford base32 has no I, L, O or U, and ULIDs are uppercase.
      expect(isUuidV7OrUlid('01JC8M8Q8Q8Q8Q8Q8Q8Q8Q8Q8U'), isFalse);
      expect(isUuidV7OrUlid('01jc8m8q8q8q8q8q8q8q8q8q8q'), isFalse);
    });

    test('parses host:port endpoints', () {
      expect(parseEndpoint('192.168.1.7:7788'), ('192.168.1.7', 7788));
      expect(parseEndpoint('[fe80::1]:7788'), ('fe80::1', 7788));
      expect(parseEndpoint('host-without-port'), isNull);
      expect(parseEndpoint(':7788'), isNull);
    });
  });

  group('LanLink', () {
    test('carries a full sealed session over a real socket', () async {
      final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close());

      final hostIdentity = DeviceIdentity.generate(deviceId: 'host-socket');
      final clientIdentity = DeviceIdentity.generate(deviceId: 'client-socket');

      final accepted = LanLink.accept(server);
      final dialed = LanLink.connect('127.0.0.1', server.port);

      final (hostLink, clientLink) = (await accepted, await dialed);
      final prologue = createNoisePrologue('conn-socket', hostIdentity.deviceId, clientIdentity.deviceId);

      final host = SecureChannel(
        transport: hostLink.transport,
        session: NoiseIkSession(
          role: NoiseRole.responder,
          localPrivateKey: hostIdentity.privateKey,
          localPublicKey: hostIdentity.publicKey,
          remotePublicKey: clientIdentity.publicKey,
          prologue: prologue,
        ),
      );
      final client = SecureChannel(
        transport: clientLink.transport,
        session: NoiseIkSession(
          role: NoiseRole.initiator,
          localPrivateKey: clientIdentity.privateKey,
          localPublicKey: clientIdentity.publicKey,
          remotePublicKey: hostIdentity.publicKey,
          prologue: prologue,
        ),
      );

      await Future.wait([client.handshake(), host.handshake()]);
      expect(client.established, isTrue);
      expect(host.established, isTrue);

      final reply = RpcClient(host);
      final caller = RpcClient(client);
      final served = reply.events.listen((event) {});
      final subscription = reply.channel.incoming.listen((bytes) async {
        final request = Envelope.decode(bytes);
        reply.notify('rpc.response', const {}); // keeps the listener honest
        final id = request.id!;
        reply.channel.send(Envelope.request(id, {
          'endpoint': request.payload['endpoint'],
          'value': '会话已就绪',
        }).encode());
      });

      final result = await caller.call('session/describe', const {'sessionId': 's1'});
      expect(result['endpoint'], 'session/describe');
      expect(result['value'], '会话已就绪');

      await subscription.cancel();
      await served.cancel();
      await caller.close();
      await reply.close();
    });
  });
}
