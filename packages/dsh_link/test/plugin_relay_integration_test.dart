@TestOn('vm')
library;

// Proves a phone reaches the *real plugin* through a relay, with no LAN route.
//
// `relay_integration_test.dart` covers the relay with a hand-written Host stand-in.
// This one runs `host/index.js` itself inside a stand-in Cordis context: the
// plugin generates its own ticket, joins a relay on an ephemeral port, and the
// Dart client connects using only the relay coordinates from that ticket. That is
// the exact path a phone takes when the computer is on another network.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dsh_link/dsh_link.dart';
import 'package:test/test.dart';

const _harnessExe = r'C:\Users\xuexu\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe';
const _probe = r'D:\IDE\dsh-bot\probe\plugin-relay-smoke.mjs';

bool _available() => File(_harnessExe).existsSync() && File(_probe).existsSync();

/// A node process whose first stdout line is one JSON object.
class _Host {
  _Host(this._process, this._stdout, this._stderr);

  final Process _process;
  final StreamSubscription<String> _stdout;
  final StreamSubscription<String> _stderr;
  final List<String> errors = [];
  String? firstLine;

  static Future<_Host> start({Map<String, String> environment = const {}}) async {
    final process = await Process.start(
      _harnessExe,
      [_probe],
      environment: {'ELECTRON_RUN_AS_NODE': '1', ...environment},
    );
    late final _Host handle;
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
    handle = _Host(process, stdout, stderr);
    await ready.future.timeout(
      const Duration(seconds: 40),
      onTimeout: () => throw StateError('the plugin never reported ready: ${handle.errors.join('\n')}'),
    );
    return handle;
  }

  /// Waits until one stderr line contains [needle].
  ///
  /// The relay dial finishes *after* the ticket is printed, so a test that reads
  /// the log immediately races the dial and fails intermittently.
  Future<void> waitForLog(String needle, {Duration timeout = const Duration(seconds: 20)}) async {
    final deadline = DateTime.now().add(timeout);
    while (DateTime.now().isBefore(deadline)) {
      if (errors.any((line) => line.contains(needle))) return;
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
    throw StateError('the log never mentioned "$needle":\n${errors.join('\n')}');
  }

  Future<void> stop() async {
    await _stdout.cancel();
    await _stderr.cancel();
    _process.kill();
  }
}

void main() {
  late _Host host;
  late PairingTicket ticket;

  setUpAll(() async {
    if (!_available()) return;
    host = await _Host.start();
    final payload = jsonDecode(host.firstLine!) as Map<String, Object?>;
    ticket = PairingTicket.decode(payload['ticket']! as String);
  });

  tearDownAll(() async {
    if (!_available()) return;
    await host.stop();
  });

  test('the plugin offers a relay in its pairing code', () async {
    if (!_available()) return;
    expect(ticket.hasRelay, isTrue);
    expect(ticket.relayUrl, startsWith('ws://127.0.0.1:'));
    await host.waitForLog('joined the relay room');
    // The bug this guards: a Host that invents its own token is refused forever.
    expect(host.errors.join('\n'), isNot(contains('bad token')));
  });

  test('an address without a token is refused instead of inventing one', () async {
    if (!_available()) return;
    // The bug this guards: the Host used to generate its own token, so the relay
    // answered 4403 forever and the phone could never use the relay route.
    final broken = await _Host.start(environment: {'OMIT_RELAY_TOKEN': '1'});
    addTearDown(broken.stop);
    final payload = jsonDecode(broken.firstLine!) as Map<String, Object?>;
    final misconfigured = PairingTicket.decode(payload['ticket']! as String);
    expect(misconfigured.hasRelay, isFalse, reason: 'a code must not advertise a relay it cannot use');
    await broken.waitForLog('relayToken is missing');
    // The LAN listener must still come up: a bad relay setting cannot cost the
    // person the connection that works.
    expect(broken.errors.join('\n'), contains('link server listening on port'));
  });

  test('a call reaches the plugin over the relay alone', () async {
    if (!_available()) return;
    // Drop every LAN endpoint: the relay is the only route left.
    final relayOnly = PairingTicket(
      hostDeviceId: ticket.hostDeviceId,
      hostPublicKey: ticket.hostPublicKey,
      hostName: ticket.hostName,
      lanEndpoints: const [],
      relayUrl: ticket.relayUrl,
      relayRoom: ticket.relayRoom,
      relayToken: ticket.relayToken,
      pairingSecret: ticket.pairingSecret,
      expiresAt: ticket.expiresAt,
    );
    final link = await LinkClient.connect(
      relayOnly,
      DeviceIdentity.generate(),
      timeout: const Duration(seconds: 25),
    );
    addTearDown(link.close);
    expect(link.route, LinkRoute.relay);

    final reply = await link.rpc.call('test/echo', {'over': 'relay'});
    expect(reply['echoed'], {'over': 'relay'});
    expect(reply['peer'], 'peer-under-test');
  });
}
