@TestOn('vm')
library;

import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

/// Talks to the *running* Harness through the installed Host plugin.
///
/// Every other test in this package stands up its own Host. This one does the
/// opposite: it dials the Harness the person is actually using, so a green run
/// proves the plugin is installed, its identity is persisted, its Peer is
/// accepted by the Typert gateway, and real DSH Remote endpoints answer.
///
/// It is skipped unless `probe/_live-ticket.txt` exists, which
/// `probe/live-ticket.mjs` writes from the plugin's stored identity.
const String _ticketPath = r'D:\IDE\dsh-bot\probe\_live-ticket.txt';

PairingTicket? _liveTicket() {
  final file = File(_ticketPath);
  if (!file.existsSync()) return null;
  final text = file.readAsStringSync().trim();
  if (text.isEmpty) return null;
  return PairingTicket.decode(text);
}

void main() {
  final ticket = _liveTicket();

  group('the installed Host plugin in the running Harness', () {
    test('answers a real DSH Remote endpoint', () async {
      if (ticket == null) {
        markTestSkipped('no live ticket; run probe/live-ticket.mjs first');
        return;
      }
      final link = await LinkClient.connect(ticket, DeviceIdentity.generate());
      try {
        // `session/list` is the API the phone's home screen opens with, so it is
        // the cheapest proof that a call reaches DSH and comes back shaped right.
        // The gateway matches argument names against the method's own parameter
        // names, and this method spells its (unused) request `_request`.
        final result = await link.rpc.call('session/list', const {'_request': <String, Object?>{}});
        expect(result, isA<Map<String, Object?>>());
        expect(result['items'], isA<List<Object?>>());
      } finally {
        await link.close();
      }
    }, timeout: const Timeout(Duration(seconds: 60)));

    test('streams a real DSH Remote stream', () async {
      if (ticket == null) {
        markTestSkipped('no live ticket; run probe/live-ticket.mjs first');
        return;
      }
      final link = await LinkClient.connect(ticket, DeviceIdentity.generate());
      try {
        final list = await link.rpc.call('session/list', const {'_request': <String, Object?>{}});
        final items = (list['items'] as List<Object?>?) ?? const <Object?>[];
        if (items.isEmpty) {
          markTestSkipped('this Harness has no session to stream');
          return;
        }
        final sessionId = (items.first as Map<String, Object?>)['sessionId'];
        // `job/list` is a stream in DSH: it yields the current job set and then
        // keeps pushing on every lifecycle change, so reading one frame proves
        // the whole path — open, first frame, and an orderly stop on cancel.
        final first = await link
            .openStream('job/list', {
              'request': {'sessionId': sessionId},
            })
            .first;
        expect(first, isA<Map<String, Object?>>());
      } finally {
        await link.close();
      }
    }, timeout: const Timeout(Duration(seconds: 60)));
  });
}
