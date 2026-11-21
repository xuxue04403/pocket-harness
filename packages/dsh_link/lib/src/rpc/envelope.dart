import 'dart:typed_data';

import '../wire/codec.dart';

/// Message envelope carried inside the sealed channel.
///
/// The shape is intentionally close to the DSH Typert carrier so the Host can
/// forward business calls without re-encoding arguments.
class Envelope {
  const Envelope({
    required this.type,
    required this.payload,
    this.id,
  });

  /// `request`, `response`, `error`, `event`, or `ping`/`pong`.
  final String type;

  /// Correlation id; present for request/response pairs.
  final String? id;

  final Map<String, Object?> payload;

  bool get isResponse => type == 'response' || type == 'error';

  /// Builds a request envelope.
  factory Envelope.request(String id, Map<String, Object?> payload) =>
      Envelope(type: 'request', id: id, payload: payload);

  /// Builds a successful response envelope.
  factory Envelope.response(String id, Map<String, Object?> payload) =>
      Envelope(type: 'response', id: id, payload: payload);

  /// Builds an error response envelope.
  factory Envelope.error(String id, String code, String message, [Map<String, Object?> details = const {}]) =>
      Envelope(type: 'error', id: id, payload: {'code': code, 'message': message, 'details': details});

  /// Builds a server-initiated event envelope.
  factory Envelope.event(Map<String, Object?> payload) => Envelope(type: 'event', payload: payload);

  Uint8List encode() => jsonBytes(toJson());

  Map<String, Object?> toJson() => {
        'v': protocolVersion,
        if (id != null) 'id': id,
        'type': type,
        'timestamp': DateTime.now().millisecondsSinceEpoch,
        'payload': payload,
      };

  static Envelope decode(Uint8List bytes) {
    final map = jsonMap(bytes);
    final version = map['v'];
    if (version != protocolVersion) {
      throw FormatException('unsupported envelope version $version');
    }
    final type = map['type'];
    if (type is! String) throw const FormatException('envelope is missing a type');
    final payload = map['payload'];
    if (payload is! Map<String, Object?>) {
      throw const FormatException('envelope is missing a payload');
    }
    final id = map['id'];
    return Envelope(
      type: type,
      id: id is String ? id : null,
      payload: payload,
    );
  }
}

/// The only protocol version this build speaks.
const int protocolVersion = 1;
