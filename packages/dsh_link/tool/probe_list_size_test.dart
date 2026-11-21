// Probe: how many sessions does session/list return, and does it paginate?
//
// Depends on a running Harness plus a fresh pairing ticket.
import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

const _harnessExe = r'C:\Users\xuexu\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe';
const _ticketScript = r'D:\IDE\dsh-bot\probe\live-ticket.mjs';
const _ticketPath = r'D:\IDE\dsh-bot\probe\_live-ticket.txt';
const _identityPath = r'D:\IDE\dsh-bot\probe\_probe-identity.txt';

void main() {
  test('session/list size and paging', () async {
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

    final value = await link.rpc.call('session/list', {'_request': const {}});
    final items = value['items'] as List;
    print('items: ${items.length}');
    print('top-level keys: ${value.keys.toList()}');
    final titled = items.where((item) => (item as Map)['projections'] != null).length;
    print('with projections: $titled');
    // A cursor would mean the list is a page, not the whole set.
    print('cursor: ${value['cursor']}');
    // Does any title mention a phrase we know exists?
    var matches = 0;
    for (final item in items) {
      final map = item as Map<String, Object?>;
      final projections = map['projections'];
      if (projections is! Map) continue;
      final values = projections['values'];
      if (values is! Map) continue;
      final title = values['title'];
      if (title is String && title.toLowerCase().contains('librextv')) matches += 1;
    }
    print('title matches for librextv: $matches');
  }, timeout: const Timeout(Duration(minutes: 2)));
}
