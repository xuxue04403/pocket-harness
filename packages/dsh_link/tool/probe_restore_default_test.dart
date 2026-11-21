@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

void main() {
  test('read and restore the global default model', () async {
    final ticket = PairingTicket.decode(File(r'D:\IDE\dsh-bot\probe\_live-ticket.txt').readAsStringSync().trim());
    final lines = File(r'D:\IDE\dsh-bot\probe\_probe-identity.txt').readAsLinesSync();
    final identity = DeviceIdentity.fromPrivateKey(lines[0].trim(), decodeBase64Url(lines[1].trim()));
    final link = await LinkClient.connect(ticket, identity);
    addTearDown(link.close);

    final described = await link.rpc.call('settings/describe', const {});
    final entry = (described['namespaces'] as List)
        .cast<Map<String, Object?>>()
        .firstWhere((e) => e['ns'] == 'agent-default-model');
    stdout.writeln('now=${jsonEncode(entry['value'])} rev=${entry['revision']}');

    final restored = await link.rpc.call('settings/update', {
      'ns': 'agent-default-model',
      'patch': {'provider': 'gateway', 'model': 'deepseek-v4.1-flash'},
      'expectedRevision': entry['revision'],
    });
    stdout.writeln('restored=${jsonEncode(restored['value'])} rev=${restored['revision']}');
    expect((restored['value'] as Map)['model'], 'deepseek-v4.1-flash');
  }, timeout: const Timeout(Duration(minutes: 2)));
}
