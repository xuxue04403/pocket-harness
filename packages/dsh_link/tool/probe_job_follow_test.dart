// Live probe: does `job/follow` hand back an anchor, output and a terminal
// status for a job that really ran on the Host?
//
//   dart test tool/probe_job_follow_test.dart
@TestOn('vm')
library;

import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

const String _ticketPath = r'D:\IDE\dsh-bot\probe\_live-ticket.txt';
const String _identityPath = r'D:\IDE\dsh-bot\probe\_probe-identity.txt';

void main() {
  test('follows a settled job from its first byte to its status', () async {
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
      for (final item in items) {
        final sessionId = (item as Map)['sessionId'] as String;
        final roster = await link.rpc
            .openStream('job/list', {
              'request': {'sessionId': sessionId},
            })
            .first
            .timeout(const Duration(seconds: 10));
        final jobs = roster['jobs'];
        if (jobs is! List || jobs.isEmpty) continue;
        final job = (jobs.first as Map).cast<String, Object?>();
        stdout.writeln('job keys=${{for (final key in job.keys) key}}');
        stdout.writeln('id=${job['id']} label=${job['label']}');
        var chunks = 0;
        var text = '';
        var kinds = <String>{};
        await for (final frame in link
            .rpc
            .openStream('job/follow', {
              'request': {'jobId': job['id'], 'sessionId': sessionId},
            })
            .timeout(const Duration(seconds: 20))) {
          kinds.add('${frame['type']}');
          if (frame['type'] == 'output') {
            chunks += 1;
            for (final chunk in frame['chunks']! as List) {
              text += (chunk as Map)['text'] as String;
            }
          }
        }
        stdout.writeln('kinds=$kinds chunks=$chunks');
        stdout.writeln('first 160 chars: ${text.substring(0, text.length.clamp(0, 160)).replaceAll('\n', r'\n')}');
        return;
      }
      stdout.writeln('no session had a job');
    } finally {
      await link.close();
    }
  }, timeout: const Timeout(Duration(seconds: 180)));
}
