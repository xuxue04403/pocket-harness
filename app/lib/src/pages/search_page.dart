import 'dart:async';

import 'package:material_ui/material_ui.dart';

import '../dsh/host_link.dart';

/// Finds one session among hundreds.
///
/// The Host returns every session in one `session/list` answer, so filtering by
/// title and working directory is instant and always available. Message-content
/// search is a separate Host capability that a deployment may switch off
/// (`session search is disabled`), so it is layered on top when it answers and
/// reported as unavailable when it does not — never silently dropped, and never
/// allowed to hide the results the phone can produce by itself.
class SearchPage extends StatefulWidget {
  const SearchPage({
    super.key,
    required this.sessions,
    required this.onOpen,
    this.contentSearch,
  });

  /// Every session the list already knows about.
  final List<SessionSummary> sessions;

  /// Opens one hit, keeping this page in the back stack.
  final void Function(String sessionId, String title) onOpen;

  /// The Host's content search, when the deployment supports it.
  final Future<SessionSearchResult> Function(String query)? contentSearch;

  @override
  State<SearchPage> createState() => _SearchPageState();
}

class _SearchPageState extends State<SearchPage> {
  final TextEditingController _query = TextEditingController();
  Timer? _debounce;
  String _submitted = '';
  List<SessionSummary> _local = const [];
  Future<SessionSearchResult>? _content;
  String? _contentError;

  @override
  void dispose() {
    _debounce?.cancel();
    _query.dispose();
    super.dispose();
  }

  /// Debounced because content search is a round trip over the encrypted link,
  /// which is slow on a relay. Local filtering could run per keystroke, but one
  /// path keeps the two result sets consistent.
  void _onChanged(String text) {
    final query = text.trim();
    _debounce?.cancel();
    if (query.isEmpty) {
      setState(() {
        _submitted = '';
        _local = const [];
        _content = null;
        _contentError = null;
      });
      return;
    }
    _debounce = Timer(const Duration(milliseconds: 200), () => _run(query));
  }

  void _run(String query) {
    if (!mounted) return;
    setState(() {
      _submitted = query;
      _local = filterSessions(widget.sessions, query);
      _contentError = null;
      final search = widget.contentSearch;
      if (search == null) {
        _content = null;
      } else {
        _content = search(query);
        // A Host without the content index fails every query, so the failure is
        // remembered per query rather than being retried forever.
        unawaited(_content!.then((_) {}, onError: (Object error) {
          if (mounted) setState(() => _contentError = _describeContentError(error));
        }));
      }
    });
  }

  String _describeContentError(Object error) {
    final text = '$error';
    if (text.contains('session search is disabled')) {
      return '这台电脑没有开启会话正文检索，只能按标题和目录查找。';
    }
    return '正文检索失败：$text';
  }

  /// A short label for a session this page has no title for.
  ///
  /// The id is Host-controlled, so it is not assumed to be longer than the
  /// prefix: a short id would throw a RangeError while building the list.
  String _shortId(String sessionId) =>
      sessionId.length <= 8 ? sessionId : sessionId.substring(0, 8);

  String _titleFor(String sessionId) {
    for (final session in widget.sessions) {
      if (session.sessionId == sessionId) return session.title;
    }
    return '会话 ${_shortId(sessionId)}…';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: TextField(
          controller: _query,
          autofocus: true,
          textInputAction: TextInputAction.search,
          decoration: const InputDecoration(hintText: '搜索标题、目录或会话内容', border: InputBorder.none),
          onChanged: _onChanged,
          onSubmitted: (text) {
            final query = text.trim();
            if (query.isEmpty) return;
            _debounce?.cancel();
            _run(query);
          },
        ),
        actions: [
          if (_query.text.isNotEmpty)
            IconButton(
              onPressed: () {
                _query.clear();
                _onChanged('');
              },
              icon: const Icon(Icons.clear),
              tooltip: '清空',
            ),
        ],
      ),
      body: _submitted.isEmpty
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(32),
                child: Text(
                  '按标题或工作目录查找。这台电脑支持的话，也会搜索会话正文。',
                  textAlign: TextAlign.center,
                  style: theme.textTheme.bodyMedium,
                ),
              ),
            )
          : _results(theme),
    );
  }

  Widget _results(ThemeData theme) {
    final content = _content;
    return ListView(
      children: [
        if (_local.isNotEmpty) ...[
          _sectionLabel(theme, '按标题和目录'),
          ..._local.map(
            (session) => ListTile(
              leading: const Icon(Icons.chat_bubble_outline),
              title: Text(session.title, maxLines: 1, overflow: TextOverflow.ellipsis),
              subtitle: Text(
                session.cwd ?? _shortId(session.sessionId),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              onTap: () => widget.onOpen(session.sessionId, session.title),
            ),
          ),
        ],
        if (content != null) ...[
          _sectionLabel(theme, '会话正文'),
          if (_contentError != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
              child: Text(_contentError!, style: theme.textTheme.bodySmall),
            )
          else
            FutureBuilder<SessionSearchResult>(
              future: content,
              builder: (context, snapshot) {
                if (snapshot.connectionState == ConnectionState.waiting) {
                  return const Padding(
                    padding: EdgeInsets.all(16),
                    child: Center(child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))),
                  );
                }
                final data = snapshot.data;
                if (data == null || data.hits.isEmpty) {
                  return Padding(
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                    child: Text('正文里没有找到「$_submitted」。', style: theme.textTheme.bodySmall),
                  );
                }
                // The Host bounds its answer, so say so rather than implying the
                // list is complete.
                final hits = data.hits;
                return Column(
                  children: [
                    ...hits.map((hit) {
                      final title = _titleFor(hit.sessionId);
                      return ListTile(
                        title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
                        subtitle: Text(hit.snippet, maxLines: 3, overflow: TextOverflow.ellipsis),
                        onTap: () => widget.onOpen(hit.sessionId, title),
                      );
                    }),
                    if (data.hasMore)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                        child: Text(
                          '只显示前 ${hits.length} 条正文结果，换个更具体的关键词可以缩小范围。',
                          style: theme.textTheme.bodySmall,
                        ),
                      ),
                  ],
                );
              },
            ),
        ],
        if (_local.isEmpty && content == null && _contentError == null)
          Padding(
            padding: const EdgeInsets.all(32),
            child: Text('没有匹配的会话。', textAlign: TextAlign.center, style: theme.textTheme.bodyMedium),
          ),
      ],
    );
  }

  Widget _sectionLabel(ThemeData theme, String text) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
        child: Text(text, style: theme.textTheme.labelMedium),
      );
}
