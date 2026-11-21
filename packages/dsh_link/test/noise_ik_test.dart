import 'dart:convert';
import 'dart:typed_data';

import 'package:dsh_link/src/crypto/curve25519.dart';
import 'package:dsh_link/src/crypto/noise_ik.dart';
import 'package:test/test.dart';

import 'vectors/noise_ik_vectors.dart';

Uint8List _b64url(String value) {
  final padded = value.padRight((value.length + 3) & ~3, '=');
  return Uint8List.fromList(base64Url.decode(padded));
}

void main() {
  group('Noise IK golden vectors', () {
    late NoiseIkSession initiator;
    late NoiseIkSession responder;
    late int ephemIndex;

    setUp(() {
      final v = kNoiseIkVector;
      ephemIndex = 0;
      final ephemerals = [
        _b64url(v.initiatorEphemeralPrivateKey),
        _b64url(v.responderEphemeralPrivateKey),
      ];
      Uint8List nextRandom(int length) {
        // Only 32-byte ephemeral requests occur during the handshake.
        expect(length, 32);
        return ephemerals[ephemIndex++];
      }

      final prologue = createNoisePrologue(
        v.prologueConnectionId,
        v.prologueHostDeviceId,
        v.prologueClientDeviceId,
      );
      expect(prologue, _b64url(v.prologueBytes), reason: 'prologue must bind the same bytes');

      initiator = NoiseIkSession(
        role: NoiseRole.initiator,
        localPrivateKey: _b64url(v.initiatorPrivateKey),
        localPublicKey: _b64url(v.initiatorPublicKey),
        remotePublicKey: _b64url(v.responderPublicKey),
        prologue: prologue,
        random: nextRandom,
      );
      responder = NoiseIkSession(
        role: NoiseRole.responder,
        localPrivateKey: _b64url(v.responderPrivateKey),
        localPublicKey: _b64url(v.responderPublicKey),
        remotePublicKey: _b64url(v.initiatorPublicKey),
        prologue: prologue,
        random: nextRandom,
      );
    });

    test('X25519 public keys derive from the fixture private keys', () {
      final v = kNoiseIkVector;
      expect(x25519PublicKey(_b64url(v.initiatorPrivateKey)), _b64url(v.initiatorPublicKey));
      expect(x25519PublicKey(_b64url(v.responderPrivateKey)), _b64url(v.responderPublicKey));
    });

    test('handshake messages are byte-identical to the reference implementation', () {
      final v = kNoiseIkVector;
      final m1 = initiator.writeHandshake(_b64url(v.message1Payload));
      expect(m1, _b64url(v.message1));

      final r1 = responder.readHandshake(m1);
      expect(r1, _b64url(v.message1Payload));

      final m2 = responder.writeHandshake(_b64url(v.message2Payload));
      expect(m2, _b64url(v.message2));

      final r2 = initiator.readHandshake(m2);
      expect(r2, _b64url(v.message2Payload));

      expect(initiator.complete, isTrue);
      expect(responder.complete, isTrue);
      expect(initiator.sendingCounter, 0);
      expect(initiator.receivingCounter, 0);
    });

    test('transport messages match the reference ciphertexts', () {
      final v = kNoiseIkVector;
      final m1 = initiator.writeHandshake(_b64url(v.message1Payload));
      responder.readHandshake(m1);
      final m2 = responder.writeHandshake(_b64url(v.message2Payload));
      initiator.readHandshake(m2);

      for (final vector in v.transport) {
        final plaintext = _b64url(vector.plaintext);
        final expected = _b64url(vector.ciphertext);
        if (vector.fromInitiator) {
          final ciphertext = initiator.encrypt(plaintext);
          expect(ciphertext, expected, reason: 'initiator transport ciphertext');
          expect(responder.decrypt(ciphertext), plaintext);
        } else {
          final ciphertext = responder.encrypt(plaintext);
          expect(ciphertext, expected, reason: 'responder transport ciphertext');
          expect(initiator.decrypt(ciphertext), plaintext);
        }
      }
    });

    test('a tampered transport message is rejected', () {
      final v = kNoiseIkVector;
      responder.readHandshake(initiator.writeHandshake(_b64url(v.message1Payload)));
      initiator.readHandshake(responder.writeHandshake(_b64url(v.message2Payload)));

      final ciphertext = initiator.encrypt(Uint8List.fromList([1, 2, 3]));
      ciphertext[0] ^= 1;
      expect(
        () => responder.decrypt(ciphertext),
        throwsA(isA<NoiseSessionError>().having((e) => e.code, 'code', 'NOISE_DECRYPT_FAILED')),
      );
    });

    test('a wrong remote static key is rejected as a peer identity mismatch', () {
      final v = kNoiseIkVector;
      // The responder trusts a different initiator key than the one that shows
      // up in message one, so the transcript must be rejected at once.
      final wrongTrustAnchor = Uint8List(32)..[0] = 9;
      final other = NoiseIkSession(
        role: NoiseRole.responder,
        localPrivateKey: _b64url(v.responderPrivateKey),
        localPublicKey: _b64url(v.responderPublicKey),
        remotePublicKey: wrongTrustAnchor,
        prologue: createNoisePrologue('noise-vector-connection', 'noise-vector-host', 'noise-vector-client'),
        random: (_) => Uint8List(32)..[0] = 7,
      );
      final m1 = initiator.writeHandshake(_b64url(v.message1Payload));
      expect(
        () => other.readHandshake(m1),
        throwsA(isA<NoiseSessionError>().having((e) => e.code, 'code', 'PEER_IDENTITY_MISMATCH')),
      );
    });
  });
}
