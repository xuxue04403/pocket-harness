import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

/// Runs a full handshake over an in-memory transport pair.
Future<(SecureChannel, SecureChannel)> _connect() async {
  final (a, b) = LoopbackTransport.pair();
  final initiatorKeys = _keyPair(1);
  final responderKeys = _keyPair(2);
  final prologue = createNoisePrologue('conn-1', 'host-1', 'client-1');

  final client = SecureChannel(
    transport: a,
    session: NoiseIkSession(
      role: NoiseRole.initiator,
      localPrivateKey: initiatorKeys.$1,
      localPublicKey: initiatorKeys.$2,
      remotePublicKey: responderKeys.$2,
      prologue: prologue,
    ),
  );
  final host = SecureChannel(
    transport: b,
    session: NoiseIkSession(
      role: NoiseRole.responder,
      localPrivateKey: responderKeys.$1,
      localPublicKey: responderKeys.$2,
      remotePublicKey: initiatorKeys.$2,
      prologue: prologue,
    ),
  );
  await Future.wait([client.handshake(), host.handshake()]);
  return (client, host);
}

(Uint8List, Uint8List) _keyPair(int seed) {
  final private = Uint8List(32)..[0] = seed;
  return (private, x25519PublicKey(private));
}

void main() {
  group('SecureChannel', () {
    test('seals and opens a small message', () async {
      final (client, host) = await _connect();
      final received = host.incoming.first;
      client.send(Uint8List.fromList(utf8.encode('hello host')));
      expect(utf8.decode(await received), 'hello host');
      await client.close();
      await host.close();
    });

    test('fragments a message larger than one Noise frame', () async {
      final (client, host) = await _connect();
      final payload = Uint8List(maxSealedPayload * 2 + 1234);
      for (var i = 0; i < payload.length; i++) {
        payload[i] = i & 0xff;
      }
      final received = host.incoming.first;
      client.send(payload);
      expect(await received, payload);
      await client.close();
      await host.close();
    });

    test('rejects a message beyond the reassembly ceiling', () async {
      final (client, host) = await _connect();
      expect(
        () => client.send(Uint8List(maxReassembledBytes + 1)),
        throwsA(isA<ArgumentError>()),
      );
      await client.close();
      await host.close();
    });

    test('surfaces an authentication failure when a frame is corrupted', () async {
      final (a, b) = LoopbackTransport.pair();
      final initiatorKeys = _keyPair(3);
      final responderKeys = _keyPair(4);
      final prologue = createNoisePrologue('conn-2', 'host-2', 'client-2');
      final client = SecureChannel(
        transport: a,
        session: NoiseIkSession(
          role: NoiseRole.initiator,
          localPrivateKey: initiatorKeys.$1,
          localPublicKey: initiatorKeys.$2,
          remotePublicKey: responderKeys.$2,
          prologue: prologue,
        ),
      );
      final host = SecureChannel(
        transport: b,
        session: NoiseIkSession(
          role: NoiseRole.responder,
          localPrivateKey: responderKeys.$1,
          localPublicKey: responderKeys.$2,
          remotePublicKey: initiatorKeys.$2,
          prologue: prologue,
        ),
      );
      await Future.wait([client.handshake(), host.handshake()]);

      // A broadcast stream can drop events emitted before a listener attaches,
      // so the listener is installed and awaited before the bad frame is sent.
      final failure =
          host.incoming.firstWhere((_) => true).then<Object?>((_) => null, onError: (Object e) => e);

      final bad = Frame(FrameKind.secure, Uint8List(40)).encode();
      // `a` is the client's transport, so anything sent on it arrives at the
      // host, which is the side whose listener is under test.
      a.send(bad);

      final error = await failure;
      expect(
        error,
        isA<NoiseSessionError>().having((e) => e.code, 'code', 'NOISE_DECRYPT_FAILED'),
      );
      await client.close();
      await host.close();
    });
  });

  group('Fragment', () {
    test('round-trips a message split across fragments', () {
      final message = Uint8List(maxSealedPayload * 3 + 7);
      for (var i = 0; i < message.length; i++) {
        message[i] = (i * 7) & 0xff;
      }
      final reassembler = Reassembler();
      Uint8List? whole;
      for (final fragment in Fragment.split(message, 42)) {
        final decoded = Fragment.decode(fragment.encode());
        expect(decoded.messageId, 42);
        whole = reassembler.accept(decoded) ?? whole;
      }
      expect(whole, message);
      expect(reassembler.pending, 0);
    });

    test('returns no fragments when the message already fits', () {
      expect(Fragment.split(Uint8List(maxSealedPayload), 1), isEmpty);
    });

    test('rejects a fragment whose payload claims a different shape', () {
      final reassembler = Reassembler();
      reassembler.accept(Fragment(messageId: 1, index: 0, total: 2, totalBytes: 100, payload: Uint8List(50)));
      expect(
        () => reassembler.accept(
          Fragment(messageId: 1, index: 1, total: 3, totalBytes: 100, payload: Uint8List(50)),
        ),
        throwsA(isA<FormatException>()),
      );
    });

    test('drops a message as soon as its pieces exceed the size it declared', () {
      // totalBytes 是发送方的声明，也是唯一约束我们手里这堆字节的东西。只在收齐时
      // 比较，对端就能用 total 片各 48 KiB 配上 4 MiB 的声明，先把几百兆缓冲进来。
      final reassembler = Reassembler();
      final chunk = Uint8List(maxSealedPayload);
      const total = 3000;
      var accepted = 0;
      expect(
        () {
          while (accepted < total) {
            reassembler.accept(
              Fragment(
                messageId: 7,
                index: accepted,
                total: total,
                totalBytes: maxReassembledBytes,
                payload: chunk,
              ),
            );
            accepted += 1;
          }
        },
        throwsA(isA<FormatException>()),
      );
      // 4 MiB / 48 KiB ≈ 86 片，而不是 3000 片。
      expect(accepted, lessThan(100));
      expect(reassembler.pending, 0);
    });
  });

  group('Envelope', () {
    test('round-trips a request', () {
      final envelope = Envelope.request('r1', {'endpoint': 'session/list', 'payload': {'args': <String, Object?>{}}});
      final decoded = Envelope.decode(envelope.encode());
      expect(decoded.type, 'request');
      expect(decoded.id, 'r1');
      expect(decoded.payload['endpoint'], 'session/list');
    });

    test('rejects an unknown protocol version', () {
      final bytes = Uint8List.fromList(utf8.encode(jsonEncode({'v': 99, 'type': 'request'})));
      expect(() => Envelope.decode(bytes), throwsA(isA<FormatException>()));
    });
  });
}
