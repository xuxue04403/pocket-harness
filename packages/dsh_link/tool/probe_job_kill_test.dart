// Live probe: what does `job/kill` answer for a job that already settled?
//
//   dart test tool/probe_job_kill_test.dart
@TestOn('vm')
library;

import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

const String _ticketPath = r'D:\IDE\dsh-bot\probe\_live-ticket.txt';
const String _identityPath = r'D:\IDE\dsh-bot\probe\_probe-identity.txt';

void main() {
  test('kills a settled job and reports what the Host said', () async {
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
          if (job['status'] == 'running') continue;
          try {
            final answer = await link.rpc.call('job/kill', {
              'request': {'sessionId': sessionId, 'jobId': job['id']},
            });
            stdout.writeln('kill ${job['id']} (${job['status']}) -> $answer');
          } on RpcException catch (error) {
            stdout.writeln(
              'kill ${job['id']} (${job['status']}) -> ${error.code}: ${error.message} details=${error.details}',
            );
          }
          return;
        }
      }
      stdout.writeln('no settled job to try');
    } finally {
      await link.close();
    }
  }, timeout: const Timeout(Duration(seconds: 180)));
}
