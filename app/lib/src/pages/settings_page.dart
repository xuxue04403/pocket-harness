import 'dart:convert';

import 'package:material_ui/material_ui.dart';

import '../dsh/host_link.dart';
import 'model_sheet.dart';

/// The computer's own defaults, as a phone can read and change them.
///
/// DSH resolves configuration per namespace and reports the resolved value, so
/// this page shows exactly what the desktop would use. Only the global default
/// model is editable here: it is the one setting the session screen explicitly
/// overrides, and offering a raw JSON editor for the rest would be a worse
/// experience than walking to the computer.
class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key, required this.link});

  final HostLink link;

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  late Future<SettingsSnapshot> _snapshot = _load();
  Object? _error;

  Future<SettingsSnapshot> _load() async {
    if (mounted) {
      setState(() {
        _error = null;
      });
    }
    return widget.link.settings();
  }

  Future<void> _editDefaultModel(SettingsSnapshot snapshot) async {
    final namespace = snapshot.find('agent-default-model');
    if (namespace == null) return;
    final provider = namespace.value['provider'];
    final model = namespace.value['model'];
    final selected = await showModelPicker(
      context,
      catalog: widget.link.modelCatalog(),
      current: Future.value(
        provider is String && model is String
            ? ModelSelection(provider: provider, model: model)
            : null,
      ),
      title: '全局默认模型',
      subtitle: '新建会话从这里开始。已经存在的会话不受影响。',
      onSelect: (choice, effort) async {
        final updated = await widget.link.updateSetting(namespace, {
          'provider': choice.provider,
          'model': choice.model,
        });
        final next = ModelSelection.fromProjections(updated.value) ??
            ModelSelection(provider: choice.provider, model: choice.model);
        return next;
      },
    );
    if (selected == null || !mounted) return;
    setState(() {
      _snapshot = _load();
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('电脑设置')),
      body: FutureBuilder<SettingsSnapshot>(
        future: _snapshot,
        builder: (context, snapshot) {
          if (snapshot.hasError) {
            return _Problem(
              message: '${snapshot.error}',
              onRetry: () => setState(() => _snapshot = _load()),
            );
          }
          final data = snapshot.data;
          if (data == null) {
            return const Center(child: CircularProgressIndicator());
          }
          final defaultModel = data.find('agent-default-model');
          final others = [
            for (final namespace in data.namespaces)
              if (namespace.ns != 'agent-default-model') namespace,
          ];
          return ListView(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
            children: [
              if (!data.writable)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Text(
                    '这个配置档案是只读的，手机上改不了。',
                    style: TextStyle(color: theme.colorScheme.error),
                  ),
                ),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Text('$_error', style: TextStyle(color: theme.colorScheme.error)),
                ),
              Text('全局默认模型', style: theme.textTheme.titleMedium),
              const SizedBox(height: 4),
              Text(
                '新建会话从这里开始。会话里选的模型只覆盖那一个会话。',
                style: theme.textTheme.bodySmall,
              ),
              const SizedBox(height: 8),
              Card(
                margin: EdgeInsets.zero,
                child: ListTile(
                  enabled: data.writable && defaultModel != null,
                  leading: const Icon(Icons.memory_outlined),
                  title: Text(_defaultModelLabel(defaultModel)),
                  subtitle: Text(
                    defaultModel == null
                        ? '这台电脑没有设置默认模型'
                        : '点击更改',
                  ),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: defaultModel == null ? null : () => _editDefaultModel(data),
                ),
              ),
              const SizedBox(height: 24),
              Text('其它配置', style: theme.textTheme.titleMedium),
              const SizedBox(height: 4),
              Text(
                '由电脑上的 Harness 决定，这里只读。',
                style: theme.textTheme.bodySmall,
              ),
              const SizedBox(height: 8),
              for (final namespace in others)
                _NamespaceTile(namespace: namespace),
            ],
          );
        },
      ),
    );
  }

  String _defaultModelLabel(SettingsNamespace? namespace) {
    final provider = namespace?.value['provider'];
    final model = namespace?.value['model'];
    if (provider is! String || model is! String) return '未设置';
    return '$model · $provider';
  }
}

class _NamespaceTile extends StatelessWidget {
  const _NamespaceTile({required this.namespace});

  final SettingsNamespace namespace;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final body = const JsonEncoder.withIndent('  ').convert(namespace.value);
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ExpansionTile(
        shape: const Border(),
        title: Text(namespace.ns, style: theme.textTheme.bodyMedium),
        subtitle: Text(
          namespace.secrets.isEmpty ? '点击查看' : '含电脑上保存的密钥，已隐藏',
          style: theme.textTheme.bodySmall,
        ),
        childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        children: [
          SizedBox(
            width: double.infinity,
            child: SelectableText(
              body,
              style: theme.textTheme.bodySmall?.copyWith(fontFamily: 'monospace'),
            ),
          ),
        ],
      ),
    );
  }
}

class _Problem extends StatelessWidget {
  const _Problem({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('读不到电脑的设置', style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            Text(message, style: theme.textTheme.bodySmall, textAlign: TextAlign.center),
            const SizedBox(height: 16),
            FilledButton(onPressed: onRetry, child: const Text('重试')),
          ],
        ),
      ),
    );
  }
}
