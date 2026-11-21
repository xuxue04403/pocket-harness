import 'dart:async';
import 'dart:typed_data';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

/// A cross-wired transport pair whose delivery can be muted.
///
/// Muting models the failure the heartbeat exists for: the socket still accepts
/// writes, so nothing looks broken locally, but no answer ever comes back.
class _Pipe implements FrameTransport {
  final _incoming = StreamController<Uint8List>.broadcast();
  final List<Uint8List> sent = [];
  _Pipe? _peer;
  bool mute = false;
  bool closed = false;

  static (_Pipe, _Pipe) pair() {
    final a = _Pipe();
    final b = _Pipe();
    a._peer = b;
    b._peer = a;
    return (a, b);
  }

  @override
  Stream<Uint8List> get incoming => _incoming.stream;

  @override
  Object? get failure => null;

  @override
  void send(Uint8List frame) {
    sent.add(frame);
    if (mute) return;
    final peer = _peer;
    if (peer == null || peer.closed) return;
    scheduleMicrotask(() {
      if (!peer._incoming.isClosed) peer._incoming.add(frame);
    });
  }

  @override
  Future<void> close() async {
    closed = true;
    await _incoming.close();
  }
}

(Uint8List, Uint8List) _keyPair(int seed) {
  final private = Uint8List(32)..[0] = seed;
  return (private, x25519PublicKey(private));
}

Future<({SecureChannel client, SecureChannel host, _Pipe clientPipe, _Pipe hostPipe})> _link(
  int seed,
) async {
  final initiatorKeys = _keyPair(seed);
  final responderKeys = _keyPair(seed + 10);
  final prologue = createNoisePrologue('conn-hb$seed', 'host-hb$seed', 'client-hb$seed');
  final (clientPipe, hostPipe) = _Pipe.pair();

  final client = SecureChannel(
    transport: clientPipe,
    session: NoiseIkSession(
      role: NoiseRole.initiator,
      localPrivateKey: initiatorKeys.$1,
      localPublicKey: initiatorKeys.$2,
      remotePublicKey: responderKeys.$2,
      prologue: prologue,
    ),
  );
  final host = SecureChannel(
    transport: hostPipe,
    session: NoiseIkSession(
      role: NoiseRole.responder,
      localPrivateKey: responderKeys.$1,
      localPublicKey: responderKeys.$2,
      remotePublicKey: initiatorKeys.$2,
      prologue: prologue,
    ),
  );
  await Future.wait([client.handshake(), host.handshake()]);
  return (client: client, host: host, clientPipe: clientPipe, hostPipe: hostPipe);
}

void main() {
  group('heartbeat', () {
    test('pings an idle link and fails it when nothing comes back', () async {
      final link = await _link(1);
      final rpc = RpcClient(link.client);
      // From here on the host answers nothing, so every ping is lost.
      link.hostPipe.mute = true;
      final before = link.clientPipe.sent.length;

      rpc.startHeartbeat(
        interval: const Duration(milliseconds: 40),
        timeout: const Duration(milliseconds: 40),
      );
      final failure = rpc.events.firstWhere((_) => false).then<Object?>(
            (_) => null,
            onError: (Object error) => error,
          );

      final error = await failure.timeout(const Duration(seconds: 3));
      expect(error, isA<StateError>());
      expect('$error', contains('stopped answering'));
      expect(link.clientPipe.sent.length, greaterThan(before));
      await rpc.close();
      await link.host.close();
    });

    test('reports nothing when the link is closed before the watchdog fires', () async {
      final link = await _link(2);
      final rpc = RpcClient(link.client);
      var errors = 0;
      rpc.events.listen((_) {}, onError: (Object _) => errors++);

      rpc.startHeartbeat(
        interval: const Duration(milliseconds: 200),
        timeout: const Duration(milliseconds: 20),
      );
      await Future<void>.delayed(const Duration(milliseconds: 30));
      await rpc.close();
      await link.host.close();
      expect(errors, 0);
      expect(link.clientPipe.closed, isTrue);
    });

    test('the first start wins, so a second call cannot shorten the interval', () async {
      final link = await _link(3);
      final rpc = RpcClient(link.client);
      final before = link.clientPipe.sent.length;
      rpc.startHeartbeat(interval: const Duration(hours: 1), timeout: const Duration(hours: 1));
      rpc.startHeartbeat(
        interval: const Duration(milliseconds: 10),
        timeout: const Duration(milliseconds: 10),
      );
      await Future<void>.delayed(const Duration(milliseconds: 60));
      // Only the hour-long timer exists, so nothing was pinged.
      expect(link.clientPipe.sent.length, before);
      await rpc.close();
      await link.host.close();
    });
  });
}
