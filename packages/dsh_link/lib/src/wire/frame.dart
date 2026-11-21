import 'dart:typed_data';

/// Binary frame kinds exchanged over a tunnel socket.
///
/// The data path avoids JSON: only [FrameKind.control] carries text, and that
/// is limited to pre-handshake relay routing and liveness probes. Everything a
/// user types travels inside [FrameKind.secure].
enum FrameKind {
  /// One Noise handshake message (message one from client, two from Host).
  handshake(0x01),

  /// One Noise transport message: AEAD ciphertext of a sealed envelope.
  secure(0x02),

  /// One fragment of a large sealed message.
  fragment(0x03),

  /// Plaintext JSON, used only for relay attach and keepalive.
  control(0x04);

  const FrameKind(this.value);

  final int value;

  static FrameKind fromValue(int value) {
    for (final kind in FrameKind.values) {
      if (kind.value == value) return kind;
    }
    throw FormatException('unknown frame kind 0x${value.toRadixString(16)}');
  }
}

/// A single wire frame.
class Frame {
  const Frame(this.kind, this.payload);

  final FrameKind kind;
  final Uint8List payload;

  /// Serializes to `[kind][payload]`.
  Uint8List encode() {
    final out = Uint8List(payload.length + 1);
    out[0] = kind.value;
    out.setRange(1, out.length, payload);
    return out;
  }

  /// Parses `[kind][payload]`.
  static Frame decode(Uint8List bytes) {
    if (bytes.isEmpty) throw const FormatException('empty frame');
    final kind = FrameKind.fromValue(bytes[0]);
    return Frame(kind, Uint8List.sublistView(bytes, 1));
  }

  @override
  String toString() => 'Frame(${kind.name}, ${payload.length}B)';
}
