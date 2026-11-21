import 'package:material_ui/material_ui.dart';

import '../dsh/host_link.dart';

/// One model picker, for a session's override or for the Host-wide default.
///
/// DSH keeps two things apart: the Host-wide default a session inherits, and the
/// route this one session actually uses. The sheet states which of the two the
/// caller is changing, so a write is never mistaken for the other.
Future<ModelSelection?> showModelPicker(
  BuildContext context, {
  required Future<ModelCatalog> catalog,
  required Future<ModelSelection?> current,
  required Future<ModelSelection> Function(ModelChoice choice, String? effort) onSelect,
  String title = '本会话使用的模型',
  String subtitle = '只改这一个会话。电脑上的默认设置不受影响，新建会话仍从默认开始。',
}) {
  return showModalBottomSheet<ModelSelection>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (context) => _ModelSheet(
      catalog: catalog,
      current: current,
      onSelect: onSelect,
      title: title,
      subtitle: subtitle,
    ),
  );
}

class _ModelSheet extends StatefulWidget {
  const _ModelSheet({
    required this.catalog,
    required this.current,
    required this.onSelect,
    required this.title,
    required this.subtitle,
  });

  final Future<ModelCatalog> catalog;
  final Future<ModelSelection?> current;
  final Future<ModelSelection> Function(ModelChoice choice, String? effort) onSelect;
  final String title;
  final String subtitle;

  @override
  State<_ModelSheet> createState() => _ModelSheetState();
}

class _ModelSheetState extends State<_ModelSheet> {
  late Future<({ModelCatalog catalog, ModelSelection? selection})> _data = _load();
  Object? _error;
  bool _busy = false;

  Future<({ModelCatalog catalog, ModelSelection? selection})> _load() async {
    final catalog = await widget.catalog;
    final selection = await widget.current;
    return (catalog: catalog, selection: selection);
  }

  Future<void> _pick(ModelChoice choice, String? effort) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final navigator = Navigator.of(context);
    try {
      final selected = await widget.onSelect(choice, effort);
      if (!mounted) return;
      navigator.pop(selected);
    } on Object catch (error) {
      if (!mounted) return;
      // The sheet covers the bottom of the screen, so a snackbar would land
      // behind it; the failure is reported in place instead.
      setState(() {
        _error = error;
        _busy = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.75),
        child: FutureBuilder<({ModelCatalog catalog, ModelSelection? selection})>(
          future: _data,
          builder: (context, snapshot) {
            if (snapshot.hasError) {
              return Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text('读不到模型清单', style: theme.textTheme.titleMedium),
                    const SizedBox(height: 8),
                    Text('${snapshot.error}', style: theme.textTheme.bodySmall),
                    const SizedBox(height: 16),
                    FilledButton(
                      onPressed: () => setState(() => _data = _load()),
                      child: const Text('重试'),
                    ),
                  ],
                ),
              );
            }
            final data = snapshot.data;
            if (data == null) {
              return const Padding(
                padding: EdgeInsets.all(32),
                child: Center(child: CircularProgressIndicator()),
              );
            }
            return _list(theme, data.catalog, data.selection);
          },
        ),
      ),
    );
  }

  Widget _list(ThemeData theme, ModelCatalog catalog, ModelSelection? selection) {
    final providers = <String, List<ModelChoice>>{};
    for (final choice in catalog.choices) {
      providers.putIfAbsent(choice.providerName, () => []).add(choice);
    }
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
      children: [
        Text(widget.title, style: theme.textTheme.titleMedium),
        const SizedBox(height: 4),
        Text(widget.subtitle, style: theme.textTheme.bodySmall),
        if (_busy) const Padding(
          padding: EdgeInsets.symmetric(vertical: 12),
          child: LinearProgressIndicator(),
        ),
        if (_error != null) Padding(
          padding: const EdgeInsets.only(top: 12),
          child: Text('$_error', style: TextStyle(color: theme.colorScheme.error)),
        ),
        for (final entry in providers.entries) ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(0, 20, 0, 4),
            child: Text(entry.key, style: theme.textTheme.labelLarge),
          ),
          for (final choice in entry.value)
            _ModelTile(
              choice: choice,
              selected: selection != null &&
                  selection.provider == choice.provider &&
                  selection.model == choice.model,
              currentEffort: selection != null &&
                      selection.provider == choice.provider &&
                      selection.model == choice.model
                  ? selection.reasoningEffort
                  : null,
              busy: _busy,
              onPick: _pick,
            ),
        ],
        if (catalog.choices.isEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 24),
            child: Text('这台电脑没有可用的模型。', style: theme.textTheme.bodyMedium),
          ),
      ],
    );
  }
}

class _ModelTile extends StatelessWidget {
  const _ModelTile({
    required this.choice,
    required this.selected,
    required this.currentEffort,
    required this.busy,
    required this.onPick,
  });

  final ModelChoice choice;
  final bool selected;
  final String? currentEffort;
  final bool busy;
  final void Function(ModelChoice choice, String? effort) onPick;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final effort = selected ? currentEffort : choice.defaultEffort;
    return ListTile(
      contentPadding: EdgeInsets.zero,
      enabled: !busy,
      leading: Icon(
        selected ? Icons.radio_button_checked : Icons.radio_button_unchecked,
        color: selected ? theme.colorScheme.primary : theme.colorScheme.outline,
      ),
      title: Text(choice.name),
      subtitle: Text(
        [
          choice.model,
          if (choice.description != null) choice.description!,
        ].join(' · '),
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
      ),
      trailing: choice.efforts.isEmpty
          ? null
          : PopupMenuButton<String>(
              tooltip: '思考强度',
              enabled: !busy,
              initialValue: effort,
              onSelected: (value) => onPick(choice, value),
              itemBuilder: (context) => [
                for (final option in choice.efforts)
                  PopupMenuItem(value: option.id, child: Text(option.name)),
              ],
              child: Chip(
                label: Text(_effortLabel(choice, effort)),
                visualDensity: VisualDensity.compact,
              ),
            ),
      onTap: busy ? null : () => onPick(choice, effort),
    );
  }

  static String _effortLabel(ModelChoice choice, String? effort) {
    if (effort == null) return '默认强度';
    for (final option in choice.efforts) {
      if (option.id == effort) return option.name;
    }
    return effort;
  }
}
