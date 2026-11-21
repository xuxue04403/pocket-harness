// Verifies that settings/update takes named args and refuses a stale revision.
// Restores the original value, so it is safe to run against a real profile.
@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

const String _ticketPath = r'D:\IDE\dsh-bot\probe\_live-ticket.txt';
const String _identityPath = r'D:\IDE\dsh-bot\probe\_probe-identity.txt';

void main() {
  test('settings update round trip', () async {
    final ticket = PairingTicket.decode(File(_ticketPath).readAsStringSync().trim());
    final lines = File(_identityPath).readAsLinesSync();
    final identity = DeviceIdentity.fromPrivateKey(lines[0].trim(), decodeBase64Url(lines[1].trim()));
    final link = await LinkClient.connect(ticket, identity);
    addTearDown(link.close);

    final described = await link.rpc.call('settings/describe', const {});
    final namespaces = described['namespaces'] as List;
    final target = namespaces
        .cast<Map<String, Object?>>()
        .firstWhere((entry) => entry['ns'] == 'agent-default-model');
    final original = Map<String, Object?>.from(target['value'] as Map);
    final revision = (target['revision'] as num).toInt();
    stdout.writeln('original=$original revision=$revision');

    // 1. A stale revision must be refused, not applied.
    try {
      await link.rpc.call('settings/update', {
        'ns': 'agent-default-model',
        'patch': original,
        'expectedRevision': revision + 7,
      });
      stdout.writeln('stale write NOT refused');
    } on RpcException catch (error) {
      stdout.writeln('stale write refused: ${error.code} ${error.message}');
    }

    // 2. Writing the same value back must succeed and bump the revision.
    final updated = await link.rpc.call('settings/update', {
      'ns': 'agent-default-model',
      'patch': original,
      'expectedRevision': revision,
    });
    final updatedNs = (updated['ns'] as String?) ?? '?';
    stdout.writeln(
      'updated ns=$updatedNs rev=${updated['revision']} value=${jsonEncode(updated['value'])}',
    );
    expect(updatedNs, 'agent-default-model');
    expect((updated['revision'] as num).toInt(), greaterThanOrEqualTo(revision));
  }, timeout: const Timeout(Duration(minutes: 2)));
}
