// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: ds-harness-remote fixtures/crypto/v1/noise-ik.json (MIT).
// Regenerate with: node tools/gen_noise_vectors.mjs
//
// These are the protocol v1 compatibility baseline. A green test against
// them means our Noise IK wire output is byte-identical to the reference
// implementation, which is what makes us interoperable with real Hosts.

/// Protocol suite string negotiated by both peers.
const String kNoiseProtocolSuite = 'Noise_IK_25519_ChaChaPoly_SHA256';

/// Fixed protocol version for the vectors above.
const int kNoiseVectorProtocolVersion = 1;

class NoiseVector {
  const NoiseVector({
    required this.name,
    required this.initiatorPrivateKey,
    required this.initiatorPublicKey,
    required this.responderPrivateKey,
    required this.responderPublicKey,
    required this.initiatorEphemeralPrivateKey,
    required this.responderEphemeralPrivateKey,
    required this.prologueConnectionId,
    required this.prologueHostDeviceId,
    required this.prologueClientDeviceId,
    required this.prologueBytes,
    required this.message1Payload,
    required this.message1,
    required this.message2Payload,
    required this.message2,
    required this.transport,
  });

  final String name;
  final String initiatorPrivateKey;
  final String initiatorPublicKey;
  final String responderPrivateKey;
  final String responderPublicKey;
  final String initiatorEphemeralPrivateKey;
  final String responderEphemeralPrivateKey;
  final String prologueConnectionId;
  final String prologueHostDeviceId;
  final String prologueClientDeviceId;
  final String prologueBytes;
  final String message1Payload;
  final String message1;
  final String message2Payload;
  final String message2;
  final List<NoiseTransportVector> transport;
}

class NoiseTransportVector {
  const NoiseTransportVector({
    required this.fromInitiator,
    required this.plaintext,
    required this.ciphertext,
  });

  /// True when the initiator is the sender of this transport message.
  final bool fromInitiator;
  final String plaintext;
  final String ciphertext;
}

const NoiseVector kNoiseIkVector = NoiseVector(
  name: 'noise-ik-v1-deterministic',
  initiatorPrivateKey: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  initiatorPublicKey: 'j0DFrbaPJWJK5bIU6nZ6bslNgp09e14a0bpvPiE4KF8',
  responderPrivateKey: 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8',
  responderPublicKey: 'NYBy1jZYgNGu6jKa35EhODhR7SGijjt16WXQ0s0WYlQ',
  initiatorEphemeralPrivateKey: 'QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8',
  responderEphemeralPrivateKey: 'YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8',
  prologueConnectionId: 'noise-vector-connection',
  prologueHostDeviceId: 'noise-vector-host',
  prologueClientDeviceId: 'noise-vector-client',
  prologueBytes: 'RFNILVJFTU9URQB2PTEAY29ubmVjdGlvbj1ub2lzZS12ZWN0b3ItY29ubmVjdGlvbgBob3N0PW5vaXNlLXZlY3Rvci1ob3N0AGNsaWVudD1ub2lzZS12ZWN0b3ItY2xpZW50',
  message1Payload: 'Y2xpZW50LWluaXQ',
  message1: 'eaYx7t4b-cmPEgMs3q3Q56B5OY_HhriMyEbsia-FpRp-kjJIiJmQmwjR-nKoDj1SL3vwITlzJcTi-x6Vk919oaRIWCFMjsMQmpXAzkidWgV1MTVaK2PLopKyb8sR-tY1Foz-zbR5aoVUwtc',
  message2Payload: 'aG9zdC1hY2s',
  message2: 'Z13VdO13iTELPS52gfN5C0ZsdzsVIf7PNld5WDcepS_C2QNpZJIbEbA4SFnxGH_ZLHRrScqJPg8',
  transport: <NoiseTransportVector>[
    NoiseTransportVector(
      fromInitiator: true,
      plaintext: 'Y2xpZW50IHRyYW5zcG9ydCAw',
      ciphertext: 'sG_tz-hUa8eiulwCZPVQoe-Pg0FsJ-AN7VvOtq724CfMNw',
    ),
    NoiseTransportVector(
      fromInitiator: false,
      plaintext: 'aG9zdCB0cmFuc3BvcnQgMA',
      ciphertext: '7CXuhyRZeDoDWOw3AhC6OyqK3Nc6WcuWWlxcBluZ-vA',
    ),
    NoiseTransportVector(
      fromInitiator: true,
      plaintext: 'Y2xpZW50IHRyYW5zcG9ydCAx',
      ciphertext: 'YL7rVvuJNGzziHSdDihBUtjcQqjUB2SkqwdfybPbcSqPAQ',
    ),
  ],
);
