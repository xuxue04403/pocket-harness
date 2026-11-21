import 'dart:convert';
import 'dart:typed_data';

import 'package:dsh_link/dsh_link.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Everything the phone remembers between launches.
///
/// The device identity is a long-lived X25519 key pair: the Host pins its public
/// key on the first successful pairing, so later connections are admitted
/// without the pairing secret. That private key is the only credential here,
/// so it lives in the platform keystore rather than in preferences.
///
/// The host list holds the tickets the person scanned: the Host's public key,
/// its LAN addresses, and the short-lived pairing secret. Pairing secrets are
/// rotated by the Host every ten minutes, and a ticket is only useful until it
/// expires, so the list stays in plain preferences.
class HostStore {
  HostStore._(this._preferences, this._secrets);

  final SharedPreferences _preferences;
  final FlutterSecureStorage _secrets;

  static const String _deviceIdKey = 'pocket_harness.device.id';
  static const String _deviceKeyKey = 'pocket_harness.device.key';
  static const String _hostsKey = 'pocket_harness.hosts';

  /// Opens the store backed by the platform's preference and keystore storage.
  static Future<HostStore> open() async {
    final preferences = await SharedPreferences.getInstance();
    // resetOnError keeps a phone whose keystore entry was invalidated (a
    // restore to new hardware, for example) working: it gets a fresh identity
    // and pairs again instead of crashing on every launch.
    const secrets = FlutterSecureStorage(aOptions: AndroidOptions());
    return HostStore._(preferences, secrets);
  }

  /// The phone's identity, created on first use.
  ///
  /// Reads the keystore first, then the preferences where earlier versions kept
  /// the key. A key found in preferences is moved into the keystore and the
  /// plaintext copy is removed, so upgrading a phone does not make the Host
  /// forget it.
  Future<DeviceIdentity> identity() async {
    final id = _preferences.getString(_deviceIdKey);
    if (id != null) {
      final stored = await _readPrivateKey(id);
      if (stored != null) {
        try {
          return DeviceIdentity.fromPrivateKey(id, stored);
        } on Object {
          // A corrupt record is replaced rather than blocking the app: the Host
          // simply sees an unfamiliar phone and asks for the pairing code again.
        }
      }
    }
    final created = DeviceIdentity.generate();
    await _writeIdentity(created);
    return created;
  }

  Future<Uint8List?> _readPrivateKey(String deviceId) async {
    final fromKeystore = await _secrets.read(key: _deviceKeyKey);
    if (fromKeystore != null) {
      try {
        return decodeBase64Url(fromKeystore);
      } on FormatException {
        // Fall through to the legacy copy and rewrite both.
      }
    }
    final legacy = _preferences.getString(_deviceKeyKey);
    if (legacy == null) return null;
    try {
      final bytes = decodeBase64Url(legacy);
      // Move the plaintext key into the keystore, then drop the copy: earlier
      // versions kept it in preferences, and silently generating a new identity
      // here would make every paired Host forget this phone.
      await _writeIdentity(DeviceIdentity.fromPrivateKey(deviceId, bytes));
      return bytes;
    } on Object {
      await _preferences.remove(_deviceKeyKey);
      return null;
    }
  }

  Future<void> _writeIdentity(DeviceIdentity identity) async {
    await _secrets.write(
      key: _deviceKeyKey,
      value: encodeBase64Url(identity.privateKey),
    );
    await _preferences.setString(_deviceIdKey, identity.deviceId);
    // Only drop the legacy plaintext copy once the keystore write succeeded,
    // so an interrupted migration cannot leave the phone without a key.
    await _preferences.remove(_deviceKeyKey);
  }

  /// Every Host this phone has scanned, most recently used first.
  List<PairingTicket> hosts() {
    final raw = _preferences.getString(_hostsKey);
    if (raw == null || raw.isEmpty) return const [];
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! List) return const [];
      final tickets = <PairingTicket>[];
      for (final entry in decoded) {
        if (entry is! String) continue;
        try {
          tickets.add(PairingTicket.decode(entry));
        } on FormatException {
          // Keep the rest of the list usable even if one entry went bad.
        }
      }
      return tickets;
    } on FormatException {
      return const [];
    }
  }

  /// Adds or replaces one Host, moving it to the front of the list.
  Future<void> saveHost(PairingTicket ticket) async {
    final kept = hosts().where((entry) => entry.hostDeviceId != ticket.hostDeviceId);
    final all = [ticket, ...kept];
    await _write(all);
  }

  /// Forgets one Host entirely.
  Future<void> removeHost(String hostDeviceId) async {
    await _write(hosts().where((entry) => entry.hostDeviceId != hostDeviceId));
  }

  Future<void> _write(Iterable<PairingTicket> tickets) async {
    final encoded = tickets.map((ticket) => ticket.encode()).toList(growable: false);
    await _preferences.setString(_hostsKey, jsonEncode(encoded));
  }
}
