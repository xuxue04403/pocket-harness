// Probe: which skills does a session see, and where do they come from?
//
// The `skills` namespace is session-addressed: the cwd and agent preset decide
// which catalog a session sees, so this needs a real session id.
import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

const _harnessExe = r'C:\Users\xuexu\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe';
const _ticketScript = r'D:\IDE\dsh-bot\probe\live-ticket.mjs';
const _ticketPath = r'D:\IDE\dsh-bot\probe\_live-ticket.txt';
const _identityPath = r'D:\IDE\dsh-bot\probe\_probe-identity.txt';

void main() {
  test('skills/list answers per session', () async {
    final regenerated = await Process.run(
      _harnessExe,
      [_ticketScript, _ticketPath],
      environment: {'ELECTRON_RUN_AS_NODE': '1'},
    );
    if (regenerated.exitCode != 0) {
      markTestSkipped('no running Harness: ${regenerated.stderr}');
      return;
    }
    final ticket = PairingTicket.decode(File(_ticketPath).readAsStringSync().trim());
    final lines = File(_identityPath).readAsStringSync().trim().split('\n');
    final identity = DeviceIdentity.fromPrivateKey(lines[0], decodeBase64Url(lines[1]));

    final link = await LinkClient.connect(ticket, identity, heartbeat: false);
    addTearDown(link.close);

    final list = await link.rpc.call('session/list', {'_request': const {}});
    final items = list['items'] as List;
    final first = (items.first as Map)['sessionId'] as String;

    final value = await link.rpc.call('skills/list', {
      'request': {'sessionId': first},
    });
    final skills = value['skills'];
    expect(skills, isA<List>());
    print('skills: ${(skills as List).length}');
    for (final skill in skills.take(6)) {
      final map = skill as Map<String, Object?>;
      print('  ${map['name']} | modelInvocable=${map['modelInvocable']} | ${map['description']}');
    }
  }, timeout: const Timeout(Duration(minutes: 2)));
}
