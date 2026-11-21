import 'dart:convert';

import 'package:dsh_link/dsh_link.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_harness/src/storage/host_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

Map<String, Object?> _ticketJson(String hostDeviceId) {
  String b64(List<int> bytes) => base64Url.encode(bytes).replaceAll('=', '');
  return {
    'v': 1,
    'id': hostDeviceId,
    'key': b64(List<int>.filled(32, 7)),
    'name': 'Desk',
    'lan': ['127.0.0.1:48100'],
    'exp': DateTime.now().add(const Duration(minutes: 5)).millisecondsSinceEpoch,
  };
}

String _ticket(String hostDeviceId) =>
    'pocketharness://pair?t=${base64Url.encode(utf8.encode(jsonEncode(_ticketJson(hostDeviceId)))).replaceAll('=', '')}';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
  });

  test('keeps the private key out of preferences', () async {
    final store = await HostStore.open();
    final identity = await store.identity();

    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString('pocket_harness.device.key'), isNull);
    expect(prefs.getString('pocket_harness.device.id'), identity.deviceId);

    // A second open must return the same identity, which means it came back
    // out of the keystore rather than being regenerated.
    final again = await (await HostStore.open()).identity();
    expect(again.deviceId, identity.deviceId);
    expect(again.privateKey, identity.privateKey);
  });

  test('moves a key left in preferences into the keystore', () async {
    final legacy = DeviceIdentity.generate();
    SharedPreferences.setMockInitialValues({
      'pocket_harness.device.id': legacy.deviceId,
      'pocket_harness.device.key': encodeBase64Url(legacy.privateKey),
    });

    final store = await HostStore.open();
    final identity = await store.identity();
    expect(identity.deviceId, legacy.deviceId);
    expect(identity.privateKey, legacy.privateKey);

    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString('pocket_harness.device.key'), isNull);
  });

  test('replaces a corrupt key instead of failing every launch', () async {
    SharedPreferences.setMockInitialValues({
      'pocket_harness.device.id': 'not-a-device-id',
      'pocket_harness.device.key': 'this is not base64url!!',
    });

    final store = await HostStore.open();
    final identity = await store.identity();
    expect(identity.deviceId, isNot('not-a-device-id'));
    expect(identity.privateKey.length, 32);
  });

  test('round-trips hosts and drops a broken entry', () async {
    final store = await HostStore.open();
    await store.saveHost(PairingTicket.decode(_ticket('11111111-1111-7111-8111-111111111111')));
    await store.saveHost(PairingTicket.decode(_ticket('22222222-2222-7222-8222-222222222222')));

    final hosts = store.hosts();
    expect(hosts.map((entry) => entry.hostDeviceId), [
      '22222222-2222-7222-8222-222222222222',
      '11111111-1111-7111-8111-111111111111',
    ]);

    final prefs = await SharedPreferences.getInstance();
    final raw = jsonDecode(prefs.getString('pocket_harness.hosts')!) as List;
    await prefs.setString(
      'pocket_harness.hosts',
      jsonEncode(['not a ticket', ...raw]),
    );
    expect(store.hosts().length, 2);

    await store.removeHost('11111111-1111-7111-8111-111111111111');
    expect(store.hosts().single.hostDeviceId, '22222222-2222-7222-8222-222222222222');
  });
}
