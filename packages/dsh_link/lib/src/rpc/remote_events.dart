// The Gateway's forwarded-event stream: how a phone answers questions the
// desktop would normally answer in its own window.
//
// Two DSH features ask the human something while a turn is blocked: approvals
// (`approval/request`) and `ask_user_question` (`user-questions/request`). Both
// are Agent-scoped Cordis waterfalls that exactly one connected client answers.
// The desktop answers them locally; a phone gets the same chance only through
// the gateway's internal `$events` stream plus the `$events/result` call.
//
// The endpoint names are the gateway's, not business `namespace/method` pairs,
// so they travel through the link untouched (see `isGatewayEndpoint` on the
// Host). This file owns everything else: correlation ids, the ready handshake,
// cancellation, and turning a waterfall into one reply.

import 'dart:async';

import 'rpc_client.dart';

/// Gateway-internal stream carrying forwarded events.
const String remoteEventStreamEndpoint = r'$events';

/// Gateway-internal unary endpoint accepting one outcome.
const String remoteEventResultEndpoint = r'$events/result';

/// One pending question the phone is expected to answer.
///
/// [request] is the raw waterfall payload: `questions` for
/// `user-questions/request`, `toolName`/`reason` for `approval/request`.
class RemoteInvocation {
  const RemoteInvocation({
    required this.event,
    required this.eventId,
    required this.agentId,
    required this.request,
  });

  /// The Cordis event name, e.g. `approval/request`.
  final String event;

  /// Correlation id echoed back in the reply.
  final String eventId;

  /// Agent that raised it; opaque to the phone.
  final String agentId;

  /// Raw request fields (never includes `agent` or `signal`).
  final Map<String, Object?> request;
}

/// One forwarded notification that needs no answer.
class RemoteNotification {
  const RemoteNotification({required this.event, required this.args});

  final String event;
  final List<Object?> args;
}

/// A live `$events` subscription.
///
/// Call [close] (or let the owning [HostLink] close) to release it: DSH treats
/// an answered waterfall as owned by the client that claimed it, so a stale
/// subscription would keep swallowing prompts.
class RemoteEvents {
  RemoteEvents._(this._rpc, this.clientId, this.home);

  final RpcClient _rpc;

  /// Gateway-assigned id; every reply must echo it.
  final String clientId;

  /// The Host's account home, used by the desktop to shorten paths.
  final String home;

  // Single-subscription controllers on purpose: Dart buffers everything added
  // before the first listener attaches, so a question that arrives while the UI
  // is still mounting is delivered instead of dropped.
  final StreamController<RemoteInvocation> _frames = StreamController<RemoteInvocation>();
  final StreamController<RemoteNotification> _notices = StreamController<RemoteNotification>.broadcast();
  final Set<String> _cancelled = <String>{};
  StreamIterator<Map<String, Object?>>? _iterator;
  bool _closed = false;

  /// Questions waiting for an answer, oldest first.
  ///
  /// Feed [invocations] instead of polling this: the stream already replays
  /// every question that arrived before it was listened to.
  Stream<RemoteInvocation> get invocations => _frames.stream;

  /// Notifications that need no answer, e.g. `session/event`.
  Stream<RemoteNotification> get notifications => _notices.stream;

  /// Whether the Host withdrew this question before the phone answered it.
  ///
  /// A withdrawn question is dead: answering it returns `gateway/...` because the
  /// waterfall no longer waits. Check this before showing a prompt that sat in a
  /// queue while another client answered.
  bool isCancelled(RemoteInvocation invocation) => _cancelled.contains(invocation.eventId);

