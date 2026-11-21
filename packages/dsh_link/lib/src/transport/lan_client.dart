import 'dart:async';
import 'dart:typed_data';

import '../crypto/curve25519.dart';
import '../crypto/noise_ik.dart';
import '../pairing/pairing.dart';
import '../rpc/rpc_client.dart';
import '../wire/codec.dart';
import '../wire/frame.dart';
import '../wire/fragment.dart';
import 'relay.dart';
import 'secure_channel.dart';
import 'socket_transport.dart';

/// Version of the plaintext hello exchange, matching `host/link.js`.
const int linkHelloVersion = 1;

/// Endpoints the phone uses for link-local bookkeeping rather than DSH work.
const String streamOpenEndpoint = 'link/stream.open';
const String streamCloseEndpoint = 'link/stream.close';

/// Which way the phone reached the Host.
enum LinkRoute {
  /// A direct TCP connection on the same network.
  lan,

  /// A WebSocket through a relay, for a Host behind NAT or on another network.
  relay,
}

/// Why a Host refused the connection, when it said.
class LinkRefusedError implements Exception {
  LinkRefusedError(this.reason);

  /// Short machine-readable reason, such as `not-paired` or `bad-proof`.
  final String reason;

  @override
  String toString() => 'LinkRefusedError($reason)';
}

/// An open, encrypted link to one Host, with the phone's Noise role already run.
///
/// This is the phone-side twin of `host/link.js`: the same hello exchange, the
/// same prologue, then the same [SecureChannel]. Everything above it talks to
/// [rpc], which forwards `namespace/method` calls without knowing what they mean.
///
/// Two transports carry the same bytes: a direct TCP socket on the LAN, and a
/// WebSocket through a relay for everything else. Noise runs above both, so a
/// relay operator sees only ciphertext either way.
class LinkClient {
  LinkClient._({
    required this.transport,
    required this.channel,
    required this.rpc,
    required this.route,
    required this.endpoint,
  });

  /// The framed byte pipe under the secure channel.
  final FrameTransport transport;

  /// The Noise-protected channel carrying link traffic.
  final SecureChannel channel;

  /// Request/response and stream multiplexer over [channel].
  final RpcClient rpc;

  /// Whether this link went over the LAN or a relay.
  final LinkRoute route;

  /// Where it connected, for the Host list and for diagnostics.
  final String endpoint;

  /// Connects, proves the pairing secret, then finishes the Noise handshake.
  ///
  /// LAN endpoints are tried first and a relay is the fallback, because a direct
  /// socket is faster and does not depend on a third party being up. [connectionId]
  /// is generated when omitted; the Host records it, so passing one is useful for
  /// tracing a specific attempt through Host logs.
  static Future<LinkClient> connect(
    PairingTicket ticket,
    DeviceIdentity identity, {
    String? connectionId,
    Duration timeout = const Duration(seconds: 8),
    Duration relayTimeout = const Duration(seconds: 15),
    bool heartbeat = true,
  }) async {
    final connection = connectionId ?? newDeviceId();
    final errors = <Object>[];
    for (final endpoint in ticket.lanEndpoints) {
      final parsed = parseEndpoint(endpoint);
      if (parsed == null) continue;
      final (host, port) = parsed;
      try {
        return await _connectLan(ticket, identity, connection, host, port, timeout, heartbeat);
      } on LinkRefusedError {
        // A refusal is the Host's answer, not an unreachable endpoint: every
        // address in the ticket reaches the same Host, so asking the next one
        // would only produce a misleading socket error on top of it.
        rethrow;
      } catch (error) {
        errors.add(error);
      }
    }
    if (ticket.hasRelay) {
      try {
        return await _connectRelay(ticket, identity, connection, relayTimeout, heartbeat);
      } on LinkRefusedError {
        rethrow;
      } catch (error) {
        errors.add(error);
      }
    }
    if (errors.isEmpty) {
      throw StateError(
        ticket.hasRelay
            ? 'the pairing code lists no usable LAN or relay endpoint'
            : 'the pairing code lists no usable LAN endpoint',
      );
    }
    if (errors.length == 1) throw errors.first;
    throw StateError('no endpoint answered: ${errors.join('; ')}');
  }

  static Future<LinkClient> _connectLan(
    PairingTicket ticket,
    DeviceIdentity identity,
    String connectionId,
    String host,
    int port,
    Duration timeout,
    bool heartbeat,
  ) async {
    final link = await LanLink.connect(host, port, timeout: timeout);
    return _handshake(
      ticket: ticket,
      identity: identity,
      connectionId: connectionId,
      transport: link.transport,
      timeout: timeout,
      route: LinkRoute.lan,
      endpoint: '$host:$port',
      heartbeat: heartbeat,
    );
  }

