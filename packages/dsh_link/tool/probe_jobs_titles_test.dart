// Live probe: print the titles and working directories of sessions that carry
// background jobs, so the phone's job screen can be checked against a real one.
//
//   dart test tool/probe_jobs_titles_test.dart
@TestOn('vm')
library;

import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

const String _ticketPath = r'D:\IDE\dsh-bot\probe\_live-ticket.txt';
const String _identityPath = r'D:\IDE\dsh-bot\probe\_probe-identity.txt';

void main() {
  test('lists sessions that own jobs, with their titles', () async {
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
      var found = 0;
      for (final item in items) {
        final map = (item as Map).cast<String, Object?>();
        final sessionId = map['sessionId'] as String;
        final roster = await link.rpc
            .openStream('job/list', {
              'request': {'sessionId': sessionId},
            })
            .first
            .timeout(const Duration(seconds: 10));
        final jobs = roster['jobs'];
        if (jobs is! List || jobs.isEmpty) continue;
        found += 1;
        final projections = map['projections'];
        var title = '(no title)';
        if (projections is Map) {
          final values = projections['values'];
          if (values is Map && values['title'] is String) {
            title = values['title'] as String;
          }
        }
        stdout.writeln(
          'title="$title" cwd=${map['cwd']} jobs=${jobs.length} '
          'live=${jobs.where((job) => (job as Map)['status'] == 'running').length}',
        );
        if (found >= 5) break;
      }
    } finally {
      await link.close();
    }
  }, timeout: const Timeout(Duration(seconds: 300)));
}
