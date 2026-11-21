// Live probe: kill the session's currently running job and watch the roster.
//
//   dart test tool/probe_job_kill_live_test.dart
@TestOn('vm')
library;

import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

const String _ticketPath = r'D:\IDE\dsh-bot\probe\_live-ticket.txt';
const String _identityPath = r'D:\IDE\dsh-bot\probe\_probe-identity.txt';

void main() {
  test('kills a running job and sees it leave the roster', () async {
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
      for (final item in sessions['items']! as List) {
        final sessionId = (item as Map)['sessionId'] as String;
        final roster = await link.rpc
            .openStream('job/list', {
              'request': {'sessionId': sessionId},
            })
            .first
            .timeout(const Duration(seconds: 10));
        final jobs = roster['jobs'];
        if (jobs is! List || jobs.isEmpty) continue;
        for (final row in jobs) {
          final job = (row as Map).cast<String, Object?>();
          if (job['status'] != 'running') continue;
          stdout.writeln('live job: ${job['id']} ${job['label']}');
          final answer = await link.rpc.call('job/kill', {
            'request': {'sessionId': sessionId, 'jobId': job['id']},
          });
          stdout.writeln('kill -> $answer');
          await Future<void>.delayed(const Duration(seconds: 2));
          final after = await link.rpc
              .openStream('job/list', {
                'request': {'sessionId': sessionId},
              })
              .first
              .timeout(const Duration(seconds: 10));
          for (final row in after['jobs']! as List) {
            final next = (row as Map).cast<String, Object?>();
            if (next['id'] == job['id']) {
              stdout.writeln('after: ${next['status']} ${next['detail']}');
            }
          }
          return;
        }
      }
      stdout.writeln('no running job found');
    } finally {
      await link.close();
    }
  }, timeout: const Timeout(Duration(seconds: 180)));
}
