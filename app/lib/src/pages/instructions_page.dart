import 'package:material_ui/material_ui.dart';

import '../dsh/host_link.dart';

/// Lists, reads and edits the instruction files the agent inherits.
///
/// DSH loads `AGENTS.md`-style files from a user-global chain and a project
/// chain, and those files steer everything the agent does in this directory.
/// The Remote API can read workspace files but cannot write one, so the Host
/// plugin answers these four calls itself — and refuses any file name that is
/// not one the loader would actually consider.
class InstructionsPage extends StatefulWidget {
  const InstructionsPage({
    super.key,
    required this.link,
    required this.sessionId,
    this.cwd,
  });

  final HostLink link;
  final String sessionId;

  /// The session's directory, which decides the project chain.
  final String? cwd;

  @override
  State<InstructionsPage> createState() => _InstructionsPageState();
}

class _InstructionsPageState extends State<InstructionsPage> {
  late Future<InstructionsSnapshot> _snapshot = _load();

  Future<InstructionsSnapshot> _load() => widget.link.instructions(widget.cwd);

  void _reload() => setState(() => _snapshot = _load());

  Future<void> _edit(InstructionFile file) async {
    final messenger = ScaffoldMessenger.of(context);
    final String text;
    try {
      text = await widget.link.instructionText(file.path);
    } on Object catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(_describe(error))));
      return;
    }
    if (!mounted) return;
    final saved = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => InstructionEditorPage(
          link: widget.link,
          file: file,
          initial: text,
        ),
      ),
    );
    if (saved == true) _reload();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('工作区指令'),
        actions: [
          IconButton(
            onPressed: _reload,
            icon: const Icon(Icons.refresh),
            tooltip: '重新读取',
          ),
        ],
      ),
      body: FutureBuilder<InstructionsSnapshot>(
        future: _snapshot,
        builder: (context, state) {
          if (state.hasError) {
            return _Problem(
              text: '读取失败：${_describe(state.error!)}',
              onRetry: _reload,
            );
          }
          final snapshot = state.data;
          if (snapshot == null) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.files.isEmpty) {
            return _Problem(
              text: snapshot.cwd == null
                  ? '这个会话没有工作目录，也没有用户级指令文件。'
                  : '这个目录没有 AGENTS.md 一类的指令文件。',
              onRetry: _reload,
            );
          }
          return ListView(
            padding: const EdgeInsets.symmetric(vertical: 8),
            children: [
              _Summary(
                projectRoot: snapshot.projectRoot,
                cwd: snapshot.cwd,
                count: snapshot.files.length,
              ),
              for (final file in snapshot.files)
                _InstructionTile(file: file, onTap: () => _edit(file)),
              const _Footnote(),
            ],
          );
        },
      ),
    );
  }
}

/// Where these files come from, so a long list is not a mystery.
class _Summary extends StatelessWidget {
  const _Summary({required this.projectRoot, required this.cwd, required this.count});

  final String? projectRoot;
  final String? cwd;
  final int count;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'agent 会读这些指令',
            style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 4),
          Text('共 $count 个文件，按 agent 实际加载的顺序排列。', style: TextStyle(color: muted, fontSize: 13)),
          if (projectRoot != null) ...[
            const SizedBox(height: 4),
            Text('项目根目录：$projectRoot', style: TextStyle(color: muted, fontSize: 12)),
          ],
          if (cwd != null) ...[
            const SizedBox(height: 2),
            Text('会话目录：$cwd', style: TextStyle(color: muted, fontSize: 12)),
          ],
        ],
      ),
    );
  }
}

class _InstructionTile extends StatelessWidget {
  const _InstructionTile({required this.file, required this.onTap});

  final InstructionFile file;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    final where = file.isGlobal ? '用户级 · ${file.label}' : '项目 · ${file.label}';
    return ListTile(
      leading: Icon(
        file.isGlobal ? Icons.public : Icons.folder_outlined,
        color: file.isGlobal ? theme.colorScheme.primary : muted,
      ),
      title: Text(file.name, style: const TextStyle(fontWeight: FontWeight.w500)),
      subtitle: Text('$where · ${file.bytes} 字节', maxLines: 1, overflow: TextOverflow.ellipsis),
      trailing: const Icon(Icons.chevron_right),
      onTap: onTap,
    );
  }
}

class _Footnote extends StatelessWidget {
  const _Footnote();

  @override
  Widget build(BuildContext context) {
    final muted = Theme.of(context).colorScheme.onSurfaceVariant;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
      child: Text(
        '这些文件在下一次请求时生效。改动保存在电脑上，不在手机上。',
        style: TextStyle(color: muted, fontSize: 12, height: 1.4),
      ),
    );
  }
}

/// Edits one instruction file and saves it back to the computer.
class InstructionEditorPage extends StatefulWidget {
  const InstructionEditorPage({
    super.key,
    required this.link,
    required this.file,
    required this.initial,
  });

  final HostLink link;
  final InstructionFile file;
  final String initial;

  @override
  State<InstructionEditorPage> createState() => _InstructionEditorPageState();
}

class _InstructionEditorPageState extends State<InstructionEditorPage> {
  late final TextEditingController _text = TextEditingController(text: widget.initial);
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  bool get _dirty => _text.text != widget.initial;

  Future<void> _save() async {
    if (_saving) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await widget.link.saveInstruction(widget.file.path, _text.text);
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = _describe(error);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    return PopScope<Object?>(
      canPop: !_dirty,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        final leave = await _confirmDiscard(context);
        if (!context.mounted || leave != true) return;
        Navigator.of(context).pop(false);
      },
      child: Scaffold(
        appBar: AppBar(
          title: Text(widget.file.name),
          actions: [
            if (_saving)
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: 16),
                child: Center(
                  child: SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                ),
              )
            else
              TextButton(
                onPressed: _dirty ? _save : null,
                child: const Text('保存'),
              ),
          ],
        ),
        body: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      widget.file.path,
                      style: TextStyle(color: muted, fontSize: 11),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  Text('${_text.text.length} 字', style: TextStyle(color: muted, fontSize: 11)),
                ],
              ),
            ),
            if (_error != null)
              Container(
                width: double.infinity,
                color: theme.colorScheme.errorContainer,
                padding: const EdgeInsets.all(12),
                child: Text(
                  '保存失败：$_error',
                  style: TextStyle(color: theme.colorScheme.onErrorContainer, fontSize: 13),
                ),
              ),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: TextField(
                  controller: _text,
                  maxLines: null,
                  expands: true,
                  textAlignVertical: TextAlignVertical.top,
                  keyboardType: TextInputType.multiline,
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 13, height: 1.45),
                  decoration: const InputDecoration(
                    border: OutlineInputBorder(),
                    hintText: '这个文件还是空的。写点什么，或者直接返回。',
                  ),
                  onChanged: (_) => setState(() {}),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

Future<bool?> _confirmDiscard(BuildContext context) {
  return showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('放弃这次修改？'),
      content: const Text('改动还没保存到电脑上。'),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text('继续编辑'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(true),
          child: const Text('放弃'),
        ),
      ],
    ),
  );
}

/// The Host sends readable messages; strip the transport's wrapper only.
String _describe(Object error) {
  final text = error.toString();
  if (text.startsWith('Exception: ')) return text.substring('Exception: '.length);
  return text;
}

class _Problem extends StatelessWidget {
  const _Problem({required this.text, required this.onRetry});

  final String text;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(text, textAlign: TextAlign.center),
            const SizedBox(height: 16),
            OutlinedButton(onPressed: onRetry, child: const Text('重试')),
          ],
        ),
      ),
    );
  }
}
