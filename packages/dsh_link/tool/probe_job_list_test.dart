@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

void main() {
  test('job list first frame', () async {
    final ticket = PairingTicket.decode(File(r'D:\IDE\dsh-bot\probe\_live-ticket.txt').readAsStringSync().trim());
    final lines = File(r'D:\IDE\dsh-bot\probe\_probe-identity.txt').readAsLinesSync();
    final identity = DeviceIdentity.fromPrivateKey(lines[0].trim(), decodeBase64Url(lines[1].trim()));
    final link = await LinkClient.connect(ticket, identity);
    addTearDown(link.close);

    final created = await link.rpc.call('session/create', {'request': <String, Object?>{}});
    final sessionId = created['sessionId'] as String;
    stdout.writeln('session len=${sessionId.length}');

    final frame = await link
        .openStream('job/list', {'request': {'sessionId': sessionId}})
        .first
        .timeout(const Duration(seconds: 20));
    stdout.writeln('keys=${frame.keys.toList()} type=${frame['type']} jobs=${jsonEncode(frame['jobs'])}');
  }, timeout: const Timeout(Duration(minutes: 2)));
}
