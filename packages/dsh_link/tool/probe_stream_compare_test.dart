@TestOn('vm')
library;

import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

/// Compares a known-good stream (`job/list`) with `session/follow` on the same
/// link, to tell a plumbing bug from a DSH behaviour difference.
const String _ticketPath = r'D:\IDE\dsh-bot\probe\_live-ticket.txt';

void main() {
  test('compares job/list with session/follow', () async {
    final ticket = PairingTicket.decode(File(_ticketPath).readAsStringSync().trim());
    final link = await LinkClient.connect(ticket, DeviceIdentity.generate());
    try {
      final list = await link.rpc.call('session/list', const {'_request': <String, Object?>{}});
      final items = (list['items'] as List<Object?>?) ?? const <Object?>[];
      final id = (items.first as Map<String, Object?>)['sessionId'] as String;

      stderr.writeln('job/list:');
      try {
        final frame = await link
            .openStream('job/list', {
              'request': {'sessionId': id},
            })
            .first
            .timeout(const Duration(seconds: 10));
        stderr.writeln('  got ${frame.keys}');
      } catch (error) {
        stderr.writeln('  failed: $error');
      }

      stderr.writeln('session/follow with activate:');
      try {
        final frame = await link
            .openStream('session/follow', {
              'request': {
                'address': {'kind': 'session', 'sessionId': id},
                'maxMessages': 2,
                'activate': true,
              },
            })
            .first
            .timeout(const Duration(seconds: 10));
        stderr.writeln('  got ${frame.keys}');
      } catch (error) {
        stderr.writeln('  failed: $error');
      }
    } finally {
      await link.close();
    }
  }, timeout: const Timeout(Duration(seconds: 90)));
}
