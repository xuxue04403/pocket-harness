import 'dart:math';
import 'dart:typed_data';

import 'chacha20_poly1305.dart';
import 'curve25519.dart';

/// The only cipher suite this protocol version negotiates.
const String noiseIkProtocol = 'Noise_IK_25519_ChaChaPoly_SHA256';

/// Thrown when a Noise session cannot proceed.
class NoiseSessionError implements Exception {
  NoiseSessionError(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => 'NoiseSessionError($code): $message';
}

/// Builds the prologue that binds a secure channel to one specific pairing.
///
/// Both peers must derive byte-identical prologues or the handshake fails at the
/// first mix, which is what prevents a relay from splicing two connections
/// together.
Uint8List createNoisePrologue(String connectionId, String hostDeviceId, String clientDeviceId) {
  final parts = <String, String>{
    'connectionId': connectionId,
    'hostDeviceId': hostDeviceId,
    'clientDeviceId': clientDeviceId,
  };
  for (final entry in parts.entries) {
    if (entry.value.isEmpty || entry.value.contains('\u0000')) {
      throw ArgumentError.value(entry.value, entry.key, 'is not safe for a Noise prologue');
    }
  }
  final text = 'DSH-REMOTE\u0000v=1\u0000connection=$connectionId'
      '\u0000host=$hostDeviceId\u0000client=$clientDeviceId';
  return Uint8List.fromList(text.codeUnits);
}

/// Noise IK handshake state plus the transport keys derived from it.
///
/// The initiator is always the mobile client and the responder is always the
/// Host, so the client knows the Host static key up front (that is the "IK"
/// part: the initiator's static key is transmitted encrypted in message one).
class NoiseIkSession {
  NoiseIkSession({
    required this.role,
    required Uint8List localPrivateKey,
    required Uint8List localPublicKey,
    required Uint8List remotePublicKey,
    required Uint8List prologue,
    Uint8List Function(int length)? random,
  })  : _localPrivate = _requireKey(localPrivateKey, 'local private key'),
        _localPublic = _requireKey(localPublicKey, 'local public key'),
        _expectedRemoteStatic = _requireKey(remotePublicKey, 'remote public key'),
        _random = random ?? _defaultRandom {
    _initSymmetric();
    _mixHash(prologue);
    // IK premessage is "<- s": both peers mix the *responder's* static key.
    _mixHash(isInitiator ? _expectedRemoteStatic : _localPublic);
    if (isInitiator) {
      _remoteStatic = Uint8List.fromList(_expectedRemoteStatic);
    }
  }

  final NoiseRole role;
  final Uint8List _localPrivate;
  final Uint8List _localPublic;
  final Uint8List _expectedRemoteStatic;
  final Uint8List Function(int length) _random;

  final Uint8List _h = Uint8List(32);
  final Uint8List _ck = Uint8List(32);
  final _cipher = const ChaCha20Poly1305();

  Uint8List? _sendingKey;
  Uint8List? _receivingKey;
  Uint8List _key = Uint8List(32);
  int _nonce = 0;

  Uint8List? _remoteStatic;
  Uint8List? _ephemeralPrivate;
  Uint8List? _remoteEphemeral;

  int _writes = 0;
  int _reads = 0;
  bool _destroyed = false;

  bool get isInitiator => role == NoiseRole.initiator;

  String get protocol => noiseIkProtocol;

  /// Whether the handshake completed and transport messages may be exchanged.
  ///
  /// IK carries exactly two handshake messages: the initiator writes one then
  /// reads one, and the responder reads one then writes one. Both peers are
  /// therefore finished once each has written once and read once.
  bool get complete => _writes > 0 && _reads > 0;

  /// Whether this peer's next action is writing a handshake message.
  bool get canWriteHandshake {
    _assertLive();
    return !complete && isWriteTurn;
  }

  /// The initiator opens the handshake; the responder may only write its single
  /// message after it has read the initiator's.
  bool get isWriteTurn {
    if (isInitiator) return _writes == 0;
    return _reads == 1 && _writes == 0;
  }

  /// The peer static key learned (responder) or configured (initiator).
  Uint8List? get remoteStatic => _remoteStatic;

  int get sendingCounter => _sendingKey == null ? 0 : _sendingCounter;

  int get receivingCounter => _receivingKey == null ? 0 : _receivingCounter;

