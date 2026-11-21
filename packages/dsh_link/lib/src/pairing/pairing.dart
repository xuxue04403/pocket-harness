import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import '../crypto/curve25519.dart';
import '../wire/codec.dart';

/// Scheme used by the QR code the Host shows and the phone scans.
///
/// A ticket is `pocketharness://pair?t=<base64url json>`; carrying everything in
/// one code means the phone learns the Host's static key and its address in the
/// same instant, which is what makes first use trustworthy without a server.
const String pairingScheme = 'pocketharness';

/// Version of the ticket payload, bumped when a field changes meaning.
const int pairingTicketVersion = 1;

/// What the phone needs to reach one Host for the first time.
class PairingTicket {
  const PairingTicket({
    required this.hostDeviceId,
    required this.hostPublicKey,
    required this.hostName,
    this.lanEndpoints = const [],
    this.relayUrl,
    this.relayRoom,
    this.relayToken,
    this.pairingSecret,
    this.expiresAt,
  });

  /// Stable identifier of the Host installation.
  final String hostDeviceId;

  /// The Host's static X25519 public key, pinned on first pairing.
  final Uint8List hostPublicKey;

  /// Human-readable name shown in the phone's Host list.
  final String hostName;

  /// `host:port` addresses to try on the local network, best first.
  final List<String> lanEndpoints;

  /// Relay used when no LAN endpoint answers.
  final String? relayUrl;

  /// Room this Host occupies on [relayUrl].
  final String? relayRoom;

  /// Shared secret the relay requires before it will join two ends.
  ///
  /// This only proves the phone may use *this* relay room; it says nothing about
  /// the Host, which is why it travels in the same scanned code as the public key
  /// and why Noise still runs end to end above it.
  final String? relayToken;

  /// One-time secret proving the scan happened while the Host was pairing.
  final String? pairingSecret;

  /// When the ticket stops being accepted, if the Host set a deadline.
  final DateTime? expiresAt;

  /// Whether this ticket can reach the Host from outside its network.
  bool get hasRelay => relayUrl != null && relayRoom != null && relayToken != null;

  /// Whether the ticket is still usable at [now].
  bool isValidAt(DateTime now) {
    final deadline = expiresAt;
    return deadline == null || now.isBefore(deadline);
  }

  Map<String, Object?> toJson() => {
        'v': pairingTicketVersion,
        'id': hostDeviceId,
        'key': encodeBase64Url(hostPublicKey),
        'name': hostName,
        if (lanEndpoints.isNotEmpty) 'lan': lanEndpoints,
        if (relayUrl != null) 'relay': relayUrl,
        if (relayRoom != null) 'room': relayRoom,
        if (relayToken != null) 'rtok': relayToken,
        if (pairingSecret != null) 'secret': pairingSecret,
        if (expiresAt != null) 'exp': expiresAt!.toUtc().toIso8601String(),
      };

  /// The text to render into the QR code.
  String encode() => '$pairingScheme://pair?t=${encodeBase64Url(jsonBytes(toJson()))}';

  /// Parses a scanned ticket, throwing [FormatException] when it is not one.
  static PairingTicket decode(String text) {
    final trimmed = text.trim();
    final prefix = '$pairingScheme://pair';
    if (!trimmed.startsWith(prefix)) {
      throw const FormatException('not a Pocket Harness pairing code');
    }
    final separator = trimmed.indexOf('?t=');
    if (separator < 0) throw const FormatException('the pairing code has no payload');
    final Map<String, Object?> json;
    try {
      json = jsonMap(decodeBase64Url(trimmed.substring(separator + 3)));
    } on FormatException {
      throw const FormatException('the pairing code payload is not valid base64url JSON');
    }
    final version = json['v'];
    if (version != pairingTicketVersion) {
      throw FormatException('unsupported pairing code version: $version');
    }
    final id = json['id'];
    final key = json['key'];
    final name = json['name'];
    if (id is! String || id.isEmpty) throw const FormatException('the pairing code has no host id');
    if (key is! String) throw const FormatException('the pairing code has no host key');
    if (name is! String) throw const FormatException('the pairing code has no host name');
    final publicKey = decodeBase64Url(key);
    if (publicKey.length != 32) throw const FormatException('the host key must be 32 bytes');

    final lan = json['lan'];
    final relay = json['relay'];
    final room = json['room'];
    final relayToken = json['rtok'];
    final secret = json['secret'];
    final expires = json['exp'];
    return PairingTicket(
      hostDeviceId: id,
      hostPublicKey: publicKey,
      hostName: name,
      lanEndpoints: lan is List ? lan.whereType<String>().toList(growable: false) : const [],
      relayUrl: relay is String && relay.isNotEmpty ? relay : null,
      relayRoom: room is String && room.isNotEmpty ? room : null,
      relayToken: relayToken is String && relayToken.isNotEmpty ? relayToken : null,
      pairingSecret: secret is String && secret.isNotEmpty ? secret : null,
      expiresAt: expires is String ? DateTime.tryParse(expires)?.toUtc() : null,
    );
  }
}

