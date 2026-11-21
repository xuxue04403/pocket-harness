/// Pocket Harness link layer: pairing, Noise IK, framing, and the RPC carrier
/// that rides on top of a sealed channel.
library;

export 'src/crypto/chacha20_poly1305.dart';
export 'src/crypto/curve25519.dart';
export 'src/crypto/noise_ik.dart';
export 'src/pairing/pairing.dart';
export 'src/rpc/envelope.dart';
export 'src/rpc/rpc_client.dart';
export 'src/transport/lan_client.dart';
export 'src/transport/relay.dart';
export 'src/transport/loopback.dart';
export 'src/transport/secure_channel.dart';
export 'src/transport/socket_transport.dart';
export 'src/wire/codec.dart';
export 'src/wire/fragment.dart';
export 'src/wire/frame.dart';
