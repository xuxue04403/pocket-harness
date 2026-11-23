import 'dart:typed_data';

import 'codec.dart';

/// Largest plaintext a single Noise transport message may carry.
///
/// The handshake and transport layers assume a single AEAD block fits well below
/// the per-frame ceiling, so anything larger is cut into fragments first.
const int maxSealedPayload = 48 * 1024;

/// Largest sealed message accepted after reassembly.
const int maxReassembledBytes = 4 * 1024 * 1024;

/// How many fragmented messages may be reassembled at the same time.
const int maxConcurrentReassembly = 8;

const int _headerBytes = 17;
const List<int> _magic = [0x44, 0x53, 0x48, 0x46]; // 'DSHF'
const int _version = 1;

/// A fragment of one oversized sealed message.
///
/// Wire layout:
/// `'DSHF' | version(1) | messageId(4) | index(2) | total(2) | totalBytes(4) | payload`.
class Fragment {
  const Fragment({
    required this.messageId,
    required this.index,
    required this.total,
    required this.totalBytes,
    required this.payload,
  });

  final int messageId;
  final int index;
  final int total;
  final int totalBytes;
  final Uint8List payload;

  Uint8List encode() {
    final out = Uint8List(_headerBytes + payload.length);
    out.setRange(0, 4, _magic);
    out[4] = _version;
    final view = ByteData.sublistView(out);
    view.setUint32(5, messageId, Endian.big);
    view.setUint16(9, index, Endian.big);
    view.setUint16(11, total, Endian.big);
    view.setUint32(13, totalBytes, Endian.big);
    out.setRange(_headerBytes, out.length, payload);
    return out;
  }

  static Fragment decode(Uint8List bytes) {
    if (bytes.length < _headerBytes) {
      throw const FormatException('fragment is shorter than its header');
    }
    for (var i = 0; i < 4; i++) {
      if (bytes[i] != _magic[i]) throw const FormatException('fragment magic mismatch');
    }
    if (bytes[4] != _version) {
      throw FormatException('unsupported fragment version ${bytes[4]}');
    }
    final view = ByteData.sublistView(bytes);
    return Fragment(
      messageId: view.getUint32(5, Endian.big),
      index: view.getUint16(9, Endian.big),
      total: view.getUint16(11, Endian.big),
      totalBytes: view.getUint32(13, Endian.big),
      payload: Uint8List.sublistView(bytes, _headerBytes),
    );
  }

  /// Cuts [message] into fragments, or returns an empty list when it fits in
  /// one transport message.
  static List<Fragment> split(Uint8List message, int messageId) {
    if (message.length <= maxSealedPayload) return const [];
    if (message.length > maxReassembledBytes) {
      throw ArgumentError.value(message.length, 'message', 'exceeds the reassembly limit');
    }
    final total = (message.length + maxSealedPayload - 1) ~/ maxSealedPayload;
    if (total > 0xffff) {
      throw ArgumentError.value(total, 'total', 'exceeds the fragment count limit');
    }
    return [
      for (var index = 0; index < total; index++)
        Fragment(
          messageId: messageId,
          index: index,
          total: total,
          totalBytes: message.length,
          payload: slice(
            message,
            index * maxSealedPayload,
            (index + 1) * maxSealedPayload > message.length
                ? message.length - index * maxSealedPayload
                : maxSealedPayload,
          ),
        ),
    ];
  }
}

/// Collects fragments until a whole message is available.
class Reassembler {
  final Map<int, _Partial> _partials = {};

  /// Adds [fragment], returning the reassembled message once the last piece
  /// arrives and null while pieces are still missing.
  Uint8List? accept(Fragment fragment) {
    if (fragment.total == 0 || fragment.index >= fragment.total) {
      throw FormatException('fragment ${fragment.index}/${fragment.total} is out of range');
    }
    if (fragment.totalBytes > maxReassembledBytes) {
      throw FormatException('reassembled message of ${fragment.totalBytes}B exceeds the limit');
    }
    final partial = _partials.putIfAbsent(
      fragment.messageId,
      () {
        if (_partials.length >= maxConcurrentReassembly) {
          // Drop the oldest in-flight message rather than growing without bound.
          _partials.remove(_partials.keys.first);
        }
        return _Partial(fragment.total, fragment.totalBytes);
      },
    );
    if (partial.total != fragment.total || partial.totalBytes != fragment.totalBytes) {
      _partials.remove(fragment.messageId);
      throw const FormatException('fragments disagree about their message shape');
    }
    final Uint8List? complete;
    try {
      complete = partial.add(fragment.index, fragment.payload);
    } on FormatException {
      // 一个不再可信的在建消息不该留在表里继续占位置。
      _partials.remove(fragment.messageId);
      rethrow;
    }
    if (complete == null) return null;
    _partials.remove(fragment.messageId);
    return complete;
  }

  /// Number of messages still waiting for fragments.
  int get pending => _partials.length;
}

class _Partial {
  _Partial(this.total, this.totalBytes);

  final int total;
  final int totalBytes;
  final Map<int, Uint8List> _pieces = {};
  int _bytes = 0;

  Uint8List? add(int index, Uint8List payload) {
    // Count as we go: [totalBytes] is the sender's claim, and it is the only
    // thing bounding what we hold. Checking it only once the last piece lands
    // lets a peer send `total` pieces of 48 KiB against a 4 MiB claim and buffer
    // hundreds of megabytes first.
    final previous = _pieces[index];
    _bytes += payload.length - (previous?.length ?? 0);
    if (_bytes > totalBytes) {
      throw const FormatException('fragments exceed the size their header declared');
    }
    _pieces[index] = payload;
    if (_pieces.length < total) return null;
    final out = Uint8List(totalBytes);
    var offset = 0;
    for (var i = 0; i < total; i++) {
      final piece = _pieces[i];
      if (piece == null) return null;
      if (offset + piece.length > totalBytes) {
        throw const FormatException('fragments overflow the declared message size');
      }
      out.setRange(offset, offset + piece.length, piece);
      offset += piece.length;
    }
    if (offset != totalBytes) {
      throw const FormatException('fragments do not cover the declared message size');
    }
    return out;
  }
}
