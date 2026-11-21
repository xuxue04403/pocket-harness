@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

/// Dumps the real shape of a few Session reads so the phone UI can be written
/// against what the Harness actually sends instead of a guess.
///
/// This is a probe, not a regression test: it writes JSON files under
/// `probe/samples/` and only asserts that the reads succeeded.
const String _ticketPath = r'D:\IDE\dsh-bot\probe\_live-ticket.txt';
const String _outDir = r'D:\IDE\dsh-bot\probe\samples';

void main() {
  test('dumps session reads one step at a time', () async {
    final ticket = PairingTicket.decode(File(_ticketPath).readAsStringSync().trim());
    final link = await LinkClient.connect(ticket, DeviceIdentity.generate());
    Directory(_outDir).createSync(recursive: true);
    stderr.writeln('connected');

    void dump(String name, Object? value) {
      File('$_outDir\\$name.json')
          .writeAsStringSync(const JsonEncoder.withIndent('  ').convert(value));
      stderr.writeln('dumped $name');
    }

    Future<void> step(String name, Future<Object?> Function() read) async {
      stderr.writeln('reading $name');
      final value = await read().timeout(const Duration(seconds: 15));
      dump(name, value);
    }

    try {
      await step('session_list', () => link.rpc.call('session/list', const {'_request': <String, Object?>{}}));
      final list = jsonDecode(File('$_outDir\\session_list.json').readAsStringSync()) as Map<String, Object?>;
      final items = (list['items'] as List<Object?>?) ?? const <Object?>[];
      if (items.isEmpty) {
        markTestSkipped('no sessions on this Harness');
        return;
      }
      final id = (items.first as Map<String, Object?>)['sessionId'] as String;

      await step('session_state', () => link.rpc.call('session/state', {'request': {'sessionId': id}}));
      await step('session_projections', () => link.rpc.call('session/projections', {'request': {'sessionId': id}}));
      await step(
        'session_page',
        () => link.rpc.call('session/page', {
          'request': {
            'address': {'kind': 'session', 'sessionId': id},
            'maxMessages': 6,
          },
        }),
      );

      stderr.writeln('opening follow');
      final frames = <Object?>[];
      await for (final frame in link.openStream('session/follow', {
        'request': {
          'address': {'kind': 'session', 'sessionId': id},
          'maxMessages': 6,
        },
      }).timeout(const Duration(seconds: 20))) {
        frames.add(frame);
        if (frames.length >= 3) break;
      }
      dump('session_follow', frames);
    } finally {
      await link.close();
    }
  }, timeout: const Timeout(Duration(seconds: 150)));
}
