import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'secure_channel.dart';

/// Length-prefixed framing over a raw byte connection.
///
/// Every frame on the wire is `[uint32 big-endian length][payload]`, so a single
/// TCP stream can carry the varying-size frames the channel produces without
/// the receiver having to guess boundaries.
class FramedSocket implements FrameTransport {
  FramedSocket._(this._socket) {
    _socket.listen(
      _onChunk,
      onError: (Object error, StackTrace stack) => _fail(error),
      onDone: () => _fail(StateError('the peer closed the connection')),
      cancelOnError: false,
    );
  }

  /// Wraps an accepted or connected socket.
  factory FramedSocket.attach(Socket socket) => FramedSocket._(socket);

  static const int maxFrameBytes = 4 * 1024 * 1024 + 64;

  final Socket _socket;
  final _incoming = StreamController<Uint8List>.broadcast();
  final _buffer = BytesBuilder(copy: false);
  final Completer<void> _closed = Completer<void>();
  Object? _failure;
  bool _disposed = false;

  @override
  Stream<Uint8List> get incoming => _incoming.stream;

  @override
  Object? get failure => _failure;

  /// Completes when the link is gone, either by [close] or by a peer failure.
  Future<void> get done => _closed.future;

  @override
  void send(Uint8List frame) {
    if (_disposed) throw StateError('the socket transport is closed');
    final header = Uint8List(4);
    ByteData.sublistView(header).setUint32(0, frame.length, Endian.big);
    try {
      _socket.add(header);
      _socket.add(frame);
    } catch (error) {
      _fail(error);
    }
  }

  void _onChunk(Uint8List chunk) {
    if (_disposed) return;
    _buffer.add(chunk);
    final bytes = _buffer.takeBytes();
    var offset = 0;
    while (bytes.length - offset >= 4) {
      final length = ByteData.sublistView(bytes, offset, offset + 4).getUint32(0, Endian.big);
      if (length > maxFrameBytes) {
        _fail(FormatException('an inbound frame of $length bytes exceeds the limit'));
        return;
      }
      if (bytes.length - offset - 4 < length) break;
      final frame = Uint8List.fromList(bytes.sublist(offset + 4, offset + 4 + length));
      offset += 4 + length;
      if (!_incoming.isClosed) _incoming.add(frame);
    }
    // Keep whatever part of the final frame has already arrived.
    if (offset < bytes.length) _buffer.add(bytes.sublist(offset));
  }

  void _fail(Object error) {
    if (_disposed) return;
    _failure = error;
    if (!_incoming.isClosed) _incoming.addError(error);
    unawaited(close());
  }

  @override
  Future<void> close() async {
    if (_disposed) return;
    _disposed = true;
    if (!_incoming.isClosed) await _incoming.close();
    try {
      await _socket.flush();
      await _socket.close();
    } catch (_) {
      // A socket that already failed needs no further cleanup.
    }
    if (!_closed.isCompleted) _closed.complete();
  }
}

/// A direct LAN link: the Host listens, the phone connects, then both sides run
/// the same Noise handshake over the resulting framed socket.
class LanLink {
  LanLink._(this.transport);

  final FramedSocket transport;

  /// Dials the Host's LAN endpoint.
  static Future<LanLink> connect(String host, int port, {Duration? timeout}) async {
    final socket = await Socket.connect(host, port, timeout: timeout ?? const Duration(seconds: 8));
    socket.setOption(SocketOption.tcpNoDelay, true);
    return LanLink._(FramedSocket.attach(socket));
  }

  /// Accepts one inbound phone connection.
  static Future<LanLink> accept(ServerSocket server) async {
    final socket = await server.first;
    socket.setOption(SocketOption.tcpNoDelay, true);
    return LanLink._(FramedSocket.attach(socket));
  }
}
