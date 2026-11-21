@TestOn('vm')
library;

// Proves the relay route really carries a Noise-protected DSH link.
//
// Two node processes are started for real: relay/server.mjs (the dumb relay) and
// probe/relay-host-smoke.mjs (a Host that joins it and listens on no TCP port at
// all). The ticket below therefore has no LAN endpoint, so the only way the Dart
// client can reach the Host is through the relay — which is exactly the case a
// phone uses when the computer is on another network.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

const _harnessExe = r'C:\Users\xuexu\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe';
const _relayScript = r'D:\IDE\dsh-bot\relay\run.mjs';
const _hostScript = r'D:\IDE\dsh-bot\probe\relay-host-smoke.mjs';
const _relayToken = 'relay-test-token-0123456789';

bool _available() =>
    File(_harnessExe).existsSync() && File(_relayScript).existsSync() && File(_hostScript).existsSync();

/// A node process whose first stdout line is one JSON object.
class _NodeProcess {
  _NodeProcess(this._process, this._stdout, this._stderr);

  final Process _process;
  final StreamSubscription<String> _stdout;
  final StreamSubscription<String> _stderr;
  final List<String> errors = [];
  String? firstLine;

  static Future<_NodeProcess> start(
    List<String> arguments, {
    Map<String, String> environment = const {},
  }) async {
    final process = await Process.start(
      _harnessExe,
      arguments,
      environment: {'ELECTRON_RUN_AS_NODE': '1', ...environment},
    );
    late final _NodeProcess handle;
    final ready = Completer<void>();
    final stdout = process.stdout.transform(utf8.decoder).transform(const LineSplitter()).listen((line) {
      if (handle.firstLine == null && line.trim().isNotEmpty) {
        handle.firstLine = line;
        if (!ready.isCompleted) ready.complete();
      }
    });
    final stderr = process.stderr.transform(utf8.decoder).transform(const LineSplitter()).listen((line) {
      handle.errors.add(line);
    });
    handle = _NodeProcess(process, stdout, stderr);
    await ready.future.timeout(
      const Duration(seconds: 40),
      onTimeout: () => throw StateError('the helper did not report ready: ${handle.errors.join('\n')}'),
    );
    return handle;
  }

  Future<void> stop() async {
    await _stdout.cancel();
    await _stderr.cancel();
    _process.kill();
  }
}

void main() {
  late _NodeProcess relay;
  late _NodeProcess host;
  late PairingTicket ticket;
  late Directory identityDir;

  setUpAll(() async {
    if (!_available()) return;
    identityDir = await Directory.systemTemp.createTemp('pocket-harness-relay-');
    relay = await _NodeProcess.start(
      [_relayScript],
      environment: {
        'POCKET_HARNESS_RELAY_TOKEN': _relayToken,
        'PORT': '0',
        'HOST': '127.0.0.1',
      },
    );
    // `PORT=0` leaves run.mjs printing the bound port, which it chose itself.
    final port = RegExp(r'listening on .*:(\d+)').firstMatch(relay.errors.join('\n'))?.group(1) ??
        RegExp(r'listening on .*:(\d+)').firstMatch(relay.firstLine ?? '')?.group(1);
    if (port == null) throw StateError('the relay did not report its port: ${relay.firstLine}');
    host = await _NodeProcess.start(
      [_hostScript],
      environment: {
        'RELAY_URL': 'ws://127.0.0.1:$port/relay',
        'RELAY_TOKEN': _relayToken,
      },
    );
    final payload = jsonDecode(host.firstLine!) as Map<String, Object?>;
    ticket = PairingTicket.decode(payload['ticket']! as String);
  });

  tearDownAll(() async {
    if (!_available()) return;
    await host.stop();
    await relay.stop();
    await identityDir.delete(recursive: true);
  });

  test('the pairing code carries relay coordinates and no LAN endpoint', () {
    if (!_available()) return;
    expect(ticket.lanEndpoints, isEmpty);
    expect(ticket.hasRelay, isTrue);
    expect(ticket.relayUrl, startsWith('ws://127.0.0.1:'));
    expect(ticket.relayRoom, isNotNull);
    expect(ticket.relayToken, isNotNull);
  });

  test('a call travels over the relay inside a Noise channel', () async {
    if (!_available()) return;
    final identityFile = File('${identityDir.path}/identity.txt');
    final identity = _identity(identityFile);
    final link = await LinkClient.connect(ticket, identity, timeout: const Duration(seconds: 20));
    addTearDown(link.close);
    expect(link.route, LinkRoute.relay);

    final reply = await link.rpc.call('test/echo', {'over': 'relay'});
    expect(reply['echoed'], {'over': 'relay'});
    expect(reply['peer'], 'peer-under-test');
  });

  test('a stream travels over the relay', () async {
    if (!_available()) return;
    final identity = _identity(File('${identityDir.path}/identity.txt'));
    final link = await LinkClient.connect(ticket, identity, timeout: const Duration(seconds: 20));
    addTearDown(link.close);

    final seen = await link.openStream('test/count', {'count': 4}).map((event) => event['index']).toList();
    expect(seen, [0, 1, 2, 3]);
  });
}

/// Reuses one device identity, so the Host sees a single phone across tests.
DeviceIdentity _identity(File file) {
  if (file.existsSync()) {
    final lines = file.readAsLinesSync();
    return DeviceIdentity.fromPrivateKey(lines.first, base64Url.decode(_pad(lines.last)));
  }
  final identity = DeviceIdentity.generate();
  file.writeAsStringSync(
    '${identity.deviceId}\n${base64Url.encode(identity.privateKey).replaceAll('=', '')}\n',
  );
  return identity;
}

String _pad(String value) {
  final remainder = value.length % 4;
  if (remainder == 0) return value;
  return value + ('=' * (4 - remainder));
}
