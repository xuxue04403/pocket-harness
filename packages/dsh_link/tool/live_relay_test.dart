@TestOn('vm')
library;

// Connects to the *running* Harness through the relay only.
//
// The ticket in `probe/_relay-ticket.txt` is produced by stripping every LAN
// endpoint from a real pairing code, so the only route left is the self-hosted
// relay. That is the path a phone takes when it is away from the network the
// computer sits on, and it is the one link in the chain that no in-process test
// can stand in for.

import 'dart:convert';
import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

const _ticketPath = r'D:\IDE\dsh-bot\probe\_relay-ticket.txt';
const _identityPath = r'D:\IDE\dsh-bot\probe\_probe-identity.txt';

DeviceIdentity? _identity() {
  final file = File(_identityPath);
  if (!file.existsSync()) return null;
  final lines = file.readAsLinesSync();
  if (lines.length < 2) return null;
  return DeviceIdentity.fromPrivateKey(lines.first, base64Url.decode(_pad(lines.last)));
}

String _pad(String value) {
  final remainder = value.length % 4;
  return remainder == 0 ? value : value + ('=' * (4 - remainder));
}

void main() {
  test('a real DSH call travels over the self-hosted relay', () async {
    final ticketFile = File(_ticketPath);
    if (!ticketFile.existsSync()) {
      markTestSkipped('no relay ticket: run the relay and refresh probe/_relay-ticket.txt');
      return;
    }
    final identity = _identity();
    if (identity == null) {
      markTestSkipped('no device identity at $_identityPath');
      return;
    }
    final ticket = PairingTicket.decode(ticketFile.readAsStringSync().trim());
    expect(ticket.lanEndpoints, isEmpty, reason: 'the relay must be the only route');
    expect(ticket.hasRelay, isTrue);

    final link = await LinkClient.connect(ticket, identity, timeout: const Duration(seconds: 30));
    addTearDown(link.close);
    expect(link.route, LinkRoute.relay);

    final reply = await link.rpc.call('session/list', {'_request': <String, Object?>{}});
    final items = reply['items'];
    expect(items, isA<List<Object?>>());
    stdout.writeln('relay ok: ${link.endpoint}, ${items is List ? items.length : 0} sessions');
  }, timeout: const Timeout(Duration(seconds: 90)));
}
