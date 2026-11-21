// Reads the Host's settings surface so the phone can show, and later change,
// the defaults a new session inherits.
//
// Run from packages/dsh_link after refreshing probe/_live-ticket.txt:
//   dart test tool/probe_settings_test.dart
@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

const String _ticketPath = r'D:\IDE\dsh-bot\probe\_live-ticket.txt';
const String _identityPath = r'D:\IDE\dsh-bot\probe\_probe-identity.txt';

void main() {
  test('settings describe', () async {
    final ticketText = File(_ticketPath).readAsStringSync().trim();
    final ticket = PairingTicket.decode(ticketText);
    final lines = File(_identityPath).readAsLinesSync();
    final identity = DeviceIdentity.fromPrivateKey(
      lines[0].trim(),
      decodeBase64Url(lines[1].trim()),
    );

    final link = await LinkClient.connect(ticket, identity);
    addTearDown(link.close);

    for (final endpoint in ['settings/describe', 'settings/list']) {
      try {
        final value = await link.rpc.call(endpoint, const {});
        stdout.writeln('$endpoint -> ${_shape(value)}');
        final encoded = const JsonEncoder.withIndent('  ').convert(value);
        stdout.writeln(encoded.length > 4000 ? '${encoded.substring(0, 4000)}…' : encoded);
      } on RpcException catch (error) {
        stdout.writeln('$endpoint failed: ${error.code}: ${error.message}');
      }
    }
  }, timeout: const Timeout(Duration(minutes: 2)));
}

String _shape(Object? value) {
  if (value is Map) return 'map(${value.keys.take(12).join(',')})';
  if (value is List) return 'list(${value.length})';
  return '${value.runtimeType}';
}
