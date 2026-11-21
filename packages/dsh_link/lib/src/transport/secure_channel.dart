import 'dart:async';
import 'dart:typed_data';

import '../crypto/noise_ik.dart';
import '../wire/fragment.dart';
import '../wire/frame.dart';

/// A tunnel that moves opaque binary frames between the phone and the Host.
///
/// Implementations are the plain-TCP LAN link and the relay link; both exchange
/// exactly the same frames, so everything above this interface is transport
/// agnostic.
abstract class FrameTransport {
  /// Frames arriving from the peer.
  ///
  /// Single-subscription by contract: [SecureChannel] listens exactly once for
  /// the whole lifetime of the link so no handshake frame can slip past between
  /// phases.
  Stream<Uint8List> get incoming;

  /// Sends one frame.
  void send(Uint8List frame);

  /// Closes the link. Idempotent.
  Future<void> close();

  /// Why the link closed, when it failed rather than being closed locally.
  Object? get failure;
}

/// Runs the Noise handshake over a [FrameTransport] and then seals/unseals every
/// payload that passes through.
///
/// Both sides always run this same class; only the [NoiseRole] differs.
class SecureChannel {
  SecureChannel({
    required this.transport,
    required NoiseIkSession session,
  }) : _session = session {
    // One subscription for the entire lifetime. Routing by handshake state keeps
    // the ordering correct without ever unsubscribing mid-handshake.
    _subscription = transport.incoming.listen(
      _onFrame,
      onError: (Object error, StackTrace stack) {
        _fail(error, stack);
      },
      onDone: () {
        _fail(StateError('the transport closed'), StackTrace.current);
      },
    );
  }

  final FrameTransport transport;
  final NoiseIkSession _session;

  final _incoming = StreamController<Uint8List>.broadcast();
  final _reassembler = Reassembler();
  final Completer<void> _handshakeDone = Completer<void>();
  int _nextMessageId = 1;
  bool _closed = false;
  StreamSubscription<Uint8List>? _subscription;

  /// Decrypted application messages.
  Stream<Uint8List> get incoming => _incoming.stream;

  /// Completes when the handshake finished, or with the failure that stopped it.
  Future<void> get ready => _handshakeDone.future;

  /// Whether the handshake finished and payloads may flow.
  bool get established => _handshakeDone.isCompleted && !_closed;

  /// Bytes still owed to the peer, useful for relay accounting.
  int get sendingCounter => _session.sendingCounter;

  /// Starts the handshake. For the initiator this writes message one
  /// immediately; the responder only waits for it.
  Future<void> handshake({Uint8List? payload}) {
    if (_session.complete) {
      _completeHandshake();
      return _handshakeDone.future;
    }
    if (_session.canWriteHandshake) {
      transport.send(Frame(FrameKind.handshake, _session.writeHandshake(payload)).encode());
      if (_session.complete) _completeHandshake();
    }
    return _handshakeDone.future;
  }

  /// Seals and sends one application message, fragmenting when needed.
  void send(Uint8List plaintext) {
    if (_closed) throw StateError('the secure channel is closed');
    if (!_session.complete) throw StateError('the secure channel is not established');
    final sealed = _session.encrypt(plaintext);
    final fragments = Fragment.split(sealed, _nextMessageId);
    if (fragments.isEmpty) {
      transport.send(Frame(FrameKind.secure, sealed).encode());
      return;
    }
    _nextMessageId = _nextMessageId >= 0xffffffff ? 1 : _nextMessageId + 1;
    for (final fragment in fragments) {
      transport.send(Frame(FrameKind.fragment, fragment.encode()).encode());
    }
  }

  void _onFrame(Uint8List bytes) {
    if (_closed) return;
    try {
      final frame = Frame.decode(bytes);
      if (!_session.complete) {
        _onHandshakeFrame(frame);
        return;
      }
      switch (frame.kind) {
        case FrameKind.secure:
          _emit(_session.decrypt(frame.payload));
        case FrameKind.fragment:
          final whole = _reassembler.accept(Fragment.decode(frame.payload));
          if (whole != null) _emit(_session.decrypt(whole));
        case FrameKind.control:
          // Control frames belong to the transport layer.
          break;
        case FrameKind.handshake:
          throw StateError('received a handshake frame after the handshake completed');
      }
    } catch (error, stack) {
      _fail(error, stack);
    }
  }

  void _onHandshakeFrame(Frame frame) {
    if (frame.kind != FrameKind.handshake) {
      throw StateError('expected a handshake frame, got ${frame.kind.name}');
    }
    if (!_session.isWriteTurn) {
      final payload = _session.readHandshake(frame.payload);
      if (payload.isNotEmpty) _emit(payload);
    } else {
      throw StateError('received a handshake frame while it was our turn to write');
    }
    if (_session.complete) {
      _completeHandshake();
    } else if (_session.canWriteHandshake) {
      transport.send(Frame(FrameKind.handshake, _session.writeHandshake()).encode());
      if (_session.complete) _completeHandshake();
    }
  }

  void _completeHandshake() {
    if (!_handshakeDone.isCompleted) _handshakeDone.complete();
  }

  void _emit(Uint8List plaintext) {
    if (!_incoming.isClosed) _incoming.add(plaintext);
  }

  void _fail(Object error, StackTrace stack) {
    if (_closed) return;
    if (!_handshakeDone.isCompleted) {
      _handshakeDone.completeError(error, stack);
    }
    if (!_incoming.isClosed) {
      _incoming.addError(error, stack);
    }
    unawaited(close());
  }

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    _session.destroy();
    await _subscription?.cancel();
    _subscription = null;
    await transport.close();
    if (!_incoming.isClosed) await _incoming.close();
  }
}
