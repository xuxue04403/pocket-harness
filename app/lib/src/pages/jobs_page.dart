import 'dart:async';

import 'package:material_ui/material_ui.dart';

import '../dsh/host_link.dart';

/// The background jobs one session owns, plus their live output.
///
/// The roster is a whole-set stream from the Host, so this screen never merges:
/// each frame replaces the list, which is also what makes reconnecting safe.
class JobsPage extends StatefulWidget {
  const JobsPage({super.key, required this.link, required this.sessionId});

  final HostLink link;
  final String sessionId;

  @override
  State<JobsPage> createState() => _JobsPageState();
}

class _JobsPageState extends State<JobsPage> {
  List<JobSummary>? _jobs;
  Object? _error;
  StreamSubscription<List<JobSummary>>? _roster;

  @override
  void initState() {
    super.initState();
    _watch();
  }

  void _watch() {
    setState(() {
      _error = null;
      _jobs = null;
    });
    _roster?.cancel();
    _roster = widget.link.watchJobs(widget.sessionId).listen(
      (jobs) {
        if (!mounted) return;
        setState(() {
          _jobs = jobs;
          _error = null;
        });
      },
      onError: (Object error) {
        if (!mounted) return;
        setState(() => _error = error);
      },
    );
  }

  Future<void> _kill(JobSummary job) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('终止这个任务？'),
        content: Text(job.label, maxLines: 4, overflow: TextOverflow.ellipsis),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('终止'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    try {
      final outcome = await widget.link.killJob(widget.sessionId, job.id);
      if (!mounted) return;
      if (outcome == 'already-finished') {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('这个任务已经结束了。')),
        );
      }
    } on Object catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('终止失败：$error')),
      );
    }
  }

  void _openOutput(JobSummary job) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (context) => JobOutputPage(
          link: widget.link,
          sessionId: widget.sessionId,
          job: job,
        ),
      ),
    );
  }

  @override
  void dispose() {
    _roster?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final jobs = _jobs;
    return Scaffold(
      appBar: AppBar(
        title: const Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('后台任务'),
            Text('电脑上为这个会话跑的命令', style: TextStyle(fontSize: 12)),
          ],
        ),
        actions: [
          IconButton(
            onPressed: _watch,
            icon: const Icon(Icons.refresh),
            tooltip: '刷新',
          ),
        ],
      ),
      body: _body(jobs),
    );
  }

  Widget _body(List<JobSummary>? jobs) {
    if (_error != null && jobs == null) {
      return _Problem(error: _error!, onRetry: _watch);
    }
    if (jobs == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (jobs.isEmpty) {
      return const _EmptyJobs();
    }
    final sorted = [...jobs]..sort((left, right) {
      if (left.isLive != right.isLive) return left.isLive ? -1 : 1;
      final leftAt = left.startedAt;
      final rightAt = right.startedAt;
      // A job without a start time cannot be placed, so it sinks to the end
      // instead of comparing equal — returning 0 for "unknown vs known" is not
      // a valid ordering and makes the result depend on input order.
      if (leftAt == null && rightAt == null) return 0;
      if (leftAt == null) return 1;
      if (rightAt == null) return -1;
      return rightAt.compareTo(leftAt);
    });
    return ListView.separated(
      itemCount: sorted.length,
      separatorBuilder: (context, index) => const Divider(height: 1),
      itemBuilder: (context, index) {
        final job = sorted[index];
        return _JobTile(
          job: job,
          onOpen: () => _openOutput(job),
          onKill: job.isLive ? () => _kill(job) : null,
        );
      },
    );
  }
}

class _JobTile extends StatelessWidget {
  const _JobTile({required this.job, required this.onOpen, this.onKill});

  final JobSummary job;
  final VoidCallback onOpen;
  final VoidCallback? onKill;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final live = job.isLive;
    return ListTile(
      onTap: onOpen,
      leading: live
          ? const SizedBox(
              width: 20,
              height: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : Icon(
              job.status == 'failed' ? Icons.error_outline : Icons.check_circle_outline,
              color: job.status == 'failed' ? theme.colorScheme.error : theme.colorScheme.outline,
            ),
      title: Text(
        _firstLine(job.label),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: theme.textTheme.bodyMedium,
      ),
      subtitle: Text(
        [
          job.statusLabel,
          if (job.progress != null) job.progress!,
          if (job.detail != null) job.detail!,
        ].join(' · '),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.outline),
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (onKill != null)
            IconButton(
              onPressed: onKill,
              icon: const Icon(Icons.stop_circle_outlined),
              tooltip: '终止任务',
            ),
          const Icon(Icons.chevron_right),
        ],
      ),
    );
  }
}

