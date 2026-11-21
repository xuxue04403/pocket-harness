import 'dart:async';
import 'dart:typed_data';

import 'secure_channel.dart';

/// An in-memory [FrameTransport] pair, used by unit tests and by the desktop
/// debug page so the protocol can be exercised without a socket.
class LoopbackTransport implements FrameTransport {
  LoopbackTransport();

  final _incoming = StreamController<Uint8List>.broadcast();
  LoopbackTransport? _peer;
  bool _closed = false;

  /// Creates two transports wired to each other.
  static (LoopbackTransport, LoopbackTransport) pair() {
    final a = LoopbackTransport();
    final b = LoopbackTransport();
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
    if (_closed) throw StateError('the loopback transport is closed');
    final peer = _peer;
    if (peer == null || peer._closed) return;
    // Deliver asynchronously so sending never re-enters the caller's stack.
    scheduleMicrotask(() {
      if (!peer._incoming.isClosed) peer._incoming.add(frame);
    });
  }

  @override
  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    await _incoming.close();
  }
}
