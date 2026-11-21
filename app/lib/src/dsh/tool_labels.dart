/// Readable names for DSH tool calls.
///
/// The desktop shows a tool call as a verb plus what it acted on — `运行命令 ·
/// Read composer widget` — instead of the raw tool name and a JSON blob. The
/// phone mirrors that so a transcript scanned on a phone reads like the same
/// transcript on the computer.
library;

import 'dart:convert';

/// Verbs keyed by the tool name DSH records in `tool/call`.
const Map<String, String> _verbs = {
  'bash': '运行命令',
  'pwsh': '运行命令',
  'shell': '运行命令',
  'command': '运行命令',
  'exec': '运行命令',
  'terminal': '运行命令',
  'read': '读取',
  'read_file': '读取',
  'write': '写入',
  'write_file': '写入',
  'edit': '编辑',
  'apply_patch': '编辑',
  'patch': '编辑',
  'grep': '搜索',
  'search': '搜索',
  'glob': '查找文件',
  'list': '列出目录',
  'ls': '列出目录',
  'webfetch': '抓取网页',
  'web_fetch': '抓取网页',
  'websearch': '搜索网页',
  'web_search': '搜索网页',
  'task': '子任务',
  'todo_write': '更新待办',
  'todo': '更新待办',
  'skill': '加载技能',
  'ask_user_question': '询问用户',
  'canvas': '画布',
  'office_render': '渲染文档',
  'office_convert': '转换文档',
  'office_recalculate': '重算表格',
};

/// Argument keys that name what a call acted on, in the order worth trying.
///
/// `pattern` sits before `path` on purpose: a search is remembered by what it
/// looked for, not by the directory it looked in.
const List<String> _subjectKeys = [
  'command',
  'cmd',
  'file_path',
  'filePath',
  'pattern',
  'query',
  'path',
  'url',
  'name',
  'prompt',
  'description',
];

/// The verb to show for a tool call, falling back to the tool name.
String toolVerb(String name) {
  final trimmed = name.trim();
  if (trimmed.isEmpty) return '工具';
  final direct = _verbs[trimmed.toLowerCase()];
  if (direct != null) return direct;
  // MCP tools are `server__tool`; the tool half is the useful part.
  final tail = trimmed.contains('__') ? trimmed.split('__').last : trimmed;
  final known = _verbs[tail.toLowerCase()];
  if (known != null) return known;
  return tail.replaceAll('_', ' ');
}

/// What a tool call acted on: a command line, a path, a pattern, or a prompt.
///
/// Returns an empty string when the arguments carry nothing that reads as a
/// subject, which is the honest answer for a call whose meaning is its JSON.
String toolSubject(String arguments) {
  final decoded = _decodeObject(arguments);
  if (decoded == null) return collapse(arguments);
  for (final key in _subjectKeys) {
    final value = decoded[key];
    if (value is String && value.trim().isNotEmpty) return collapse(value);
    if (value is List && value.isNotEmpty && value.first is String) {
      return collapse('${value.first}');
    }
  }
  return '';
}

/// One line of at most [limit] characters, with whitespace flattened.
String collapse(String value, {int limit = 120}) {
  final flat = value.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (flat.length <= limit) return flat;
  return '${flat.substring(0, limit)}…';
}

/// The first non-empty line of a block of text, flattened — the one-liner the
/// desktop uses as a preview above a collapsed thinking block.
String firstLine(String value, {int limit = 80}) => collapse(value, limit: limit);

/// A count that reads well next to a collapsed tool result.
String summarizeBody(String value) {
  final flat = value.trim();
  if (flat.isEmpty) return '';
  final lines = '\n'.allMatches(flat).length + 1;
  if (lines <= 1) return collapse(flat, limit: 60);
  return '${collapse(flat, limit: 60)} · $lines 行';
}

/// Pretty-prints a JSON argument blob, leaving anything unparsable as-is.
String prettyJson(String value) {
  final text = value.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return text;
  try {
    return const JsonEncoder.withIndent('  ').convert(jsonDecode(text));
  } on Object {
    return text;
  }
}

Map<String, Object?>? _decodeObject(String arguments) {
  final text = arguments.trim();
  if (!text.startsWith('{')) return null;
  try {
    final value = jsonDecode(text);
    return value is Map<String, Object?> ? value : null;
  } on Object {
    return null;
  }
}
