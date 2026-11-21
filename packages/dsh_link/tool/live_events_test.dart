@TestOn('vm')
library;

import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

/// Opens the Gateway's forwarded-event stream against the running Harness.
///
/// This is the one thing the offline suites cannot prove: that the real
/// `@deepseek-ai/dsh-api-gateway` accepts our `$events` open and answers with a
/// `ready` frame carrying a client id. Approvals themselves only appear when a
/// tool actually asks for one, so this stops at the handshake — but a wrong
/// arity on `openWireStream`, a rejected peer or a missing `interactions:
/// 'answer'` all show up here.
///
/// Refresh the ticket first:
///   $env:ELECTRON_RUN_AS_NODE='1'
///   & '...\DeepSeek Harness.exe' probe\live-ticket.mjs
/// Then run:
///   dart test tool/live_events_test.dart
const String _ticketPath = r'D:\IDE\dsh-bot\probe\_live-ticket.txt';

void main() {
  test('the running Host forwards events to this phone', () async {
    final file = File(_ticketPath);
    if (!file.existsSync()) {
      markTestSkipped('run probe/live-ticket.mjs first');
      return;
    }
    final ticket = PairingTicket.decode(file.readAsStringSync().trim());
    final identity = DeviceIdentity.generate();
    final link = await LinkClient.connect(ticket, identity);
    try {
      final events = await RemoteEvents.open(link.rpc);
      addTearDown(events.close);
      expect(events.clientId, isNotEmpty);
      // DSH answers queries about saved sessions as forwarded notifications, so a
      // subscription that stays silent for a moment is still healthy; the ready
      // frame above is the proof this test cares about.
      stdout.writeln('events client id: ${events.clientId}');

      // Prove the reply path reaches the real dispatcher too. The gateway accepts
      // the request shape (`clientId`/`eventId`/`outcome` under `args`) and
      // ignores an event id it never issued, so a clean resolve — not an error —
      // is the evidence that our encoding parsed and the owner Peer was allowed
      // to answer.
      final phantom = RemoteInvocation(
        event: 'approval/request',
        eventId: 'no-such-event',
        agentId: 'no-such-agent',
        request: const {},
      );
      await events.answer(phantom, value: 'allowed-once');
    } finally {
      await link.close();
    }
  }, timeout: const Timeout(Duration(seconds: 60)));
}
