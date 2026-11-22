@TestOn('vm')
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

/// A Host that accepts the socket and then says nothing at all.
///
/// `LinkClient.connect` treats that as a failed endpoint and moves on to the
/// next address in the ticket, so the pipe it just gave up on has to be closed
/// on the way out. Without that, each attempt leaves a half-open socket behind:
/// on the phone a file descriptor, on the Host one of the eight link slots.
class _SilentHost {
  _SilentHost(this._server) {
    _server.listen((socket) {
      accepted += 1;
      socket.listen(
        (_) {},
        onDone: () {
          if (!closed.isCompleted) closed.complete();
        },
        onError: (Object _) {},
        cancelOnError: false,
      );
      if (!seen.isCompleted) seen.complete(socket);
    });
  }

  static Future<_SilentHost> start() async {
    final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    return _SilentHost(server);
  }

  final ServerSocket _server;
  final Completer<Socket> seen = Completer<Socket>();
  final Completer<void> closed = Completer<void>();
  int accepted = 0;

  int get port => _server.port;

  Future<void> stop() => _server.close();
}

void main() {
  group('a failed handshake', () {
    test('closes the socket it gives up on', () async {
      final host = await _SilentHost.start();
      addTearDown(host.stop);

      final identity = DeviceIdentity.generate();
      final ticket = PairingTicket(
        hostDeviceId: newDeviceId(),
        hostPublicKey: Uint8List.fromList(identity.publicKey),
        hostName: 'silent host',
        lanEndpoints: ['127.0.0.1:${host.port}'],
        pairingSecret: 'not-a-real-secret',
      );

      await expectLater(
        LinkClient.connect(
          ticket,
          identity,
          timeout: const Duration(milliseconds: 400),
        ),
        throwsA(isA<Object>()),
      );

      expect(host.accepted, 1, reason: 'the phone should have reached the silent host');
      await host.closed.future.timeout(
        const Duration(seconds: 5),
        onTimeout: () => fail('the phone left the socket open after giving up on it'),
      );
    });

    test('closes the socket when the Host refuses', () async {
      // A refusal arrives as a control frame, so this one needs a real answer.
      final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(server.close);
      final closed = Completer<void>();

      server.listen((socket) {
        socket.listen(
          (_) {
            // Answer the hello with a refusal: one control frame, `[0x04][json]`,
            // wrapped in the transport's `[uint32 BE length]` prefix.
            const reply = '{"v":1,"accepted":false,"reason":"not-paired"}';
            final body = <int>[FrameKind.control.value, ...utf8.encode(reply)];
            final header = Uint8List(4)
              ..[0] = (body.length >> 24) & 0xff
              ..[1] = (body.length >> 16) & 0xff
              ..[2] = (body.length >> 8) & 0xff
              ..[3] = body.length & 0xff;
            socket.add([...header, ...body]);
          },
          onDone: () {
            if (!closed.isCompleted) closed.complete();
          },
          onError: (Object _) {},
        );
      });

      final identity = DeviceIdentity.generate();
      final ticket = PairingTicket(
        hostDeviceId: newDeviceId(),
        hostPublicKey: Uint8List.fromList(identity.publicKey),
        hostName: 'refusing host',
        lanEndpoints: ['127.0.0.1:${server.port}'],
        pairingSecret: 'not-a-real-secret',
      );

      await expectLater(
        LinkClient.connect(ticket, identity, timeout: const Duration(milliseconds: 500)),
        throwsA(isA<LinkRefusedError>()),
      );

      await closed.future.timeout(
        const Duration(seconds: 5),
        onTimeout: () => fail('the phone left the socket open after a refusal'),
      );
    });
  });
}
