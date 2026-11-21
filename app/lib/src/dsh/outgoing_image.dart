import 'dart:convert';
import 'dart:typed_data';

/// One image the phone is about to send with a prompt.
///
/// DSH takes image bytes inline on `session/prompt` and promotes them to a
/// durable attachment on the Host, so the phone never invents an upload
/// protocol of its own: this class only knows how to turn picked bytes into the
/// content part DSH expects.
class OutgoingImage {
  const OutgoingImage({required this.bytes, required this.mediaType, this.name});

  final Uint8List bytes;
  final String mediaType;
  final String? name;

  /// The four types DSH accepts (`ImageMediaType` on the Host).
  static const List<String> mediaTypes = [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
  ];

  /// The media type implied by a file name, or null when DSH would reject it.
  ///
  /// The picker hands back a path, not a MIME type, and sending an image under
  /// the wrong label is refused by the Host, so the extension is the only signal
  /// worth trusting here.
  static String? mediaTypeFor(String? path) {
    if (path == null) return null;
    final dot = path.lastIndexOf('.');
    if (dot < 0 || dot == path.length - 1) return null;
    switch (path.substring(dot + 1).toLowerCase()) {
      case 'png':
        return 'image/png';
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'webp':
        return 'image/webp';
      case 'gif':
        return 'image/gif';
      default:
        return null;
    }
  }

  /// The `session/prompt` content part that carries these bytes.
  Map<String, Object?> toPart() {
    return {
      'type': 'image',
      'mediaType': mediaType,
      'data': base64Encode(bytes),
      if (name != null) 'name': name,
    };
  }
}
