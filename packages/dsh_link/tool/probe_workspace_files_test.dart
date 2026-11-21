@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

void main() {
  test('workspace file search', () async {
    final ticket = PairingTicket.decode(File(r'D:\IDE\dsh-bot\probe\_live-ticket.txt').readAsStringSync().trim());
    final lines = File(r'D:\IDE\dsh-bot\probe\_probe-identity.txt').readAsLinesSync();
    final identity = DeviceIdentity.fromPrivateKey(lines[0].trim(), decodeBase64Url(lines[1].trim()));
    final link = await LinkClient.connect(ticket, identity);
    addTearDown(link.close);

    final created = await link.rpc.call('session/create', {'request': <String, Object?>{'cwd': r'D:\IDE\dsh-bot'}});
    final sessionId = created['sessionId'] as String;

    for (final request in [
      {'query': 'Pocket', 'excludedPaths': <String>[], 'includeHidden': false, 'respectGitignore': true},
      {'query': 'tool_labels', 'excludedPaths': <String>[], 'includeHidden': true, 'respectGitignore': false},
    ]) {
      try {
        final value = await link.rpc.call('workspaceFiles/search', {
          'workspaceFileScopeId': sessionId,
          'request': request,
        });
        final matches = (value['matches'] as List?) ?? const [];
        stdout.writeln('ok keys=${value.keys.toList()} count=${matches.length}');
        for (final match in matches.take(4)) {
          stdout.writeln('  ${jsonEncode(match)}');
        }
      } on RpcException catch (error) {
        stdout.writeln('failed: ${error.code} ${error.message}');
      }
    }
  }, timeout: const Timeout(Duration(minutes: 2)));
}
