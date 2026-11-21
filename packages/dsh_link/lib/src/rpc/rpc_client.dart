import 'dart:async';
import 'dart:typed_data';

import '../transport/secure_channel.dart';
import 'envelope.dart';

/// Endpoint the Host answers with a stream id, then pushes tagged `event`s.
const String defaultStreamOpenEndpoint = 'link/stream.open';

/// Endpoint that stops a stream on the Host.
const String defaultStreamCloseEndpoint = 'link/stream.close';

/// How often an idle link is pinged.
///
/// A relay or a carrier-grade NAT will silently drop a connection that has been
/// quiet for a few minutes, and the phone would only notice at the next prompt.
/// Pinging well below that window keeps the path proven open, and a lost reply
/// turns a dead link into a prompt error instead of a hung spinner.
const Duration defaultHeartbeatInterval = Duration(seconds: 25);

/// How long a ping may go unanswered before the link is treated as dead.
const Duration defaultHeartbeatTimeout = Duration(seconds: 10);

/// Request/response multiplexer over a [SecureChannel].
///
/// Every request gets a correlation id, so many business calls can be in flight
/// while stream values from the Host arrive on the same channel.
class RpcClient {
  RpcClient(this.channel) {
    _subscription = channel.incoming.listen(
      (bytes) {
        _lastFrameAt = DateTime.now();
        try {
          _dispatch(Envelope.decode(bytes));
        } catch (error, stack) {
          _events.addError(error, stack);
        }
      },
      onError: _events.addError,
      onDone: () {
        _stopHeartbeat();
        for (final completer in _pending.values) {
          if (!completer.isCompleted) {
            completer.completeError(StateError('the secure channel closed'));
          }
        }
        _pending.clear();
        _failStreams(StateError('the secure channel closed'));
        unawaited(_events.close());
      },
    );
  }

  final SecureChannel channel;
  final Map<String, Completer<Map<String, Object?>>> _pending = {};
  final Map<String, _PendingStream> _opening = {};
  final Map<Object, _PendingStream> _streams = {};
  final _events = StreamController<Map<String, Object?>>.broadcast();
  StreamSubscription<Uint8List>? _subscription;
  int _nextId = 1;
  bool _closed = false;

  /// When the last frame of any kind arrived, for the heartbeat's liveness test.
  DateTime? _lastFrameAt;
  Timer? _heartbeat;
  bool _pinging = false;

  /// Starts pinging an idle link so a silently dead route is noticed.
  ///
  /// Pinging is opt-in because it is extra traffic: a short-lived command line
  /// client does not need it, while a phone holding a session open for minutes
  /// does. [interval] is deliberately below any plausible idle timeout, and a
  /// ping that goes unanswered for [timeout] fails every open stream.
  void startHeartbeat({
    Duration interval = defaultHeartbeatInterval,
    Duration timeout = defaultHeartbeatTimeout,
  }) {
    if (_heartbeat != null || _closed) return;
    _lastFrameAt = DateTime.now();
    _heartbeat = Timer.periodic(interval, (_) {
      if (_closed || _pinging) return;
      final last = _lastFrameAt;
      // Any traffic proves the route, so only an idle link is worth a ping.
      if (last != null && DateTime.now().difference(last) < interval) return;
      _pinging = true;
      final sentAt = DateTime.now();
      try {
        notify('ping', {'at': sentAt.millisecondsSinceEpoch});
      } catch (_) {
        _pinging = false;
        return;
      }
      Timer(timeout, () {
        if (_closed || !_pinging) return;
        final seen = _lastFrameAt;
        if (seen != null && seen.isAfter(sentAt)) {
          _pinging = false;
          return;
        }
        _pinging = false;
        // Nothing came back, so the route is gone even though the socket is not.
        _events.addError(StateError('the link stopped answering'));
        _failStreams(StateError('the link stopped answering'));
      });
    });
  }

  void _stopHeartbeat() {
    _heartbeat?.cancel();
    _heartbeat = null;
  }

  /// Events the Host pushes that are not tied to a stream.
  Stream<Map<String, Object?>> get events => _events.stream;

  /// How many streams are currently open from this client.
  int get openStreams => _streams.length;

  /// Calls one Typert endpoint, transparently passing the arguments through.
  ///
  /// This is the only business entry point: the phone does not know what
  /// individual endpoints mean, it just forwards calls and renders replies.
  Future<Map<String, Object?>> call(
    String endpoint,
    Map<String, Object?> args, {
    Duration timeout = const Duration(seconds: 30),
  }) async {
    if (_closed) throw StateError('the RPC client is closed');
    final id = 'r${_nextId++}';
    final completer = Completer<Map<String, Object?>>();
    _pending[id] = completer;
    channel.send(Envelope.request(id, {
      'endpoint': endpoint,
      'payload': {'args': args},
    }).encode());
    try {
      return await completer.future.timeout(timeout);
    } finally {
      _pending.remove(id);
    }
  }