/// One job's output, appended as the Host streams it.
class JobOutputPage extends StatefulWidget {
  const JobOutputPage({
    super.key,
    required this.link,
    required this.sessionId,
    required this.job,
  });

  final HostLink link;
  final String sessionId;
  final JobSummary job;

  @override
  State<JobOutputPage> createState() => _JobOutputPageState();
}

class _JobOutputPageState extends State<JobOutputPage> {
  final StringBuffer _output = StringBuffer();
  JobSummary? _job;
  Object? _error;
  bool _done = false;
  StreamSubscription<JobOutputFrame>? _stream;
  final ScrollController _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    _job = widget.job;
    _follow();
  }

  void _follow() {
    _stream?.cancel();
    _resetOutput();
    _stream = widget.link
        .followJob(widget.job.id, sessionId: widget.sessionId)
        .listen(
          (frame) {
            if (!mounted) return;
            setState(() {
              if (frame.job != null) _job = frame.job;
              if (frame.text.isNotEmpty) _output.write(frame.text);
              if (frame.kind == 'status') _done = true;
            });
            _scrollToEnd();
          },
          onError: (Object error) {
            if (!mounted) return;
            setState(() => _error = error);
          },
          onDone: () {
            if (!mounted) return;
            setState(() => _done = true);
          },
        );
  }

  /// Drops everything the previous attempt accumulated.
  ///
  /// Retrying re-reads the job from the Host, so keeping the old text would
  /// render the same lines twice, and keeping `_error` would leave the error
  /// branch in charge no matter what the new stream says.
  void _resetOutput() {
    _error = null;
    _done = false;
    _output.clear();
  }

  void _retry() {
    setState(_resetOutput);
    _follow();
  }

  void _scrollToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      _scroll.jumpTo(_scroll.position.maxScrollExtent);
    });
  }

  @override
  void dispose() {
    _stream?.cancel();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final job = _job;
    final text = _output.toString();
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              job == null ? '任务输出' : _firstLine(job.label),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            Text(
              job == null ? '' : '${job.statusLabel}${_done ? '' : ' · 跟随中'}',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.outline,
              ),
            ),
          ],
        ),
      ),
      body: _error != null
          ? _Problem(error: _error!, onRetry: _retry)
          : text.isEmpty
            ? Center(
                child: Text(
                  _done ? '这个任务没有输出。' : '等待输出…',
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: theme.colorScheme.outline,
                  ),
                ),
              )
            : Scrollbar(
                controller: _scroll,
                child: SingleChildScrollView(
                  controller: _scroll,
                  padding: const EdgeInsets.all(16),
                  child: SelectableText(
                    text,
                    style: theme.textTheme.bodySmall?.copyWith(
                      fontFamily: 'monospace',
                    ),
                  ),
                ),
              ),
    );
  }
}

class _EmptyJobs extends StatelessWidget {
  const _EmptyJobs();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.task_alt, size: 48, color: theme.colorScheme.outline),
            const SizedBox(height: 12),
            Text('没有后台任务', style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            Text(
              '电脑上的智能体跑长命令时，任务会出现在这里。',
              textAlign: TextAlign.center,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.outline,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Problem extends StatelessWidget {
  const _Problem({required this.error, required this.onRetry});

  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.cloud_off, size: 40, color: theme.colorScheme.error),
            const SizedBox(height: 12),
            Text('读不到任务列表', style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            Text(
              '$error',
              textAlign: TextAlign.center,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.outline,
              ),
            ),
            const SizedBox(height: 16),
            FilledButton.tonal(onPressed: onRetry, child: const Text('重试')),
          ],
        ),
      ),
    );
  }
}

String _firstLine(String value) {
  final trimmed = value.trim();
  final index = trimmed.indexOf('\n');
  final line = index < 0 ? trimmed : trimmed.substring(0, index);
  return line.length <= 80 ? line : '${line.substring(0, 80)}…';
}
