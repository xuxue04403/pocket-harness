// Probe: does session/search answer, and what does a hit look like?
//
// Depends on a running Harness plus a fresh pairing ticket: run
// `probe/live-ticket.mjs` first (this test regenerates it), then run this from
// packages/dsh_link.
//
// Recorded result on this machine (2026-11-21): the Host answers
// `RpcException(gateway/internal): session search failed: SessionQueryError:
// session search is disabled: this deployment configures the session-query index
// with openAt "never"`. That is why the phone's search page filters titles and
// directories locally and only layers content search on top when it answers.
import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

const _harnessExe = r'C:\Users\xuexu\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe';
const _ticketScript = r'D:\IDE\dsh-bot\probe\live-ticket.mjs';
const _ticketPath = r'D:\IDE\dsh-bot\probe\_live-ticket.txt';
const _identityPath = r'D:\IDE\dsh-bot\probe\_probe-identity.txt';

void main() {
  test('session/search reports its capabilities', () async {
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

    Map<String, Object?> value;
    try {
      value = await link.rpc.call('session/search', {
        'request': {'query': 'count to 40'},
      });
    } on RpcException catch (error) {
      if (error.message.contains('session search is disabled')) {
        print('content search disabled on this Host: ${error.message}');
        return;
      }
      rethrow;
    }
    final items = value['items'];
    expect(items, isA<List>());
    print('hasMore: ${value['hasMore']}');
    print('hits: ${(items as List).length}');
    for (final item in items.take(3)) {
      final map = item as Map<String, Object?>;
      print('  ${map['sessionId']}  ${map['snippet']}');
    }
  }, timeout: const Timeout(Duration(minutes: 2)));
}
