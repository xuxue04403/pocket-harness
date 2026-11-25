import 'dart:convert';
import 'dart:io';

import 'package:dsh_link/dsh_link.dart';

Future<void> main() async {
  final port = Platform.environment['POCKET_HARNESS_WEB_PORT'] ?? '57597';
  final client = HttpClient();
  final request = await client.getUrl(Uri.parse('http://127.0.0.1:$port/api/pocket-harness/pair?format=json'));
  final response = await request.close();
  final body = await response.transform(utf8.decoder).join();
  final json = jsonDecode(body) as Map<String, Object?>;
  final ticket = PairingTicket.decode(json['ticket']! as String);
  print('ticket lan=${ticket.lanEndpoints} relay=${ticket.relayUrl} room=${ticket.relayRoom?.substring(0, 6)}');

  // 模拟手机离开局域网：把 lan 地址换成不可达地址
  final away = PairingTicket(
    hostDeviceId: ticket.hostDeviceId,
    hostPublicKey: ticket.hostPublicKey,
    hostName: ticket.hostName,
    lanEndpoints: const ['10.255.255.1:48100'],
    relayUrl: ticket.relayUrl,
    relayRoom: ticket.relayRoom,
    relayToken: ticket.relayToken,
    pairingSecret: ticket.pairingSecret,
    expiresAt: ticket.expiresAt,
  );

  final identity = DeviceIdentity.generate();
  final started = DateTime.now();
  try {
    final link = await LinkClient.connect(away, identity, timeout: const Duration(seconds: 4), relayTimeout: const Duration(seconds: 20));
    final elapsed = DateTime.now().difference(started).inMilliseconds;
    print('connected over ${link.route} in ${elapsed}ms at ${link.endpoint}');
    final value = await link.rpc.call('session/list', const {'_request': <String, Object?>{}});
    final items = value['items'];
    print('session/list -> ${items is List ? items.length : "?"} sessions');
    await link.close();
    print('DART CLIENT REACHES THE HOST OVER THE RELAY');
  } on Object catch (error) {
    final elapsed = DateTime.now().difference(started).inMilliseconds;
    print('FAILED after ${elapsed}ms: $error');
    exitCode = 1;
  } finally {
    client.close(force: true);
  }
}