  /// Writes the next handshake message, appending [payload].
  Uint8List writeHandshake([Uint8List? payload]) {
    _assertHandshake(reading: false);
    final out = BytesBuilder(copy: false);
    if (isInitiator) {
      // IK message one: e, es, s, ss.
      _writeEphemeral(out);
      _mixKey(x25519(_ephemeralPrivate!, _expectedRemoteStatic)); // es
      out.add(_encryptAndHash(_localPublic)); // s
      _mixKey(x25519(_localPrivate, _expectedRemoteStatic)); // ss
    } else {
      // IK message two: e, ee, se.
      _writeEphemeral(out);
      _mixKey(x25519(_ephemeralPrivate!, _remoteEphemeral!)); // ee
      _mixKey(x25519(_ephemeralPrivate!, _remoteStatic!)); // se
    }
    // Noise always appends the payload ciphertext, even when the payload is
    // empty: that still emits a 16-byte tag over the running hash, and the peer
    // unconditionally authenticates whatever trails the tokens.
    out.add(_encryptAndHash(payload ?? Uint8List(0)));
    _writes += 1;
    _finishIfReady();
    return out.toBytes();
  }

  /// Reads the next handshake message, returning the decrypted payload.
  Uint8List readHandshake(Uint8List message) {
    _assertHandshake(reading: true);
    var offset = 0;
    Uint8List take(int length) {
      if (offset + length > message.length) {
        throw NoiseSessionError('NOISE_HANDSHAKE_ORDER', 'The Noise handshake message is truncated.');
      }
      final slice = Uint8List.fromList(message.sublist(offset, offset + length));
      offset += length;
      return slice;
    }

    if (isInitiator) {
      // Responder's message two: e, ee, se.
      final ephemeral = take(32);
      _remoteEphemeral = ephemeral;
      _mixHash(ephemeral);
      _mixKey(x25519(_ephemeralPrivate!, ephemeral)); // ee
      _mixKey(x25519(_localPrivate, ephemeral)); // se
      // The initiator is the sender of every `se` token, so it uses its own
      // private key (this branch) while the responder uses its own private key
      // together with the initiator ephemeral (the responder branch below).
    } else {
      // Initiator's message one: e, es, s, ss.
      final ephemeral = take(32);
      _remoteEphemeral = ephemeral;
      _mixHash(ephemeral);
      _mixKey(x25519(_localPrivate, ephemeral)); // es
      _remoteStatic = _decryptAndHash(take(32 + 16)); // s
      _mixKey(x25519(_localPrivate, _remoteStatic!)); // ss
      _verifyRemoteStatic();
    }
    final payload = _decryptAndHash(Uint8List.sublistView(message, offset));
    _reads += 1;
    _finishIfReady();
    return payload;
  }

  /// Encrypts one transport message. Each direction has an independent counter.
  Uint8List encrypt(Uint8List plaintext) {
    _assertLive();
    final key = _sendingKey;
    if (key == null) throw NoiseSessionError('NOISE_NOT_READY', 'The Noise handshake is not complete.');
    final counter = _sendingCounter;
    final out = _cipher.encrypt(key, _nonceBytes(counter), Uint8List(0), plaintext);
    _sendingCounter = counter + 1;
    return out;
  }

  /// Decrypts one transport message, throwing when authentication fails.
  Uint8List decrypt(Uint8List ciphertext) {
    _assertLive();
    final key = _receivingKey;
    if (key == null) throw NoiseSessionError('NOISE_NOT_READY', 'The Noise handshake is not complete.');
    final counter = _receivingCounter;
    final plaintext = _cipher.decrypt(key, _nonceBytes(counter), Uint8List(0), ciphertext);
    if (plaintext == null) {
      throw NoiseSessionError('NOISE_DECRYPT_FAILED', 'The Noise transport message failed authentication.');
    }
    _receivingCounter = counter + 1;
    return plaintext;
  }

  void destroy() {
    if (_destroyed) return;
    _destroyed = true;
    _expectedRemoteStatic.fillRange(0, _expectedRemoteStatic.length, 0);
    _sendingKey = null;
    _receivingKey = null;
    _remoteStatic = null;
    _ephemeralPrivate = null;
    _remoteEphemeral = null;
  }

  int _sendingCounter = 0;
  int _receivingCounter = 0;

