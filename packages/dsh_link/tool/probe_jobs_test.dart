// Live probe: does `job/list` answer a first frame, and what shape are its rows?
//
// Needs the Harness running with the Pocket Harness Host plugin installed, and a
// fresh pairing ticket at probe/_live-ticket.txt. Run with:
//   dart test tool/probe_jobs_test.dart
@TestOn('vm')
library;

import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

const String _ticketPath = r'D:\IDE\dsh-bot\probe\_live-ticket.txt';
const String _identityPath = r'D:\IDE\dsh-bot\probe\_probe-identity.txt';

void main() {
  test('reads the job roster of a session', () async {
    final ticket = PairingTicket.decode(
      File(_ticketPath).readAsStringSync().trim(),
    );
    final lines = File(_identityPath).readAsLinesSync();
    final identity = DeviceIdentity.fromPrivateKey(
      lines[0].trim(),
      decodeBase64Url(lines[1].trim()),
    );
    final link = await LinkClient.connect(ticket, identity, heartbeat: false);
    try {
      final sessions = await link.rpc.call('session/list', {
        '_request': <String, Object?>{},
      });
      final items = sessions['items']! as List;
      for (final item in items.take(5)) {
        final sessionId = (item as Map)['sessionId'] as String;
        final frame = await link.rpc
            .openStream('job/list', {
              'request': {'sessionId': sessionId},
            })
            .first
            .timeout(const Duration(seconds: 15));
        stdout.writeln('session $sessionId -> $frame');
      }
    } finally {
      await link.close();
    }
  }, timeout: const Timeout(Duration(seconds: 120)));
}
