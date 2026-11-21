// Watches a live session's follow stream and prints the frame kinds and the
// durable event types that arrive, so the phone renderer can be checked
// against what DSH really sends for a running turn.
@TestOn('vm')
library;

import 'dart:async';
import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

const String _harnessExe =
    r'C:\Users\xuexu\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe';

void main() {
  test('watch a live session', () async {
    final ticketFile = File(r'D:\IDE\dsh-bot\probe\_live-ticket.txt');
    final ticket = PairingTicket.decode(ticketFile.readAsStringSync().trim());
    final identity = File(r'D:\IDE\dsh-bot\probe\_probe-identity.txt');
    final deviceId = identity.readAsLinesSync()[0];
    final privateKey = decodeBase64Url(identity.readAsLinesSync()[1]);
    final me = DeviceIdentity.fromPrivateKey(deviceId, privateKey);

    final link = await LinkClient.connect(ticket, me);
    final sessions = await link.rpc.call('session/list', {
      '_request': <String, Object?>{},
    });
    final items = (sessions['items'] as List).cast<Map<String, Object?>>();
    final running = items.where((item) => item['running'] == true).toList();
    final target = running.isNotEmpty ? running.first : items.first;
    final sessionId = '${target['sessionId']}';
    stdout.writeln('session=$sessionId running=${target['running']}');

    final frames = <String, int>{};
    final events = <String, int>{};
    var assistantPrinted = 0;
    final subscription = link
        .openStream('session/follow', {
          'request': {
            'address': {'kind': 'session', 'sessionId': sessionId},
            'maxMessages': 6,
            'activate': true,
            'assistantStream': true,
          },
        })
        .listen((frame) {
      final kind = '${frame['type']}';
      frames[kind] = (frames[kind] ?? 0) + 1;
      if (kind == 'event') {
        final event = frame['event'];
        if (event is Map) {
          final type = '${event['type']}';
          events[type] = (events[type] ?? 0) + 1;
          stdout.writeln('event $type seq=${event['seq']}');
        }
      } else {
        final frameKind = frame['type'];
        if (frameKind == 'assistant-stream') {
          final inner = frame['frame'];
          final printed = assistantPrinted;
          if (printed < 12 && inner is Map) {
            assistantPrinted++;
            stdout.writeln('assistant ${inner['type']} ${inner['chunk'] ?? inner['outcome'] ?? ''}');
          }
        } else {
          stdout.writeln('frame $kind');
        }
      }
    }, onError: (Object error) => stdout.writeln('stream error $error'));

    await Future<void>.delayed(const Duration(seconds: 25));
    await subscription.cancel();
    stdout.writeln('frames=$frames');
    stdout.writeln('events=$events');
    await link.close();
    expect(_harnessExe, isNotEmpty);
  }, timeout: const Timeout(Duration(minutes: 2)));
}
