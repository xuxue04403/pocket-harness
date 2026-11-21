import 'dart:typed_data';

/// ChaCha20-Poly1305 AEAD as specified by RFC 8439, which is what the
/// `Noise_IK_25519_ChaChaPoly_SHA256` suite requires.
///
/// Implemented in pure Dart so the same code runs on Android, Windows and
/// (in phase two) HarmonyOS without a platform-specific crypto binding.
class ChaCha20Poly1305 {
  const ChaCha20Poly1305();

  /// Tag length in bytes.
  static const int tagLength = 16;

  /// Key length in bytes.
  static const int keyLength = 32;

  /// Nonce length in bytes.
  static const int nonceLength = 12;

  /// Encrypts [plaintext], returning `ciphertext || tag`.
  Uint8List encrypt(Uint8List key, Uint8List nonce, Uint8List aad, Uint8List plaintext) {
    _checkLengths(key, nonce);
    final polyKey = _chacha20Block(key, nonce, 0);
    final ciphertext = _chacha20Xor(key, nonce, 1, plaintext);
    final tag = _poly1305(_macData(aad, ciphertext), Uint8List.sublistView(polyKey, 0, 32));
    final out = Uint8List(ciphertext.length + tagLength);
    out.setRange(0, ciphertext.length, ciphertext);
    out.setRange(ciphertext.length, out.length, tag);
    return out;
  }

  /// Verifies and decrypts `ciphertext || tag`, returning null when the tag does
  /// not authenticate the message.
  Uint8List? decrypt(Uint8List key, Uint8List nonce, Uint8List aad, Uint8List ciphertextAndTag) {
    _checkLengths(key, nonce);
    if (ciphertextAndTag.length < tagLength) return null;
    final bodyLength = ciphertextAndTag.length - tagLength;
    final ciphertext = Uint8List.sublistView(ciphertextAndTag, 0, bodyLength);
    final tag = Uint8List.sublistView(ciphertextAndTag, bodyLength);
    final polyKey = _chacha20Block(key, nonce, 0);
    final expected = _poly1305(_macData(aad, ciphertext), Uint8List.sublistView(polyKey, 0, 32));
    var different = 0;
    for (var i = 0; i < tagLength; i++) {
      different |= expected[i] ^ tag[i];
    }
    if (different != 0) return null;
    return _chacha20Xor(key, nonce, 1, ciphertext);
  }

  void _checkLengths(Uint8List key, Uint8List nonce) {
    if (key.length != keyLength) {
      throw ArgumentError.value(key.length, 'key', 'must be $keyLength bytes');
    }
    if (nonce.length != nonceLength) {
      throw ArgumentError.value(nonce.length, 'nonce', 'must be $nonceLength bytes');
    }
  }

  Uint8List _macData(Uint8List aad, Uint8List ciphertext) {
    final aadPadded = (aad.length + 15) & ~15;
    final textPadded = (ciphertext.length + 15) & ~15;
    final out = Uint8List(aadPadded + textPadded + 16);
    out.setRange(0, aad.length, aad);
    out.setRange(aadPadded, aadPadded + ciphertext.length, ciphertext);
    final lengths = ByteData.sublistView(out, aadPadded + textPadded);
    lengths.setUint64(0, aad.length, Endian.little);
    lengths.setUint64(8, ciphertext.length, Endian.little);
    return out;
  }

  Uint8List _chacha20Xor(Uint8List key, Uint8List nonce, int initialCounter, Uint8List input) {
    final out = Uint8List(input.length);
    var counter = initialCounter;
    final block = Uint8List(64);
    for (var offset = 0; offset < input.length; offset += 64) {
      _chacha20Into(key, nonce, counter, block);
      counter = (counter + 1) & 0xffffffff;
      final end = offset + 64 < input.length ? offset + 64 : input.length;
      for (var i = offset; i < end; i++) {
        out[i] = input[i] ^ block[i - offset];
      }
    }
    return out;
  }

