import 'package:material_ui/material_ui.dart';

import '../dsh/host_link.dart';

/// What the person chose before a session exists.
class NewSessionChoice {
  const NewSessionChoice({this.agentPreset, this.cwd});

  /// Preset id, or null to let the Host use its default.
  final String? agentPreset;

  /// Working directory, or null to let the Host pick its default.
  final String? cwd;
}

/// Asks for the two things `session/create` can be told: a preset and a `cwd`.
///
/// Both are optional on the wire, so "default" is a first-class choice here.
/// The sheet does not create the session itself; the caller does, so a failure
/// can be reported on the page that owns the connection.
Future<NewSessionChoice?> showNewSessionSheet(
  BuildContext context, {
  required Future<List<AgentPreset>> Function() presets,
  String? initialCwd,
}) {
  return showModalBottomSheet<NewSessionChoice>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (context) => _NewSessionSheet(presets: presets, initialCwd: initialCwd),
  );
}

class _NewSessionSheet extends StatefulWidget {
  const _NewSessionSheet({required this.presets, this.initialCwd});

  /// A factory rather than a future: retrying has to issue a new request, and
  /// re-listening to the future that already failed just replays the error.
  final Future<List<AgentPreset>> Function() presets;
  final String? initialCwd;

  @override
  State<_NewSessionSheet> createState() => _NewSessionSheetState();
}

class _NewSessionSheetState extends State<_NewSessionSheet> {
  late Future<List<AgentPreset>> _presets = widget.presets();
  late final TextEditingController _cwd = TextEditingController(text: widget.initialCwd ?? '');

  /// Null means "whatever the Host defaults to". The roster marks one preset as
  /// default, and picking it explicitly would pin this session to it even if the
  /// Host's default changes later, so the default is offered as its own option.
  String? _preset;

  @override
  void dispose() {
    _cwd.dispose();
    super.dispose();
  }

  void _submit() {
    final cwd = _cwd.text.trim();
    Navigator.of(context).pop(NewSessionChoice(agentPreset: _preset, cwd: cwd.isEmpty ? null : cwd));
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SafeArea(
      child: Padding(
        // Keeps the fields above the keyboard while it is open.
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.85),
          child: ListView(
            shrinkWrap: true,
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
            children: [
              Text('新建会话', style: theme.textTheme.titleMedium),
              const SizedBox(height: 4),
              Text(
                '会话跑在电脑上，这里只决定它用哪套工具和工作目录。',
                style: theme.textTheme.bodySmall,
              ),
              const SizedBox(height: 20),
              Text('智能体预设', style: theme.textTheme.labelLarge),
              FutureBuilder<List<AgentPreset>>(
                future: _presets,
                builder: (context, snapshot) {
                  if (snapshot.connectionState == ConnectionState.waiting) {
                    return const Padding(
                      padding: EdgeInsets.symmetric(vertical: 16),
                      child: Center(child: CircularProgressIndicator()),
                    );
                  }
                  if (snapshot.hasError) {
                    return Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Row(
                        children: [
                          Expanded(
                            child: Text(
                              '读不到预设清单：${snapshot.error}',
                              style: theme.textTheme.bodySmall,
                            ),
                          ),
                          TextButton(
                            onPressed: () => setState(() => _presets = widget.presets()),
                            child: const Text('重试'),
                          ),
                        ],
                      ),
                    );
                  }
                  final roster = snapshot.data ?? const <AgentPreset>[];
                  final defaultPreset = roster.where((p) => p.isDefault).firstOrNull;
                  return Column(
                    children: [
                      _PresetTile(
                        label: defaultPreset == null ? '电脑的默认预设' : '电脑的默认预设（${defaultPreset.label}）',
                        description: '跟随电脑上的设置，之后改默认值也会影响新的会话。',
                        selected: _preset == null,
                        onTap: () => setState(() => _preset = null),
                      ),
                      for (final preset in roster)
                        _PresetTile(
                          label: preset.label,
                          description: preset.description,
                          selected: _preset == preset.id,
                          onTap: () => setState(() => _preset = preset.id),
                        ),
                    ],
                  );
                },
              ),
              const SizedBox(height: 20),
              Text('工作目录', style: theme.textTheme.labelLarge),
              const SizedBox(height: 8),
              TextField(
                controller: _cwd,
                style: theme.textTheme.bodySmall,
                decoration: const InputDecoration(
                  hintText: '留空则用电脑的默认目录，例如 D:\\work\\project',
                  border: OutlineInputBorder(),
                ),
                onSubmitted: (_) => _submit(),
              ),
              const SizedBox(height: 24),
              FilledButton(onPressed: _submit, child: const Text('创建会话')),
            ],
          ),
        ),
      ),
    );
  }
}

class _PresetTile extends StatelessWidget {
  const _PresetTile({
    required this.label,
    required this.selected,
    required this.onTap,
    this.description,
  });

  final String label;
  final String? description;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(
        selected ? Icons.radio_button_checked : Icons.radio_button_unchecked,
        color: selected ? theme.colorScheme.primary : theme.colorScheme.outline,
      ),
      title: Text(label),
      subtitle: description == null
          ? null
          : Text(description!, maxLines: 3, overflow: TextOverflow.ellipsis),
      onTap: onTap,
    );
  }
}