  /// Opens a Host stream and yields each value as it arrives.
  ///
  /// The values start flowing on the Host as soon as it answers, which can be
  /// before the caller subscribes. They therefore land in a single-subscription
  /// controller that buffers until `listen`, instead of a broadcast stream that
  /// would drop the opening burst.
  Stream<Map<String, Object?>> openStream(
    String endpoint,
    Map<String, Object?> args, {
    Duration timeout = const Duration(seconds: 30),
    String openEndpoint = defaultStreamOpenEndpoint,
    String closeEndpoint = defaultStreamCloseEndpoint,
  }) {
    if (_closed) throw StateError('the RPC client is closed');
    final id = 's${_nextId++}';
    final controller = StreamController<Map<String, Object?>>();
    final record = _PendingStream(controller, closeEndpoint);
    final timer = Timer(timeout, () {
      if (_opening.remove(id) == null) return;
      record.fail(TimeoutException('the Host did not open $endpoint in time', timeout));
    });
    record.timer = timer;
    _opening[id] = record;
    controller.onCancel = () => _cancelStream(record);
    channel.send(Envelope.request(id, {
      'endpoint': openEndpoint,
      'payload': {
        'args': {'endpoint': endpoint, 'args': args},
      },
    }).encode());
    return controller.stream;
  }

  /// Sends a one-way event or control message.
  void notify(String type, Map<String, Object?> payload) {
    if (_closed) throw StateError('the RPC client is closed');
    channel.send(Envelope(type: type, payload: payload).encode());
  }

  void _dispatch(Envelope envelope) {
    final id = envelope.id;
    if (id != null) {
      final opening = _opening[id];
      if (opening != null) {
        _onStreamOpened(id, opening, envelope);
        return;
      }
      final completer = _pending.remove(id);
      if (completer != null) {
        if (envelope.type == 'error') {
          completer.completeError(_exception(envelope.payload));
        } else if (!completer.isCompleted) {
          completer.complete(envelope.payload);
        }
        return;
      }
    }
    if (envelope.type == 'event') {
      final streamId = envelope.payload['streamId'];
      final record = streamId == null ? null : _streams[streamId];
      if (record != null) {
        _onStreamEvent(streamId!, record, envelope.payload);
        return;
      }
      if (!_events.isClosed) _events.add(envelope.payload);
      return;
    }
    // An unmatched response means the caller timed out; dropping it is correct.
  }

  void _onStreamOpened(String id, _PendingStream record, Envelope envelope) {
    _opening.remove(id);
    record.timer?.cancel();
    if (envelope.type == 'error') {
      record.fail(_exception(envelope.payload));
      return;
    }
    final streamId = envelope.payload['streamId'];
    if (streamId is! int) {
      record.fail(StateError('the Host did not return a stream id'));
      return;
    }
    record.streamId = streamId;
    if (record.cancelled) {
      _notifyClose(record, streamId);
      return;
    }
    _streams[streamId] = record;
  }

  void _onStreamEvent(Object streamId, _PendingStream record, Map<String, Object?> payload) {
    final error = payload['error'];
    if (error is Map) {
      _streams.remove(streamId);
      record.fail(RpcException(
        code: '${error['code'] ?? 'UNKNOWN'}',
        message: '${error['message'] ?? 'the stream failed'}',
        details: error['details'] is Map<String, Object?> ? error['details'] as Map<String, Object?> : const {},
      ));
      return;
    }
    if (payload['done'] == true) {
      _streams.remove(streamId);
      record.finish();
      return;
    }
    final value = payload['value'];
    record.add(value is Map<String, Object?> ? value : <String, Object?>{'value': value});
  }

  void _cancelStream(_PendingStream record) {
    record.cancelled = true;
    final streamId = record.streamId;
    if (streamId == null) return;
    _streams.remove(streamId);
    _notifyClose(record, streamId);
  }

  /// Tells the Host to stop a stream; a dead channel needs no notice.
  void _notifyClose(_PendingStream record, int streamId) {
    if (_closed) return;
    try {
      final id = 'r${_nextId++}';
      channel.send(Envelope.request(id, {
        'endpoint': record.closeEndpoint,
        'payload': {
          'args': {'streamId': streamId},
        },
      }).encode());
    } catch (_) {
      // The link is going away anyway.
    }
  }

  void _failStreams(Object error) {
    for (final record in [..._opening.values, ..._streams.values]) {
      record.fail(error);
    }
    _opening.clear();
    _streams.clear();
  }

  static RpcException _exception(Map<String, Object?> payload) {
    return RpcException(
      code: '${payload['code'] ?? 'UNKNOWN'}',
      message: '${payload['message'] ?? 'the Host reported an error'}',
      details: payload['details'] is Map<String, Object?> ? payload['details'] as Map<String, Object?> : const {},
    );
  }

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    _stopHeartbeat();
    await _subscription?.cancel();
    _subscription = null;
    for (final completer in _pending.values) {
      if (!completer.isCompleted) {
        completer.completeError(StateError('the RPC client closed'));
      }
    }
    _pending.clear();
    _failStreams(StateError('the RPC client closed'));
    await channel.close();
    if (!_events.isClosed) await _events.close();
  }
}

/// One stream between [openStream] and the Host ending it.
class _PendingStream {
  _PendingStream(this.controller, this.closeEndpoint);

  final StreamController<Map<String, Object?>> controller;
  final String closeEndpoint;
  Timer? timer;
  int? streamId;
  bool cancelled = false;

  void add(Map<String, Object?> value) {
    if (!controller.isClosed) controller.add(value);
  }

  void finish() {
    timer?.cancel();
    if (!controller.isClosed) unawaited(controller.close());
  }

  void fail(Object error) {
    timer?.cancel();
    if (controller.isClosed) return;
    controller.addError(error);
    unawaited(controller.close());
  }
}

/// A business error returned by the Host.
class RpcException implements Exception {
  RpcException({required this.code, required this.message, this.details = const {}});

  final String code;
  final String message;
  final Map<String, Object?> details;

  @override
  String toString() => 'RpcException($code): $message';
}