  void _initSymmetric() {
    final name = Uint8List.fromList(noiseIkProtocol.codeUnits);
    if (name.length <= 32) {
      _h.fillRange(0, _h.length, 0);
      _h.setRange(0, name.length, name);
    } else {
      _h.setAll(0, sha256(name));
    }
    _ck.setAll(0, _h);
  }

  void _mixHash(List<int> data) {
    final joined = Uint8List(_h.length + data.length)
      ..setRange(0, _h.length, _h)
      ..setRange(_h.length, _h.length + data.length, data);
    _h.setAll(0, sha256(joined));
  }

  void _mixKey(List<int> inputKeyMaterial) {
    final tempKey = hmacSha256(_ck, inputKeyMaterial);
    final out1 = hmacSha256(tempKey, const [0x01]);
    final out2 = hmacSha256(tempKey, Uint8List.fromList([...out1, 0x02]));
    _ck.setAll(0, out1);
    _key = out2;
    _nonce = 0;
  }

  Uint8List _encryptAndHash(Uint8List plaintext) {
    final ciphertext = _cipher.encrypt(_key, _nonceBytes(_nonce), _h, plaintext);
    _nonce += 1;
    _mixHash(ciphertext);
    return ciphertext;
  }

  Uint8List _decryptAndHash(Uint8List ciphertext) {
    final plaintext = _cipher.decrypt(_key, _nonceBytes(_nonce), _h, ciphertext);
    if (plaintext == null) {
      throw NoiseSessionError('NOISE_DECRYPT_FAILED', 'A Noise handshake message failed authentication.');
    }
    _nonce += 1;
    _mixHash(ciphertext);
    return plaintext;
  }

  void _writeEphemeral(BytesBuilder out) {
    final private = _random(32);
    final public = x25519PublicKey(private);
    _ephemeralPrivate = private;
    out.add(public);
    _mixHash(public);
  }

  void _finishIfReady() {
    // Both peers are done once each has written and read one message; the split
    // keys are derived exactly once, at that moment.
    if (_sendingKey != null || _writes == 0 || _reads == 0) return;
    final tempKey = hmacSha256(_ck, Uint8List(0));
    final out1 = hmacSha256(tempKey, const [0x01]);
    final out2 = hmacSha256(tempKey, Uint8List.fromList([...out1, 0x02]));
    if (isInitiator) {
      _sendingKey = out1;
      _receivingKey = out2;
    } else {
      _sendingKey = out2;
      _receivingKey = out1;
    }
    _sendingCounter = 0;
    _receivingCounter = 0;
  }

  void _verifyRemoteStatic() {
    final actual = _remoteStatic;
    if (actual == null || !constantTimeEqual(actual, _expectedRemoteStatic)) {
      destroy();
      throw NoiseSessionError('PEER_IDENTITY_MISMATCH', 'The Noise peer static key does not match local trust.');
    }
  }

  void _assertHandshake({required bool reading}) {
    _assertLive();
    if (complete) {
      throw NoiseSessionError('NOISE_ALREADY_READY', 'The Noise handshake is already complete.');
    }
    if (isWriteTurn == reading) {
      throw NoiseSessionError('NOISE_HANDSHAKE_ORDER', 'The Noise handshake message arrived out of order.');
    }
  }

  void _assertLive() {
    if (_destroyed) throw NoiseSessionError('NOISE_DESTROYED', 'The Noise session is closed.');
  }

  static Uint8List _nonceBytes(int counter) {
    final out = Uint8List(12);
    final view = ByteData.sublistView(out);
    view.setUint32(0, 0, Endian.little);
    view.setUint32(4, counter & 0xffffffff, Endian.little);
    view.setUint32(8, (counter >> 32) & 0xffffffff, Endian.little);
    return out;
  }

  static Uint8List _requireKey(Uint8List key, String label) {
    if (key.length != 32) {
      throw NoiseSessionError('INVALID_KEY', '$label must be a 32-byte X25519 key.');
    }
    return Uint8List.fromList(key);
  }

  static final _secureRandom = Random.secure();

  static Uint8List _defaultRandom(int length) {
    final values = Uint8List(length);
    for (var i = 0; i < length; i++) {
      values[i] = _secureRandom.nextInt(256);
    }
    return values;
  }
}

/// Which side of the handshake this peer plays.
enum NoiseRole { initiator, responder }
