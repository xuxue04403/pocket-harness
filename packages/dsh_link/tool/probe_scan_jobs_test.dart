// Live probe: find a session that actually has background jobs, so the phone's
// job screen can be checked against a real roster.
//
//   dart test tool/probe_scan_jobs_test.dart
@TestOn('vm')
library;

import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

const String _ticketPath = r'D:\IDE\dsh-bot\probe\_live-ticket.txt';
const String _identityPath = r'D:\IDE\dsh-bot\probe\_probe-identity.txt';

void main() {
  test('finds sessions whose job roster is not empty', () async {
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
      stdout.writeln('scanning ${items.length} sessions');
      var found = 0;
      for (final item in items) {
        final sessionId = (item as Map)['sessionId'] as String;
        final frame = await link.rpc
            .openStream('job/list', {
              'request': {'sessionId': sessionId},
            })
            .first
            .timeout(const Duration(seconds: 10));
        final jobs = frame['jobs'];
        if (jobs is List && jobs.isNotEmpty) {
          found += 1;
          stdout.writeln('session $sessionId -> $jobs');
          if (found >= 3) break;
        }
      }
      stdout.writeln('sessions with jobs: $found');
    } finally {
      await link.close();
    }
  }, timeout: const Timeout(Duration(seconds: 300)));
}
