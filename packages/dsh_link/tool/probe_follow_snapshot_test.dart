@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

/// Captures a real `session/follow` snapshot so the transcript renderer can be
/// written against the actual record shapes.
const String _ticketPath = r'D:\IDE\dsh-bot\probe\_live-ticket.txt';
const String _outDir = r'D:\IDE\dsh-bot\probe\samples';

void main() {
  test('captures a follow snapshot', () async {
    final ticket = PairingTicket.decode(File(_ticketPath).readAsStringSync().trim());
    final link = await LinkClient.connect(ticket, DeviceIdentity.generate());
    Directory(_outDir).createSync(recursive: true);
    try {
      final list = await link.rpc.call('session/list', const {'_request': <String, Object?>{}});
      final items = (list['items'] as List<Object?>?) ?? const <Object?>[];
      final id = (items.first as Map<String, Object?>)['sessionId'] as String;
      stderr.writeln('session $id');

      final frame = await link
          .openStream('session/follow', {
            'request': {
              'address': {'kind': 'session', 'sessionId': id},
              'maxMessages': 2,
              'activate': true,
            },
          })
          .first
          .timeout(const Duration(seconds: 20));

      File('$_outDir\\follow_activated.json')
          .writeAsStringSync(const JsonEncoder.withIndent('  ').convert(frame));

      final records = (frame['records'] as List<Object?>?) ?? const <Object?>[];
      stderr.writeln('frame keys: ${frame.keys}');
      stderr.writeln('snapshot records: ${records.length}  hasMore=${frame['hasMore']}');
      for (final record in records) {
        final map = record as Map<String, Object?>;
        final event = map['event'] as Map<String, Object?>?;
        stderr.writeln('  ${map['type']} / ${event?['type']} seq=${event?['seq']}');
      }
    } finally {
      await link.close();
    }
  }, timeout: const Timeout(Duration(seconds: 120)));
}
