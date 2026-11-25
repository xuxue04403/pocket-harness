import 'package:dsh_link/dsh_link.dart';
import 'package:material_ui/material_ui.dart';

import '../local/local_commands.dart';
import '../local/local_host.dart';
import '../storage/host_store.dart';
import 'local_page.dart';
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
        title: const Text('忘记这台电脑？'),
        content: Text(
          '${ticket.hostName} will ask for a new pairing code next time. '
          '会话仍然保留在电脑上。',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('忘记')),
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

  /// 「不连电脑、就在这台手机上跑」。第二条链路，和远程配对并列入口。
  void _openLocal() {
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => const LocalPage()),
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
            tooltip: '扫码配对',
          ),
          IconButton(
            onPressed: _paste,
            icon: const Icon(Icons.keyboard),
            tooltip: '手动输入配对码',
          ),
          if (LocalHost.supported && kLocalDshEnabled)
            IconButton(
              onPressed: _openLocal,
              icon: const Icon(Icons.phone_android),
              tooltip: '在这台手机上跑 dsh',
            ),
        ],
      ),
      floatingActionButton: _hosts.isEmpty
          ? null
          : FloatingActionButton.extended(
              onPressed: _scan,
              icon: const Icon(Icons.qr_code_scanner),
              label: const Text('配对'),
            ),
      body: _hosts.isEmpty
          ? _EmptyState(
              onScan: _scan,
              onPaste: _paste,
              onLocal: LocalHost.supported && kLocalDshEnabled ? _openLocal : null,
            )
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
            tooltip: '忘记',
          ),
          onTap: () => _open(ticket),
        );
      },
    );
  }

  String _subtitle(PairingTicket ticket, bool expired) {
    final addresses = ticket.lanEndpoints.take(2).join(', ');
    // A relay in the saved ticket is what lets the phone reach this computer from
    // outside its Wi-Fi, so it is worth saying plainly rather than leaving people
    // to guess why one entry works on mobile data and another does not.
    final reach = ticket.hasRelay ? '可经中继' : '仅局域网';
    if (expired) {
      return '之前已配对 · $reach\n配对码已过期，但这台手机仍然受信任。';
    }
    return addresses.isEmpty ? '配对码里没有局域网地址 · $reach' : '$addresses · $reach';
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.onScan, required this.onPaste, this.onLocal});

  final VoidCallback onScan;
  final VoidCallback onPaste;
  final VoidCallback? onLocal;

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
            Text('配对你的电脑', style: theme.textTheme.titleLarge),
            const SizedBox(height: 8),
            Text(
              '在电脑上打开 DeepSeek Harness，从日志里找到 Pocket Harness 的配对码，在这里扫描。'
              '之后手机和电脑会直接通过网络通信，全程端到端加密。',
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium,
            ),
            const SizedBox(height: 24),
            FilledButton.icon(
              onPressed: onScan,
              icon: const Icon(Icons.qr_code_scanner),
              label: const Text('扫描配对二维码'),
            ),
            const SizedBox(height: 8),
            TextButton.icon(
              onPressed: onPaste,
              icon: const Icon(Icons.keyboard),
              label: const Text('改为手动输入'),
            ),
            if (onLocal != null) ...[
              const SizedBox(height: 24),
              const Divider(),
              const SizedBox(height: 8),
              Text(
                '没有电脑？也可以让 dsh 直接跑在这台手机上。',
                textAlign: TextAlign.center,
                style: theme.textTheme.bodySmall,
              ),
              const SizedBox(height: 8),
              OutlinedButton.icon(
                onPressed: onLocal,
                icon: const Icon(Icons.phone_android),
                label: const Text('在这台手机上跑 dsh'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
