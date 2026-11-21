import 'dart:io';

import 'package:dsh_link/dsh_link.dart';

/// Checks whether `session/state` reports queued prompts, and whether
/// `session/updateQueue` can remove one.
///
/// The point is to learn the shapes before any phone UI depends on them: a
/// queue that the Host never shows would make a "pending messages" list lie.
void main() async {
  final text = File(r'D:\IDE\dsh-bot\probe\_live-ticket.txt').readAsStringSync().trim();
  final ticket = PairingTicket.decode(text);
  final link = await LinkClient.connect(ticket, DeviceIdentity.generate());

  final created = await link.rpc.call('session/create', {
    'request': <String, Object?>{'cwd': r'D:\IDE\dsh-bot'},
  });
  final sessionId = created['sessionId'] as String;
  print('session=$sessionId');

  Future<void> prompt(String body) async {
    await link.rpc.call('session/prompt', {
      'request': <String, Object?>{
        'requestId': newDeviceId(),
        'sessionId': sessionId,
        'mode': 'queue',
        'content': [
          {'type': 'text', 'text': body},
        ],
      },
    });
  }

  await prompt('count slowly from 1 to 40, one number per line');
  await Future<void>.delayed(const Duration(seconds: 2));
  await prompt('SECOND: after the first one, say done');

  for (var i = 0; i < 6; i += 1) {
    await Future<void>.delayed(const Duration(seconds: 2));
    final state = await link.rpc.call('session/state', {
      'request': <String, Object?>{'sessionId': sessionId},
    });
    final queue = state['queue'];
    print('t=${i * 2 + 4}s running=${state['running']} '
        'queue=${queue == null ? 'null' : (queue as List).length}');
    if (queue is List && queue.isNotEmpty) {
      final first = queue.first as Map;
      print('  item keys=${first.keys.toList()}');
      print('  placement=${first['placement']} content=${first['content']}');
      final removed = await link.rpc.call('session/updateQueue', {
        'request': <String, Object?>{
          'sessionId': sessionId,
          'itemId': first['id'],
          'action': {'kind': 'remove'},
        },
      });
      print('  remove -> $removed');
      final after = await link.rpc.call('session/state', {
        'request': <String, Object?>{'sessionId': sessionId},
      });
      print('  queue after remove=${(after['queue'] as List?)?.length}');
      break;
    }
  }

  await link.rpc.call('session/cancel', {
    'request': <String, Object?>{'sessionId': sessionId},
  });
  await link.close();
  exit(0);
}
