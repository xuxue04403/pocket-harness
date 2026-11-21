import 'dart:typed_data';

import 'package:crypto/crypto.dart' as c;

/// RFC 7748 X25519.
///
/// Kept in pure Dart because the protocol only performs a handful of scalar
/// multiplications per handshake, so BigInt field arithmetic is fast enough and
/// keeps the package free of native bindings (which would not survive the
/// HarmonyOS toolchain hand-off in phase two).
final BigInt _p = BigInt.parse('7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed', radix: 16);
final BigInt _a24 = BigInt.from(121665);

/// The X25519 base point (u = 9).
final Uint8List x25519BasePoint = Uint8List(32)..[0] = 9;

final BigInt _mask255 = (BigInt.one << 255) - BigInt.one;

BigInt _leToBigInt(List<int> bytes) {
  var value = BigInt.zero;
  for (var i = bytes.length - 1; i >= 0; i--) {
    value = (value << 8) | BigInt.from(bytes[i] & 0xff);
  }
  return value;
}

Uint8List _bigIntToLe(BigInt value, int length) {
  final out = Uint8List(length);
  var rest = value;
  final mask = BigInt.from(0xff);
  for (var i = 0; i < length; i++) {
    out[i] = (rest & mask).toInt();
    rest = rest >> 8;
  }
  return out;
}

BigInt _mod(BigInt value) => ((value % _p) + _p) % _p;

BigInt _modPow(BigInt base, BigInt exponent) {
  var result = BigInt.one;
  var b = _mod(base);
  var e = exponent;
  final two = BigInt.two;
  while (e > BigInt.zero) {
    if (e.isOdd) result = _mod(result * b);
    b = _mod(b * b);
    e = e ~/ two;
  }
  return result;
}

/// Computes the X25519 public key for [privateKey] (32 bytes).
Uint8List x25519PublicKey(List<int> privateKey) => x25519(privateKey, x25519BasePoint);

/// Computes the X25519 shared secret between [privateKey] and [publicKey].
Uint8List x25519(List<int> privateKey, List<int> publicKey) {
  if (privateKey.length != 32) {
    throw ArgumentError.value(privateKey.length, 'privateKey', 'must be 32 bytes');
  }
  if (publicKey.length != 32) {
    throw ArgumentError.value(publicKey.length, 'publicKey', 'must be 32 bytes');
  }
  final scalar = Uint8List.fromList(privateKey);
  scalar[0] &= 248;
  scalar[31] &= 127;
  scalar[31] |= 64;
  final k = _leToBigInt(scalar);
  final u = _leToBigInt(publicKey) & _mask255;

  var x1 = u;
  var x2 = BigInt.one;
  var z2 = BigInt.zero;
  var x3 = u;
  var z3 = BigInt.one;
  var swap = 0;

  for (var t = 254; t >= 0; t--) {
    final bit = ((k >> t) & BigInt.one).toInt();
    swap ^= bit;
    if (swap == 1) {
      final tx = x2;
      x2 = x3;
      x3 = tx;
      final tz = z2;
      z2 = z3;
      z3 = tz;
    }
    swap = bit;

    final a = _mod(x2 + z2);
    final aa = _mod(a * a);
    final b = _mod(x2 - z2);
    final bb = _mod(b * b);
    final e = _mod(aa - bb);
    final cc = _mod(x3 + z3);
    final d = _mod(x3 - z3);
    final da = _mod(d * a);
    final cb = _mod(cc * b);
    x3 = _mod((da + cb) * (da + cb));
    final diff = _mod(da - cb);
    z3 = _mod(x1 * _mod(diff * diff));
    x2 = _mod(aa * bb);
    z2 = _mod(e * _mod(aa + _a24 * e));
  }

  if (swap == 1) {
    final tx = x2;
    x2 = x3;
    x3 = tx;
    final tz = z2;
    z2 = z3;
    z3 = tz;
  }

  final result = _mod(x2 * _modPow(z2, _p - BigInt.two));
  return _bigIntToLe(result, 32);
}

/// Constant-time byte comparison.
bool constantTimeEqual(List<int> left, List<int> right) {
  if (left.length != right.length) return false;
  var different = 0;
  for (var i = 0; i < left.length; i++) {
    different |= left[i] ^ right[i];
  }
  return different == 0;
}

/// SHA-256 digest helper bound to the protocol hash name.
Uint8List sha256(List<int> data) => Uint8List.fromList(c.sha256.convert(data).bytes);

/// HMAC-SHA-256 helper used by the Noise HKDF.
Uint8List hmacSha256(List<int> key, List<int> data) =>
    Uint8List.fromList(c.Hmac(c.sha256, key).convert(data).bytes);