  Uint8List _chacha20Block(Uint8List key, Uint8List nonce, int counter) {
    final out = Uint8List(64);
    _chacha20Into(key, nonce, counter, out);
    return out;
  }

  void _chacha20Into(Uint8List key, Uint8List nonce, int counter, Uint8List out) {
    final state = Uint32List(16);
    state[0] = 0x61707865;
    state[1] = 0x3320646e;
    state[2] = 0x79622d32;
    state[3] = 0x6b206574;
    final keyView = ByteData.sublistView(key);
    for (var i = 0; i < 8; i++) {
      state[4 + i] = keyView.getUint32(i * 4, Endian.little);
    }
    state[12] = counter & 0xffffffff;
    final nonceView = ByteData.sublistView(nonce);
    state[13] = nonceView.getUint32(0, Endian.little);
    state[14] = nonceView.getUint32(4, Endian.little);
    state[15] = nonceView.getUint32(8, Endian.little);

    final working = Uint32List.fromList(state);
    for (var round = 0; round < 10; round++) {
      _quarterRound(working, 0, 4, 8, 12);
      _quarterRound(working, 1, 5, 9, 13);
      _quarterRound(working, 2, 6, 10, 14);
      _quarterRound(working, 3, 7, 11, 15);
      _quarterRound(working, 0, 5, 10, 15);
      _quarterRound(working, 1, 6, 11, 12);
      _quarterRound(working, 2, 7, 8, 13);
      _quarterRound(working, 3, 4, 9, 14);
    }

    final outView = ByteData.sublistView(out);
    for (var i = 0; i < 16; i++) {
      outView.setUint32(i * 4, (working[i] + state[i]) & 0xffffffff, Endian.little);
    }
  }

  void _quarterRound(Uint32List x, int a, int b, int c, int d) {
    x[a] = (x[a] + x[b]) & 0xffffffff;
    x[d] ^= x[a];
    x[d] = ((x[d] << 16) | (x[d] >> 16)) & 0xffffffff;
    x[c] = (x[c] + x[d]) & 0xffffffff;
    x[b] ^= x[c];
    x[b] = ((x[b] << 12) | (x[b] >> 20)) & 0xffffffff;
    x[a] = (x[a] + x[b]) & 0xffffffff;
    x[d] ^= x[a];
    x[d] = ((x[d] << 8) | (x[d] >> 24)) & 0xffffffff;
    x[c] = (x[c] + x[d]) & 0xffffffff;
    x[b] ^= x[c];
    x[b] = ((x[b] << 7) | (x[b] >> 25)) & 0xffffffff;
  }

  static final BigInt _prime = (BigInt.one << 130) - BigInt.from(5);
  static final BigInt _clampMask = BigInt.parse('0ffffffc0ffffffc0ffffffc0fffffff', radix: 16);

  Uint8List _poly1305(Uint8List message, Uint8List key) {
    final r = _leToBigInt(key, 0, 16) & _clampMask;
    final s = _leToBigInt(key, 16, 32);
    var acc = BigInt.zero;
    var offset = 0;
    while (offset < message.length) {
      final end = offset + 16 < message.length ? offset + 16 : message.length;
      var blockValue = _leToBigInt(message, offset, end);
      blockValue |= BigInt.one << ((end - offset) * 8);
      acc = ((acc + blockValue) * r) % _prime;
      offset = end;
    }
    final tag = (acc + s) & ((BigInt.one << 128) - BigInt.one);
    final out = Uint8List(16);
    var rest = tag;
    final mask = BigInt.from(0xff);
    for (var i = 0; i < 16; i++) {
      out[i] = (rest & mask).toInt();
      rest = rest >> 8;
    }
    return out;
  }

  BigInt _leToBigInt(List<int> bytes, int start, int end) {
    var value = BigInt.zero;
    for (var i = end - 1; i >= start; i--) {
      value = (value << 8) | BigInt.from(bytes[i] & 0xff);
    }
    return value;
  }
}
