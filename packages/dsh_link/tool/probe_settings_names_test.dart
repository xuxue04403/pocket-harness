// Prints just the namespace names and their effective values, so a settings
// screen can be designed against the real shape instead of a guess.
@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

const String _ticketPath = r'D:\IDE\dsh-bot\probe\_live-ticket.txt';
const String _identityPath = r'D:\IDE\dsh-bot\probe\_probe-identity.txt';

void main() {
  test('settings namespaces', () async {
    final ticket = PairingTicket.decode(File(_ticketPath).readAsStringSync().trim());
    final lines = File(_identityPath).readAsLinesSync();
    final identity = DeviceIdentity.fromPrivateKey(lines[0].trim(), decodeBase64Url(lines[1].trim()));
    final link = await LinkClient.connect(ticket, identity);
    addTearDown(link.close);

    final value = await link.rpc.call('settings/describe', const {});
    final namespaces = value['namespaces'];
    if (namespaces is! List) {
      stdout.writeln('no namespaces, keys=${value.keys}');
      return;
    }
    stdout.writeln('count=${namespaces.length}');
    for (final entry in namespaces) {
      if (entry is! Map) continue;
      final value = entry['value'];
      final rendered = jsonEncode(value);
      stdout.writeln(
        'ns=${entry['ns']} applies=${entry['applies']} rev=${entry['revision']} '
        'value=${rendered.length > 300 ? '${rendered.substring(0, 300)}…' : rendered}',
      );
    }
  }, timeout: const Timeout(Duration(minutes: 2)));
}