  static Future<LinkClient> _connectRelay(
    PairingTicket ticket,
    DeviceIdentity identity,
    String connectionId,
    Duration timeout,
    bool heartbeat,
  ) async {
    final url = Uri.tryParse(ticket.relayUrl!);
    if (url == null || !url.hasScheme) {
      throw StateError('the pairing code has an unusable relay address');
    }
    final transport = await RelayTransport.connect(
      url: url,
      room: ticket.relayRoom!,
      token: ticket.relayToken!,
      role: 'client',
      timeout: timeout,
    );
    return _handshake(
      ticket: ticket,
      identity: identity,
      connectionId: connectionId,
      transport: transport,
      timeout: timeout,
      route: LinkRoute.relay,
      endpoint: url.host,
      heartbeat: heartbeat,
    );
  }

  /// Runs hello, admission and Noise over an already-open byte pipe.
  static Future<LinkClient> _handshake({
    required PairingTicket ticket,
    required DeviceIdentity identity,
    required String connectionId,
    required FrameTransport transport,
    required Duration timeout,
    required LinkRoute route,
    required String endpoint,
    required bool heartbeat,
  }) async {
    // The hello answer races the transport failure; whichever lands first wins.
    final answer = transport.incoming.first.timeout(timeout);
    transport.send(
      Frame(FrameKind.control, jsonBytes(_hello(connectionId, identity, ticket))).encode(),
    );
    final reply = _readControl(await answer);
    if (reply['accepted'] != true) {
      await transport.close();
      throw LinkRefusedError('${reply['reason'] ?? 'refused'}');
    }
    if (reply['host'] != ticket.hostDeviceId) {
      await transport.close();
      throw StateError('the Host answered as ${reply['host']}, not ${ticket.hostDeviceId}');
    }

    final session = NoiseIkSession(
      role: NoiseRole.initiator,
      localPrivateKey: identity.privateKey,
      localPublicKey: identity.publicKey,
      remotePublicKey: ticket.hostPublicKey,
      prologue: createNoisePrologue(connectionId, ticket.hostDeviceId, identity.deviceId),
    );
    final channel = SecureChannel(transport: transport, session: session);
    // The initiator speaks first, so message one goes out immediately.
    unawaited(channel.handshake().catchError((Object _) {}));
    await channel.ready.timeout(timeout);
    final rpc = RpcClient(channel);
    // A phone holds a link open across screen locks and idle stretches, which is
    // exactly when a relay or a NAT drops the route without telling either end.
    // The command-line probes above do not need this, so it stays opt-in here.
    if (heartbeat) rpc.startHeartbeat();
    return LinkClient._(
      transport: transport,
      channel: channel,
      rpc: rpc,
      route: route,
      endpoint: endpoint,
    );
  }

  static Map<String, Object?> _hello(String connectionId, DeviceIdentity identity, PairingTicket ticket) {
    final secret = ticket.pairingSecret;
    return {
      'v': linkHelloVersion,
      'connection': connectionId,
      'client': identity.deviceId,
      if (secret != null)
        'proof': encodeBase64Url(
          hmacSha256(utf8Bytes(secret), utf8Bytes('v1\u0000$connectionId\u0000${identity.deviceId}')),
        ),
    };
  }

  static Map<String, Object?> _readControl(Uint8List bytes) {
    final frame = Frame.decode(bytes);
    if (frame.kind != FrameKind.control) {
      throw StateError('the Host answered with frame kind ${frame.kind.name}, not control');
    }
    return jsonMap(frame.payload);
  }

  /// Opens a stream and yields its values as they arrive.
  ///
  /// The Host answers `link/stream.open` with an id, then pushes `event`
  /// envelopes tagged with it; [RpcClient.openStream] turns that into a plain
  /// Dart stream, so callers never see the multiplexer or its buffering.
  Stream<Map<String, Object?>> openStream(
    String endpoint,
    Map<String, Object?> args, {
    Duration timeout = const Duration(seconds: 30),
  }) {
    return rpc.openStream(
      endpoint,
      args,
      timeout: timeout,
      openEndpoint: streamOpenEndpoint,
      closeEndpoint: streamCloseEndpoint,
    );
  }

  /// Closes the link and everything under it.
  Future<void> close() async {
    await rpc.close();
    await transport.close();
  }
}

/// Whether [value] is one of the frame kinds the secure channel accepts.
bool isKnownFrameKind(int value) => FrameKind.values.any((kind) => kind.value == value);

/// Largest message either end will reassemble; mirrors the Host constant.
const int maxLinkMessageBytes = maxReassembledBytes;
