import 'dart:convert';
import 'dart:typed_data';

/// Base64url without padding, which is the encoding used for every key and
/// identifier on the wire.
String encodeBase64Url(List<int> bytes) => base64Url.encode(bytes).replaceAll('=', '');

/// Decodes base64url with or without padding.
Uint8List decodeBase64Url(String value) {
  final padded = value.padRight((value.length + 3) & ~3, '=');
  return Uint8List.fromList(base64Url.decode(padded));
}

/// Encodes UTF-8 text.
Uint8List utf8Bytes(String value) => Uint8List.fromList(utf8.encode(value));

/// Decodes UTF-8 text.
String utf8Text(List<int> bytes) => utf8.decode(bytes);

/// JSON with deterministic key order is not required on the wire; compact
/// separators are, so payloads stay small over relay links.
Uint8List jsonBytes(Object? value) => utf8Bytes(jsonEncode(value));

/// Decodes a JSON document into a map.
Map<String, Object?> jsonMap(List<int> bytes) {
  final decoded = jsonDecode(utf8Text(bytes));
  if (decoded is! Map<String, Object?>) {
    throw FormatException('expected a JSON object, got ${decoded.runtimeType}');
  }
  return decoded;
}

/// Reads [length] bytes starting at [offset].
Uint8List slice(Uint8List source, int offset, int length) {
  if (offset < 0 || length < 0 || offset + length > source.length) {
    throw RangeError('slice($offset, $length) is outside ${source.length} bytes');
  }
  return Uint8List.sublistView(source, offset, offset + length);
}

/// Concatenates byte lists.
Uint8List concat(List<List<int>> parts) {
  final total = parts.fold<int>(0, (sum, part) => sum + part.length);
  final out = Uint8List(total);
  var offset = 0;
  for (final part in parts) {
    out.setRange(offset, offset + part.length, part);
    offset += part.length;
  }
  return out;
}
