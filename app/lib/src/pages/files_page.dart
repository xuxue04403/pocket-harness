import 'package:material_ui/material_ui.dart';

import '../dsh/host_link.dart';

/// A read-only browser for the workspace a Session owns.
///
/// The Host resolves the workspace root from the Session id, so there is nothing
/// to configure here and nothing outside that root is reachable. Reading is the
/// whole point: the phone is for looking at what the agent produced, and editing
/// files through a narrow pipe would be a worse editor than the desktop.
class FilesPage extends StatefulWidget {
  const FilesPage({
    super.key,
    required this.link,
    required this.sessionId,
    this.root = '',
  });

  final HostLink link;
  final String sessionId;

  /// Workspace-relative path to open first; empty means the root.
  final String root;

  @override
  State<FilesPage> createState() => _FilesPageState();
}

class _FilesPageState extends State<FilesPage> {
  late _Crumb _crumb = _Crumb.parse(widget.root);
  late Future<WorkspaceListing> _listing = _load();
  Future<List<WorkspaceMatch>>? _search;
  final TextEditingController _query = TextEditingController();
  String _submitted = '';

  Future<WorkspaceListing> _load() => widget.link.listDirectory(widget.sessionId, _crumb.path);

  void _open(String path) {
    setState(() {
      _crumb = _Crumb.parse(path);
      _listing = _load();
      _search = null;
      _query.clear();
      _submitted = '';
    });
  }

  void _up() {
    if (_crumb.segments.isEmpty) return;
    _open(_crumb.segments.sublist(0, _crumb.segments.length - 1).join('/'));
  }

  void _onSearch(String value) {
    final trimmed = value.trim();
    setState(() {
      _submitted = trimmed;
      // A blank query is refused by the Host, so it never leaves the phone.
      _search = trimmed.isEmpty ? null : widget.link.findFiles(widget.sessionId, trimmed);
    });
  }

  Future<void> _openFile(String path) async {
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => FilePage(link: widget.link, sessionId: widget.sessionId, path: path),
      ),
    );
  }

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(_crumb.label, maxLines: 1, overflow: TextOverflow.ellipsis),
            Text(
              _crumb.segments.isEmpty ? '工作区根目录' : _crumb.path,
              style: theme.textTheme.labelSmall,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ],
        ),
        actions: [
          if (_crumb.segments.isNotEmpty)
            IconButton(
              onPressed: _up,
              icon: const Icon(Icons.drive_file_move_outline),
              tooltip: '上一级',
            ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
            child: TextField(
              controller: _query,
              textInputAction: TextInputAction.search,
              onSubmitted: _onSearch,
              onChanged: (value) {
                if (value.trim().isEmpty && _submitted.isNotEmpty) _onSearch('');
              },
              decoration: InputDecoration(
                prefixIcon: const Icon(Icons.search),
                hintText: '按文件名或路径查找',
                isDense: true,
                border: const OutlineInputBorder(),
                suffixIcon: _submitted.isEmpty
                    ? null
                    : IconButton(
                        onPressed: () {
                          _query.clear();
                          _onSearch('');
                        },
                        icon: const Icon(Icons.close),
                        tooltip: '清空',
                      ),
              ),
            ),
          ),
          Expanded(child: _submitted.isEmpty ? _browse(theme) : _results(theme)),
        ],
      ),
    );
  }

  Widget _browse(ThemeData theme) {
    return FutureBuilder<WorkspaceListing>(
      future: _listing,
      builder: (context, snapshot) {
        if (snapshot.hasError) {
          return _Problem(
            message: '${snapshot.error}',
            onRetry: () => setState(() => _listing = _load()),
          );
        }
        final listing = snapshot.data;
        if (listing == null) return const Center(child: CircularProgressIndicator());
        if (listing.entries.isEmpty) {
          return Center(
            child: Text('这个目录是空的。', style: theme.textTheme.bodyMedium),
          );
        }
        // Directories first, then files, each by name: the desktop tree reads the
        // same way, and the Host's order is filesystem order.
        final entries = [...listing.entries]
          ..sort((a, b) {
            if (a.isDirectory != b.isDirectory) return a.isDirectory ? -1 : 1;
            return a.name.toLowerCase().compareTo(b.name.toLowerCase());
          });
        return ListView.builder(
          itemCount: entries.length + (listing.truncated ? 1 : 0),
          itemBuilder: (context, index) {
            if (index == entries.length) {
              return Padding(
                padding: const EdgeInsets.all(16),
                child: Text(
                  '这个目录的条目太多，电脑只返回了前一部分。',
                  style: theme.textTheme.bodySmall,
                ),
              );
            }
            final entry = entries[index];
            final childPath = _crumb.path.isEmpty ? entry.name : '${_crumb.path}/${entry.name}';
            return ListTile(
              leading: Icon(
                entry.isDirectory ? Icons.folder_outlined : Icons.description_outlined,
                color: entry.isDirectory ? theme.colorScheme.primary : null,
              ),
              title: Text(entry.name, maxLines: 1, overflow: TextOverflow.ellipsis),
              subtitle: entry.isDirectory ? null : Text(_size(entry.size)),
              trailing: entry.isDirectory ? const Icon(Icons.chevron_right) : null,
              onTap: () => entry.isDirectory ? _open(childPath) : _openFile(childPath),
            );
          },
        );
      },
    );
  }

  Widget _results(ThemeData theme) {
    return FutureBuilder<List<WorkspaceMatch>>(
      future: _search,
      builder: (context, snapshot) {
        if (snapshot.hasError) {
          return _Problem(
            message: '${snapshot.error}',
            onRetry: () => _onSearch(_submitted),
          );
        }
        final matches = snapshot.data;
        if (matches == null) return const Center(child: CircularProgressIndicator());
        if (matches.isEmpty) {
          return Center(
            child: Text('没有匹配「$_submitted」的文件。', style: theme.textTheme.bodyMedium),
          );
        }
        return ListView.separated(
          itemCount: matches.length,
          separatorBuilder: (_, _) => const Divider(height: 1),
          itemBuilder: (context, index) {
            final match = matches[index];
            return ListTile(
              leading: Icon(
                match.isDirectory ? Icons.folder_outlined : Icons.description_outlined,
                color: match.isDirectory ? theme.colorScheme.primary : null,
              ),
              title: Text(match.path, maxLines: 2, overflow: TextOverflow.ellipsis),
              onTap: () => match.isDirectory ? _open(match.path) : _openFile(match.path),
            );
          },
        );
      },
    );
  }

  static String _size(int? bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }
}