  /// Opens the stream and waits for the gateway's `ready` frame.
  ///
  /// Throws [RpcException] when the Host refuses (older Harness builds without
  /// `@deepseek-ai/dsh-api-remotes` answer `gateway/service-unavailable`), so a
  /// caller can degrade instead of hanging.
  static Future<RemoteEvents> open(RpcClient rpc, {Duration timeout = const Duration(seconds: 15)}) async {
    final stream = rpc.openStream(remoteEventStreamEndpoint, const <String, Object?>{}, timeout: timeout);
    final iterator = StreamIterator<Map<String, Object?>>(stream);
    try {
      if (!await iterator.moveNext().timeout(timeout)) {
        throw StateError('the Host closed the event stream before it was ready');
      }
      final ready = iterator.current;
      if (ready['type'] != 'ready') {
        throw StateError('the Host did not start the event stream with ready');
      }
      final clientId = ready['clientId'];
      if (clientId is! String || clientId.isEmpty) {
        throw StateError('the Host sent no event client id');
      }
      final host = ready['host'];
      final home = host is Map<String, Object?> ? host['home'] : null;
      final events = RemoteEvents._(rpc, clientId, home is String ? home : '');
      events._pump(iterator);
      return events;
    } catch (_) {
      unawaited(iterator.cancel());
      rethrow;
    }
  }

  /// Reads frames until the Host ends the stream.
  void _pump(StreamIterator<Map<String, Object?>> iterator) {
    _iterator = iterator;
    unawaited(() async {
      try {
        while (await iterator.moveNext()) {
          if (_closed) break;
          _onFrame(iterator.current);
        }
      } catch (error) {
        if (!_closed) {
          _frames.addError(error);
          _notices.addError(error);
        }
      } finally {
        await iterator.cancel();
        if (!_closed) {
          _closed = true;
          await _frames.close();
          await _notices.close();
        }
      }
    }());
  }

  void _onFrame(Map<String, Object?> frame) {
    switch (frame['type']) {
      case 'waterfall':
        final event = frame['event'];
        final eventId = frame['eventId'];
        final agentId = frame['agentId'];
        final request = frame['request'];
        if (event is! String || eventId is! String || agentId is! String) return;
        if (_frames.isClosed) return;
        _frames.add(RemoteInvocation(
          event: event,
          eventId: eventId,
          agentId: agentId,
          request: request is Map<String, Object?> ? request : const <String, Object?>{},
        ));
      case 'emit':
        final event = frame['event'];
        final args = frame['args'];
        if (event is! String || _notices.isClosed) return;
        _notices.add(RemoteNotification(
          event: event,
          args: args is List<Object?> ? args : const <Object?>[],
        ));
      case 'cancel':
        // The Host withdrew the question (the turn aborted, or the desktop
        // answered it). Buffer ids are already handed to the UI, so remember the
        // cancellation and let `invocations` drop it.
        final eventId = frame['eventId'];
        if (eventId is String) {
          _cancelled.add(eventId);
          while (_cancelled.length > 32) {
            _cancelled.remove(_cancelled.first);
          }
        }
    }
  }

  /// Answers one invocation.
  ///
  /// [value] is the listener's return value: `'allowed-once'` or `'rejected'`
  /// for approvals, an answer batch for questions. Pass `delegate: true` to hand
  /// the question to the next listener instead (the desktop), which is what you
  /// want for anything the phone cannot render.
  Future<void> answer(RemoteInvocation invocation, {Object? value, bool delegate = false}) {
    final outcome = delegate
        ? const <String, Object?>{'kind': 'next'}
        : <String, Object?>{'kind': 'result', 'value': value};
    return _reply(invocation, outcome);
  }

  /// Rejects one invocation with an error the Host will surface to the agent.
  Future<void> reject(RemoteInvocation invocation, String message, {String? code}) {
    return _reply(invocation, <String, Object?>{
      'kind': 'rejected',
      'error': <String, Object?>{
        'name': 'Error',
        'message': message,
        if (code != null) 'code': code,
      },
    });
  }

  Future<void> _reply(RemoteInvocation invocation, Map<String, Object?> outcome) async {
    if (_closed) throw StateError('the event stream is closed');
    await _rpc.call(remoteEventResultEndpoint, <String, Object?>{
      'clientId': clientId,
      'eventId': invocation.eventId,
      'outcome': outcome,
    });
  }

  /// Releases the subscription. Safe to call twice.
  ///
  /// Cancelling the iterator makes the link tell the Host to close the stream,
  /// which is what releases the phone's claim on any pending question.
  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    final iterator = _iterator;
    _iterator = null;
    await iterator?.cancel();
    await _frames.close();
    await _notices.close();
  }
}
