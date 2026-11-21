// Checks the two Host calls the sessions page makes before it can show a chat:
// listing sessions and creating one.
@TestOn('vm')
library;

import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

void main() {
  test('creates a session and reads it back', () async {
    final ticket = PairingTicket.decode(
      File(r'D:\IDE\dsh-bot\probe\_live-ticket.txt').readAsStringSync().trim(),
    );
    final lines = File(r'D:\IDE\dsh-bot\probe\_probe-identity.txt').readAsLinesSync();
    final me = DeviceIdentity.fromPrivateKey(lines[0], decodeBase64Url(lines[1]));
    final link = await LinkClient.connect(ticket, me);
    try {
      final created = await link.rpc.call('session/create', {'request': <String, Object?>{}});
      stdout.writeln('created=$created');
      final list = await link.rpc.call('session/list', {'_request': <String, Object?>{}});
      final items = (list['items'] as List).cast<Map<String, Object?>>();
      final hit = items.where((item) => item['sessionId'] == created['sessionId']).toList();
      stdout.writeln('visible in list: ${hit.length}');
      expect(hit, hasLength(1));
    } finally {
      await link.close();
    }
  }, timeout: const Timeout(Duration(minutes: 2)));
}