/// The workspace-relative path currently open, split for the breadcrumb.
class _Crumb {
  const _Crumb(this.segments);

  final List<String> segments;

  factory _Crumb.parse(String path) {
    final cleaned = path.trim().replaceAll('\\', '/');
    if (cleaned.isEmpty) return const _Crumb([]);
    return _Crumb([
      for (final segment in cleaned.split('/'))
        if (segment.isNotEmpty && segment != '.') segment,
    ]);
  }

  String get path => segments.join('/');

  /// What the app bar shows: the last segment, or the workspace name at the root.
  String get label => segments.isEmpty ? '工作区文件' : segments.last;
}

/// One text file, paged.
class FilePage extends StatefulWidget {
  const FilePage({
    super.key,
    required this.link,
    required this.sessionId,
    required this.path,
  });

  final HostLink link;
  final String sessionId;
  final String path;

  @override
  State<FilePage> createState() => _FilePageState();
}

class _FilePageState extends State<FilePage> {
  static const int _pageLines = 400;

  WorkspaceFileText? _page;
  Object? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _loadFirstPage();
  }

  Future<void> _loadFirstPage() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final page = await widget.link.readFile(widget.sessionId, widget.path, limit: _pageLines);
      if (!mounted) return;
      setState(() {
        _page = page;
        _loading = false;
      });
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error;
        _loading = false;
      });
    }
  }

  Future<void> _loadMore() async {
    final page = _page;
    if (page == null || page.eof || _loading) return;
    setState(() => _loading = true);
    final next = page.offset + page.lines;
    try {
      final more = await widget.link.readFile(widget.sessionId, widget.path, offset: next, limit: _pageLines);
      if (!mounted) return;
      setState(() {
        _page = WorkspaceFileText(
          absolutePath: more.absolutePath,
          text: '${page.text}\n${more.text}',
          offset: page.offset,
          lines: page.lines + more.lines,
          bytes: more.bytes,
          eof: more.eof,
        );
        _loading = false;
      });
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final page = _page;
    final name = widget.path.split('/').last;
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(name, maxLines: 1, overflow: TextOverflow.ellipsis),
            if (page != null)
              Text(
                page.eof ? '${page.lines} 行' : '已读 ${page.lines} 行',
                style: theme.textTheme.labelSmall,
              ),
          ],
        ),
      ),
      body: switch ((page, _error)) {
        (_, final Object error) => _Problem(message: '$error', onRetry: _loadFirstPage),
        (null, _) => const Center(child: CircularProgressIndicator()),
        (final WorkspaceFileText text, _) => ListView(
            padding: const EdgeInsets.all(16),
            children: [
              SelectableText(
                text.text.isEmpty ? '（空文件）' : text.text,
                style: theme.textTheme.bodySmall?.copyWith(fontFamily: 'monospace'),
              ),
              if (!text.eof)
                Padding(
                  padding: const EdgeInsets.only(top: 16),
                  child: FilledButton.tonal(
                    onPressed: _loading ? null : _loadMore,
                    child: Text(_loading ? '读取中…' : '继续读取'),
                  ),
                ),
            ],
          ),
      },
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
            Text('读不到这个目录', style: theme.textTheme.titleMedium),
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
