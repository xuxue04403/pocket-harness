@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

/// Posts an image prompt to a live Harness and reports how the image came back.
///
/// Run after refreshing the ticket:
///   dart test tool/probe_image_prompt_test.dart
void main() {
  const ticketPath = r'D:\IDE\dsh-bot\probe\_live-ticket.txt';
  const identityPath = r'D:\IDE\dsh-bot\probe\_probe-identity.txt';
  const imagePath = r'D:\IDE\dsh-bot\probe\samples\tiny.png';

  test('an image prompt is accepted and comes back as an attachment', () async {
    final ticket = PairingTicket.decode(File(ticketPath).readAsStringSync().trim());
    final lines = File(identityPath).readAsLinesSync();
    final identity = DeviceIdentity.fromPrivateKey(
      lines[0].trim(),
      decodeBase64Url(lines[1].trim()),
    );

    final link = await LinkClient.connect(ticket, identity, heartbeat: false);
    addTearDown(link.close);

    final created = await link.rpc.call('session/create', {
      'request': <String, Object?>{},
    });
    final sessionId = created['sessionId'];
    expect(sessionId, isA<String>());
    stdout.writeln('session=$sessionId');

    final bytes = File(imagePath).readAsBytesSync();
    final accepted = await link.rpc.call('session/prompt', {
      'request': {
        'requestId': newDeviceId(),
        'sessionId': sessionId,
        'mode': 'queue',
        'content': [
          {'type': 'text', 'text': 'What colour is this image? One word.'},
          {
            'type': 'image',
            'mediaType': 'image/png',
            'data': base64Encode(bytes),
            'name': 'tiny.png',
          },
        ],
      },
    });
    stdout.writeln('accepted=$accepted');
    expect(accepted['accepted'], isTrue);

    // Read the durable page rather than a live stream: the user message is
    // already committed, and a page call cannot hang waiting for frames.
    Map<String, Object?>? imageBlock;
    Object? imageRef;
    for (var attempt = 0; attempt < 20 && imageBlock == null; attempt += 1) {
      await Future<void>.delayed(const Duration(milliseconds: 500));
      final page = await link.rpc.call('session/page', {
        'request': {'address': {'kind': 'session', 'sessionId': sessionId}, 'maxMessages': 20},
      });
      final records = page['records'];
      if (records is! List) continue;
      for (final record in records) {
        if (record is! Map<String, Object?>) continue;
        final event = record['event'];
        if (event is! Map<String, Object?>) continue;
        if (event['type'] != 'user/message') continue;
        final data = event['data'];
        final content = data is Map<String, Object?> ? data['content'] : null;
        if (content is! List) continue;
        for (final block in content) {
          if (block is! Map<String, Object?>) continue;
          if (block['type'] != 'image') continue;
          imageBlock = block;
          final attachment = block['attachment'];
          if (attachment is Map<String, Object?>) imageRef = attachment;
        }
      }
    }

    expect(imageBlock, isNotNull, reason: 'the prompt image should come back as an image block');
    stdout.writeln('image block keys=${imageBlock!.keys.toList()}');
    expect(imageRef, isNotNull);
    final ref = imageRef! as Map<String, Object?>;
    stdout.writeln('attachment keys=${ref.keys.toList()}');

    final value = await link.rpc.call('session/attachment', {
      'request': {'sessionId': sessionId, 'attachment': ref},
    });
    final returned = value['attachment'];
    stdout.writeln('returned keys=${returned is Map ? returned.keys.toList() : returned}');
    stdout.writeln('bytes returned=${(value['data'] as String?)?.length}');
    expect(value['data'], isA<String>());
  }, timeout: const Timeout(Duration(minutes: 3)));
}
