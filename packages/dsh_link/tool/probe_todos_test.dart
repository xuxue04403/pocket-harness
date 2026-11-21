@TestOn('vm')
library;

// Checks the todo projection on individual sessions.
//
// `session/list` never carries todos — the projection is excluded from summary
// payloads — so the only way to know whether a real session has a list is to
// ask `session/projections` for specific ids.
import 'dart:convert';
import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

const _harnessExe = r'C:\Users\xuexu\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe';
const _ticketScript = r'D:\IDE\dsh-bot\probe\live-ticket.mjs';
const _ticketPath = r'D:\IDE\dsh-bot\probe\_live-ticket.txt';

void main() {
  late PairingTicket ticket;

  setUpAll(() async {
    final result = await Process.run(
      _harnessExe,
      [_ticketScript, _ticketPath],
      environment: {'ELECTRON_RUN_AS_NODE': '1'},
    );
    if (result.exitCode != 0) {
      markTestSkipped('no running Harness: ${result.stderr}');
      return;
    }
    ticket = PairingTicket.decode(File(_ticketPath).readAsStringSync().trim());
  });

  test('asks a few sessions for their todo projection', () async {
    final link = await LinkClient.connect(ticket, DeviceIdentity.generate());
    try {
      final list = await link.rpc.call('session/list', const {'_request': <String, Object?>{}});
      final items = (list['items'] as List).cast<Map<String, Object?>>();
      var checked = 0;
      var withTodos = 0;
      for (final item in items.take(40)) {
        final id = item['sessionId'];
        if (id is! String) continue;
        checked++;
        final value = await link.rpc.call('session/projections', {
          'request': {'sessionId': id},
        });
        final values = value['values'];
        if (values is! Map<String, Object?>) continue;
        final todos = values['todos'];
        if (todos is! List || todos.isEmpty) continue;
        withTodos++;
        stdout.writeln(jsonEncode({
          'sessionId': id,
          'title': values['title'],
          'count': todos.length,
          'first': todos.first,
        }));
      }
      stdout.writeln('checked=$checked withTodos=$withTodos');
      expect(checked, greaterThan(0));
    } finally {
      await link.close();
    }
  });
}
