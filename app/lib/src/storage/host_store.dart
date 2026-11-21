import 'dart:convert';

import 'package:dsh_link/dsh_link.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Everything the phone remembers between launches.
///
/// The device identity is a long-lived X25519 key pair: the Host pins its public
/// key on the first successful pairing, so later connections are admitted
/// without the pairing secret. The host list holds the tickets the person
/// scanned, which carry the Host's public key and LAN addresses.
class HostStore {
  HostStore._(this._preferences);

  final SharedPreferences _preferences;

  static const String _deviceIdKey = 'pocket_harness.device.id';
  static const String _deviceKeyKey = 'pocket_harness.device.key';
  static const String _hostsKey = 'pocket_harness.hosts';

  /// Opens the store backed by the platform's preference storage.
  static Future<HostStore> open() async {
    return HostStore._(await SharedPreferences.getInstance());
  }

  /// The phone's identity, created on first use.
  DeviceIdentity identity() {
    final id = _preferences.getString(_deviceIdKey);
    final key = _preferences.getString(_deviceKeyKey);
    if (id != null && key != null) {
      try {
        return DeviceIdentity.fromPrivateKey(id, decodeBase64Url(key));
      } on Object {
        // A corrupt record is replaced rather than blocking the app: the Host
        // simply sees an unfamiliar phone and asks for the pairing code again.
      }
    }
    final created = DeviceIdentity.generate();
    _preferences.setString(_deviceIdKey, created.deviceId);
    _preferences.setString(_deviceKeyKey, encodeBase64Url(created.privateKey));
    return created;
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
