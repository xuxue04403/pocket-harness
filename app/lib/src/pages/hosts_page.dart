import 'package:dsh_link/dsh_link.dart';
import 'package:material_ui/material_ui.dart';

import '../storage/host_store.dart';
import 'paste_page.dart';
import 'sessions_page.dart';
import 'scan_page.dart';

/// Lists the Hosts this phone paired with, and starts a new pairing.
class HostsPage extends StatefulWidget {
  const HostsPage({super.key, required this.store});

  final HostStore store;

  @override
  State<HostsPage> createState() => _HostsPageState();
}

class _HostsPageState extends State<HostsPage> {
  late List<PairingTicket> _hosts = widget.store.hosts();

  Future<void> _scan() async {
    final ticket = await Navigator.of(context).push<PairingTicket>(
      MaterialPageRoute(builder: (_) => const ScanPage()),
    );
    if (ticket == null) return;
    await _accept(ticket);
  }

  Future<void> _paste() async {
    final ticket = await Navigator.of(context).push<PairingTicket>(
      MaterialPageRoute(builder: (_) => const PastePage()),
    );
    if (ticket == null) return;
    await _accept(ticket);
  }

  Future<void> _accept(PairingTicket ticket) async {
    await widget.store.saveHost(ticket);
    if (!mounted) return;
    setState(() => _hosts = widget.store.hosts());
    if (mounted) _open(ticket);
  }

  Future<void> _forget(PairingTicket ticket) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Forget this Host?'),
        content: Text(
          '${ticket.hostName} will ask for a new pairing code next time. '
          'Sessions stay on the Host.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Forget')),
        ],
      ),
    );
    if (confirmed != true) return;
    await widget.store.removeHost(ticket.hostDeviceId);
    if (!mounted) return;
    setState(() => _hosts = widget.store.hosts());
  }

  void _open(PairingTicket ticket) {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => SessionsPage(
          store: widget.store,
          ticket: ticket,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Pocket Harness'),
        actions: [
          IconButton(
            onPressed: _scan,
            icon: const Icon(Icons.qr_code_scanner),
            tooltip: 'Pair a Host',
          ),
          IconButton(
            onPressed: _paste,
            icon: const Icon(Icons.keyboard),
            tooltip: 'Enter a pairing code',
          ),
        ],
      ),
      floatingActionButton: _hosts.isEmpty
          ? null
          : FloatingActionButton.extended(
              onPressed: _scan,
              icon: const Icon(Icons.qr_code_scanner),
              label: const Text('Pair'),
            ),
      body: _hosts.isEmpty
          ? _EmptyState(onScan: _scan, onPaste: _paste)
          : _hostList(context),
    );
  }

  Widget _hostList(BuildContext context) {
    return ListView.separated(
      padding: const EdgeInsets.only(bottom: 96),
      itemCount: _hosts.length,
      separatorBuilder: (_, _) => const Divider(height: 1),
      itemBuilder: (context, index) {
        final ticket = _hosts[index];
        final expired = !ticket.isValidAt(DateTime.now());
        return ListTile(
          leading: const CircleAvatar(child: Icon(Icons.computer)),
          title: Text(ticket.hostName),
          subtitle: Text(
            _subtitle(ticket, expired),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
          trailing: IconButton(
            onPressed: () => _forget(ticket),
            icon: const Icon(Icons.link_off),
            tooltip: 'Forget',
          ),
          onTap: () => _open(ticket),
        );
      },
    );
  }

  String _subtitle(PairingTicket ticket, bool expired) {
    final addresses = ticket.lanEndpoints.take(2).join(', ');
    if (expired) {
      return 'Paired earlier · $addresses\nIts pairing code lapsed, but this phone is still trusted.';
    }
    return addresses.isEmpty ? 'No LAN address in the code' : addresses;
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.onScan, required this.onPaste});

  final VoidCallback onScan;
  final VoidCallback onPaste;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.qr_code_2, size: 64, color: theme.colorScheme.primary),
            const SizedBox(height: 16),
            Text('Pair your desktop', style: theme.textTheme.titleLarge),
            const SizedBox(height: 8),
            Text(
              'Open DeepSeek Harness on your computer, find the Pocket Harness '
              'pairing code in its log, and scan it here. The phone and the '
              'computer then talk directly over your network, end to end encrypted.',
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium,
            ),
            const SizedBox(height: 24),
            FilledButton.icon(
              onPressed: onScan,
              icon: const Icon(Icons.qr_code_scanner),
              label: const Text('Scan the pairing code'),
            ),
            const SizedBox(height: 8),
            TextButton.icon(
              onPressed: onPaste,
              icon: const Icon(Icons.keyboard),
              label: const Text('Enter it by hand instead'),
            ),
          ],
        ),
      ),
    );
  }
}
