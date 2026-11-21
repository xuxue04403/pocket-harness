@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

/// Compares the two Session subscription streams to see which one answers and
/// what its first frames look like.
const String _ticketPath = r'D:\IDE\dsh-bot\probe\_live-ticket.txt';
const String _outDir = r'D:\IDE\dsh-bot\probe\samples';

void main() {
  test('probes observeEvent and follow', () async {
    final ticket = PairingTicket.decode(File(_ticketPath).readAsStringSync().trim());
    final link = await LinkClient.connect(ticket, DeviceIdentity.generate());
    Directory(_outDir).createSync(recursive: true);
    stderr.writeln('connected');

    try {
      final list = await link.rpc.call('session/list', const {'_request': <String, Object?>{}});
      final items = (list['items'] as List<Object?>?) ?? const <Object?>[];
      final id = (items.first as Map<String, Object?>)['sessionId'] as String;
      stderr.writeln('session $id');

      for (final probe in <(String, Map<String, Object?>)>[
        (
          'observe_event',
          {
            'request': {
              'address': {'kind': 'session', 'sessionId': id},
            },
          },
        ),
        (
          'follow',
          {
            'request': {
              'address': {'kind': 'session', 'sessionId': id},
              'maxMessages': 3,
            },
          },
        ),
      ]) {
        final (name, args) = probe;
        final endpoint = name == 'follow' ? 'session/follow' : 'session/observeEvent';
        stderr.writeln('opening $endpoint');
        final frames = <Object?>[];
        try {
          await for (final frame in link.openStream(endpoint, args).timeout(const Duration(seconds: 12))) {
            frames.add(frame);
            if (frames.length >= 4) break;
          }
          stderr.writeln('$endpoint yielded ${frames.length}');
        } catch (error) {
          stderr.writeln('$endpoint failed: $error');
        }
        File('$_outDir\\$name.json')
            .writeAsStringSync(const JsonEncoder.withIndent('  ').convert(frames));
      }
    } finally {
      await link.close();
    }
  }, timeout: const Timeout(Duration(seconds: 120)));
}