/// The phone's (or Host's) long-lived identity: an X25519 keypair plus an id.
class DeviceIdentity {
  const DeviceIdentity({
    required this.deviceId,
    required this.privateKey,
    required this.publicKey,
  });

  final String deviceId;
  final Uint8List privateKey;
  final Uint8List publicKey;

  /// Generates a fresh identity. The id is random rather than derived, so it
  /// never leaks anything about the key.
  factory DeviceIdentity.generate({Random? random, String? deviceId}) {
    final rng = random ?? _secureRandom;
    final private = Uint8List(32);
    for (var i = 0; i < 32; i++) {
      private[i] = rng.nextInt(256);
    }
    return DeviceIdentity(
      deviceId: deviceId ?? newDeviceId(random: rng),
      privateKey: private,
      publicKey: x25519PublicKey(private),
    );
  }

  /// Restores an identity whose private key was kept in secure storage.
  factory DeviceIdentity.fromPrivateKey(String deviceId, Uint8List privateKey) {
    if (deviceId.isEmpty) throw ArgumentError.value(deviceId, 'deviceId', 'must not be empty');
    if (privateKey.length != 32) {
      throw ArgumentError.value(privateKey, 'privateKey', 'must be 32 bytes');
    }
    return DeviceIdentity(
      deviceId: deviceId,
      privateKey: privateKey,
      publicKey: x25519PublicKey(privateKey),
    );
  }

  static final Random _secureRandom = Random.secure();
}

/// A random 128-bit id in the canonical UUIDv7 shape.
///
/// The time-ordered prefix keeps device ids sortable while the random tail keeps
/// them unguessable; several transports reject anything that is not a UUID.
String newDeviceId({Random? random}) {
  final rng = random ?? Random.secure();
  final now = DateTime.now().millisecondsSinceEpoch;
  final bytes = Uint8List(16);
  for (var i = 0; i < 6; i++) {
    bytes[i] = (now >> (40 - 8 * i)) & 0xff;
  }
  for (var i = 6; i < 16; i++) {
    bytes[i] = rng.nextInt(256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  final hex = StringBuffer();
  for (var i = 0; i < bytes.length; i++) {
    if (i == 4 || i == 6 || i == 8 || i == 10) hex.write('-');
    hex.write(bytes[i].toRadixString(16).padLeft(2, '0'));
  }
  return hex.toString();
}

/// Whether [value] is shaped like a UUIDv7 or ULID.
///
/// The relay rejects device ids and frame ids in any other shape with a 4008
/// close, so this is checked before dialling rather than after.
bool isUuidV7OrUlid(String value) {
  if (value.length == 26) {
    return RegExp(r'^[0-9A-HJKMNP-TV-Z]{26}$').hasMatch(value);
  }
  if (value.length != 36) return false;
  final match = RegExp(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$')
      .hasMatch(value);
  return match;
}

/// Parses `host:port`, tolerating brackets around an IPv6 literal.
(String, int)? parseEndpoint(String endpoint) {
  final trimmed = endpoint.trim();
  if (trimmed.isEmpty) return null;
  if (trimmed.startsWith('[')) {
    final close = trimmed.indexOf(']');
    if (close < 0) return null;
    final host = trimmed.substring(1, close);
    final rest = trimmed.substring(close + 1);
    if (!rest.startsWith(':')) return null;
    final port = int.tryParse(rest.substring(1));
    return port == null ? null : (host, port);
  }
  final separator = trimmed.lastIndexOf(':');
  if (separator <= 0) return null;
  final port = int.tryParse(trimmed.substring(separator + 1));
  if (port == null) return null;
  return (trimmed.substring(0, separator), port);
}

/// Encodes a ticket payload as canonical JSON for hashing or logging counts.
int ticketFingerprint(PairingTicket ticket) {
  var hash = 0;
  for (final byte in utf8.encode(ticket.hostDeviceId)) {
    hash = (hash * 31 + byte) & 0x7fffffff;
  }
  return hash;
}
