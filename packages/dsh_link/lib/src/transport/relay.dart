import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import '../wire/codec.dart';
import 'secure_channel.dart';

/// A byte pipe to the Host that goes through a relay instead of the LAN.
///
/// The relay only knows a room name and a shared token; it copies opaque bytes.
/// Noise IK still runs end to end above it, so a relay operator cannot read a
/// prompt, a path, or a key. This is the transport used when the phone and the
/// computer are not on the same network.
class RelayTransport implements FrameTransport {
  RelayTransport._(this._socket) {
    _socket.listen(
      _onData,
      onError: (Object error, StackTrace stack) {
        if (!_ready.isCompleted) _ready.completeError(error);
        _fail(error);
      },
      onDone: () {
        if (!_ready.isCompleted) {
          _ready.completeError(StateError('the relay closed before the peer arrived'));
        }
        _fail(StateError('the relay closed the connection'));
      },
      cancelOnError: false,
    );
  }

  /// Largest frame either side may hand the relay.
  static const int maxFrameBytes = 4 * 1024 * 1024 + 64;

  final WebSocket _socket;
  final _incoming = StreamController<Uint8List>.broadcast();
  final Completer<void> _ready = Completer<void>();
  Object? _failure;
  bool _closed = false;

  @override
  Stream<Uint8List> get incoming => _incoming.stream;

  @override
  Object? get failure => _failure;

  /// Completes once the relay has paired this phone with the Host's room.
  Future<void> get ready => _ready.future;

  /// Dials a relay and waits until both ends are in the room.
  ///
  /// [url] is the relay's WebSocket endpoint, for example
  /// `wss://relay.example.com/relay`. The Host joins with `role: 'host'` and the
  /// same [room]; whichever side arrives first waits for the other.
  static Future<RelayTransport> connect({
    required Uri url,
    required String room,
    required String token,
    required String role,
    Duration timeout = const Duration(seconds: 15),
  }) async {
    final socket = await WebSocket.connect(
      url.toString(),
      compression: CompressionOptions.compressionOff,
    ).timeout(timeout);
    final transport = RelayTransport._(socket);
    try {
      // The hello must be text: the relay reads it to match a room, and treats a
      // binary first message as a protocol violation and closes.
      socket.add(utf8Text(jsonBytes({'v': 1, 'role': role, 'room': room, 'token': token})));
      await transport.ready.timeout(timeout);
      return transport;
    } on Object {
      await transport.close();
      rethrow;
    }
  }

  void _onData(Object? data) {
    if (_closed) return;
    if (data is String) {
      // Control messages carry pairing state, never payload bytes.
      Map<String, Object?> message;
      try {
        message = jsonMap(utf8Bytes(data));
      } on FormatException {
        return;
      }
      switch (message['type']) {
        case 'ready':
          if (!_ready.isCompleted) _ready.complete();
        case 'peer-gone':
          if (!_ready.isCompleted) {
            _ready.completeError(StateError('the other end left the relay'));
          } else {
            _fail(StateError('the other end left the relay'));
          }
      }
      return;
    }
    if (data is! List<int>) return;
    if (data.length > maxFrameBytes) {
      _fail(FormatException('an inbound frame of ${data.length} bytes exceeds the limit'));
      return;
    }
    if (!_incoming.isClosed) _incoming.add(Uint8List.fromList(data));
  }

  @override
  void send(Uint8List frame) {
    if (_closed) throw StateError('the relay transport is closed');
    if (frame.length > maxFrameBytes) {
      throw StateError('a frame of ${frame.length} bytes exceeds the relay limit');
    }
    try {
      _socket.add(frame);
    } on Object catch (error) {
      _fail(error);
    }
  }

  void _fail(Object error) {
    if (_closed) return;
    _failure = error;
    if (!_incoming.isClosed) {
      _incoming.addError(error);
      unawaited(_incoming.close());
    }
    unawaited(close());
  }

  @override
  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    if (!_incoming.isClosed) await _incoming.close();
    try {
      await _socket.close(WebSocketStatus.normalClosure);
    } on Object {
      // A socket that already failed needs no further cleanup.
    }
    if (!_ready.isCompleted) {
      _ready.completeError(StateError('the relay transport closed before it was ready'));
    }
  }
}
