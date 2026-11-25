/// Syntax colouring for fenced code blocks, done without a dependency.
///
/// The obvious package (`highlight`) pins `sdk: ">=2.12.0 <3.0.0"`, which no
/// Dart 3 toolchain will resolve, and its 1.5 MB of language tables would be
/// mostly dead weight: a chat reply contains shell commands, a patch, some
/// Dart/JS/Python, JSON/YAML and SQL. So this is a small hand-written scanner
/// over the same handful of languages.
///
/// It is a tokenizer, not a parser. It recognises comments, strings, numbers
/// and keywords — the four things that make code readable at a glance on a
/// phone — and leaves everything else in the plain colour. Being wrong about
/// the odd token costs a colour, not correctness: the text a user copies is
/// the original string, never a rebuilt one.
library;

/// What a run of code is, for colouring purposes.
enum CodeKind {
  plain,
  keyword,
  string,
  comment,
  number,
  type,
  literal,
  added,
  removed,
  meta,
}

/// One coloured run. `text` is always a slice of the input, in order, so the
/// concatenation of every span equals the original source.
class CodeSpan {
  const CodeSpan(this.text, this.kind);

  final String text;
  final CodeKind kind;

  @override
  String toString() => '${kind.name}(${text.replaceAll('\n', r'\n')})';
}

class _Rules {
  const _Rules({
    this.lineComments = const [],
    this.blockComment,
    this.strings = const [],
    this.keywords = const {},
    this.types = const {},
    this.literals = const {},
    this.caseInsensitive = false,
  });

  final List<String> lineComments;
  final (String, String)? blockComment;
  final bool caseInsensitive;

  /// Opening and closing quotes; a triple-quoted entry spans lines.
  final List<(String, String)> strings;
  final Set<String> keywords;
  final Set<String> types;
  final Set<String> literals;
}

const _cLikeKeywords = {
  'abstract', 'as', 'assert', 'async', 'await', 'break', 'case', 'catch',
  'class', 'const', 'continue', 'default', 'defer', 'do', 'else', 'enum',
  'export', 'extends', 'external', 'factory', 'final', 'finally', 'for',
  'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'interface',
  'is', 'late', 'let', 'library', 'mixin', 'new', 'of', 'on', 'operator',
  'override', 'part', 'required', 'return', 'set', 'static', 'super',
  'switch', 'sync', 'this', 'throw', 'try', 'typedef', 'var', 'void', 'while',
  'with', 'yield',
};

const _rules = <String, _Rules>{
  'dart': _Rules(
    lineComments: ['//'],
    blockComment: ('/*', '*/'),
    strings: [("'''", "'''"), ('"""', '"""'), ("'", "'"), ('"', '"')],
    keywords: {
      ..._cLikeKeywords,
      'covariant', 'extension', 'sealed', 'base', 'when',
    },
    types: {'int', 'double', 'num', 'String', 'bool', 'List', 'Map', 'Set', 'Future', 'Stream', 'Object', 'dynamic'},
    literals: {'true', 'false', 'null'},
  ),
  'javascript': _Rules(
    lineComments: ['//'],
    blockComment: ('/*', '*/'),
    strings: [('`', '`'), ("'", "'"), ('"', '"')],
    keywords: {
      ..._cLikeKeywords,
      'debugger', 'delete', 'instanceof', 'typeof',
    },
    literals: {'true', 'false', 'null', 'undefined'},
  ),
  'typescript': _Rules(
    lineComments: ['//'],
    blockComment: ('/*', '*/'),
    strings: [('`', '`'), ("'", "'"), ('"', '"')],
    keywords: {
      ..._cLikeKeywords,
      'declare', 'keyof', 'namespace', 'readonly', 'satisfies', 'type', 'unknown',
    },
    types: {'any', 'boolean', 'never', 'number', 'string', 'void', 'unknown'},
    literals: {'true', 'false', 'null', 'undefined'},
  ),
  'python': _Rules(
    lineComments: ['#'],
    strings: [('"""', '"""'), ("'''", "'''"), ('"', '"'), ("'", "'")],
    keywords: {
      'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
      'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from',
      'global', 'if', 'import', 'in', 'is', 'lambda', 'match', 'case',
      'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while',
      'with', 'yield',
    },
    types: {'int', 'float', 'str', 'bool', 'list', 'dict', 'set', 'tuple', 'bytes'},
    literals: {'True', 'False', 'None'},
  ),
  'bash': _Rules(
    lineComments: ['#'],
    strings: [('"', '"'), ("'", "'")],
    keywords: {
      'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while',
      'case', 'esac', 'function', 'return', 'export', 'local', 'source',
      'set', 'unset', 'test', 'cd', 'echo', 'printf', 'read', 'shift',
      'exit', 'trap', 'wait', 'eval', 'exec', 'ulimit', 'umask',
    },
    literals: {'true', 'false'},
  ),
  'json': _Rules(
    strings: [('"', '"')],
    literals: {'true', 'false', 'null'},
  ),
  'yaml': _Rules(
    // No `lineComments` here on purpose. In YAML a `#` only starts a comment at
    // the start of a line or after whitespace, so `sha256#1` is one scalar, not
    // a value followed by a comment. Listing '#' as a line comment would make
    // the scanner jump on it before any contextual check could run — which is
    // exactly what the special case below cannot undo, since it would never be
    // reached.
    strings: [('"', '"'), ("'", "'")],
    literals: {'true', 'false', 'null', 'yes', 'no', 'on', 'off'},
  ),
  'sql': _Rules(
    lineComments: ['--'],
    blockComment: ('/*', '*/'),
    strings: [("'", "'"), ('"', '"')],
    keywords: {
      'add', 'all', 'alter', 'and', 'as', 'asc', 'begin', 'between', 'by',
      'case', 'column', 'commit', 'create', 'delete', 'desc', 'distinct',
      'drop', 'else', 'end', 'exists', 'from', 'group', 'having', 'if', 'in',
      'index', 'insert', 'into', 'is', 'join', 'left', 'like', 'limit',
      'not', 'null', 'offset', 'on', 'or', 'order', 'outer', 'primary',
      'references', 'right', 'rollback', 'select', 'set', 'table', 'then',
      'union', 'unique', 'update', 'values', 'view', 'when', 'where',
    },
    literals: {'NULL', 'TRUE', 'FALSE'},
    caseInsensitive: true,
  ),
  'css': _Rules(
    blockComment: ('/*', '*/'),
    strings: [('"', '"'), ("'", "'")],
    keywords: {'important', 'media', 'supports', 'keyframes', 'import'},
  ),
  'html': _Rules(
    blockComment: ('<!--', '-->'),
    strings: [('"', '"'), ("'", "'")],
  ),
  'xml': _Rules(
    blockComment: ('<!--', '-->'),
    strings: [('"', '"'), ("'", "'")],
  ),
  'rust': _Rules(
    lineComments: ['//'],
    blockComment: ('/*', '*/'),
    strings: [('"', '"'), ("'", "'")],
    keywords: {
      'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn',
      'else', 'enum', 'extern', 'fn', 'for', 'if', 'impl', 'in', 'let',
      'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self',
      'static', 'struct', 'super', 'trait', 'type', 'unsafe', 'use', 'where',
      'while',
    },
    types: {'bool', 'char', 'f32', 'f64', 'i32', 'i64', 'str', 'u8', 'u32', 'usize'},
    literals: {'true', 'false', 'None', 'Some', 'Ok', 'Err'},
  ),
  'go': _Rules(
    lineComments: ['//'],
    blockComment: ('/*', '*/'),
    strings: [('`', '`'), ('"', '"'), ("'", "'")],
    keywords: {
      'break', 'case', 'chan', 'const', 'continue', 'default', 'defer',
      'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import',
      'interface', 'map', 'package', 'range', 'return', 'select', 'struct',
      'switch', 'type', 'var',
    },
    types: {'bool', 'byte', 'error', 'float64', 'int', 'int64', 'rune', 'string'},
    literals: {'true', 'false', 'nil'},
  ),
  'java': _Rules(
    lineComments: ['//'],
    blockComment: ('/*', '*/'),
    strings: [('"""', '"""'), ('"', '"'), ("'", "'")],
    keywords: _cLikeKeywords,
    types: {'boolean', 'byte', 'char', 'double', 'float', 'int', 'long', 'short', 'String'},
    literals: {'true', 'false', 'null'},
  ),
  'kotlin': _Rules(
    lineComments: ['//'],
    blockComment: ('/*', '*/'),
    strings: [('"""', '"""'), ('"', '"'), ("'", "'")],
    keywords: _cLikeKeywords,
    types: {'Boolean', 'Byte', 'Char', 'Double', 'Float', 'Int', 'Long', 'Short', 'String', 'Unit'},
    literals: {'true', 'false', 'null'},
  ),
  'c': _Rules(
    lineComments: ['//'],
    blockComment: ('/*', '*/'),
    strings: [('"', '"'), ("'", "'")],
    keywords: {
      ..._cLikeKeywords,
      'sizeof', 'struct', 'union', 'volatile', 'register', 'goto', 'extern', 'auto',
    },
    types: {'char', 'double', 'float', 'int', 'long', 'short', 'signed', 'unsigned', 'void', 'size_t'},
    literals: {'NULL', 'true', 'false'},
  ),
  'powershell': _Rules(
    lineComments: ['#'],
    blockComment: ('<#', '#>'),
    strings: [('"', '"'), ("'", "'")],
    keywords: {
      'begin', 'break', 'catch', 'class', 'continue', 'data', 'do', 'else',
      'elseif', 'end', 'enum', 'exit', 'filter', 'finally', 'for', 'foreach',
      'function', 'if', 'in', 'param', 'process', 'return', 'switch', 'throw',
      'trap', 'try', 'until', 'using', 'while',
    },
    literals: {r'$true', r'$false', r'$null'},
  ),
  'ini': _Rules(
    lineComments: [';', '#'],
    strings: [('"', '"'), ("'", "'")],
    literals: {'true', 'false', 'yes', 'no'},
  ),
  'diff': _Rules(),
  'patch': _Rules(),
};

/// Language names people write in fences, mapped to the tables above.
const _aliases = <String, String>{
  'js': 'javascript',
  'jsx': 'javascript',
  'mjs': 'javascript',
  'cjs': 'javascript',
  'node': 'javascript',
  'ts': 'typescript',
  'tsx': 'typescript',
  'py': 'python',
  'python3': 'python',
  'sh': 'bash',
  'shell': 'bash',
  'zsh': 'bash',
  'console': 'bash',
  'pwsh': 'powershell',
  'ps1': 'powershell',
  'ps': 'powershell',
  'yml': 'yaml',
  'rs': 'rust',
  'golang': 'go',
  'kt': 'kotlin',
  'ktx': 'kotlin',
  'c++': 'c',
  'cpp': 'c',
  'h': 'c',
  'hpp': 'c',
  'cs': 'java',
  'csharp': 'java',
  'jsonc': 'json',
  'json5': 'json',
  'htm': 'html',
  'xhtml': 'xml',
  'svg': 'xml',
  'properties': 'ini',
  'toml': 'ini',
  'dockerfile': 'ini',
  'makefile': 'ini',
  'markdown': 'plain',
  'md': 'plain',
  'text': 'plain',
  'txt': 'plain',
  'plain': 'plain',
  '': 'plain',
};

/// The canonical name for a fence tag, or null when the block is not code we
/// know how to colour (the caller should render it plainly).
String? languageFor(String? tag) {
  if (tag == null) return null;
  final lower = tag.trim().toLowerCase();
  if (lower.isEmpty) return null;
  final name = _aliases[lower] ?? lower;
  if (name == 'plain') return null;
  return _rules.containsKey(name) ? name : null;
}

final _number = RegExp(r'0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?');
final _word = RegExp(r'[A-Za-z_$][A-Za-z0-9_$]*');

/// Splits [code] into coloured runs. Concatenating the results gives [code]
/// back exactly.
List<CodeSpan> highlightCode(String code, String? language) {
  final name = languageFor(language);
  if (code.isEmpty) return const [CodeSpan('', CodeKind.plain)];
  if (name == null) return [CodeSpan(code, CodeKind.plain)];

  if (name == 'diff' || name == 'patch') return _highlightDiff(code);

  final rules = _rules[name]!;
  final spans = <CodeSpan>[];
  final plain = StringBuffer();

  void flush() {
    if (plain.isEmpty) return;
    spans.add(CodeSpan(plain.toString(), CodeKind.plain));
    plain.clear();
  }

  void emit(String text, CodeKind kind) {
    flush();
    spans.add(CodeSpan(text, kind));
  }

  var i = 0;
  while (i < code.length) {
    // Checks run against `code` at an offset, not against `code.substring(i)`:
    // the substring costs a copy, and doing it once per character made an
    // 800-line block take 100 ms — the whole budget for one frame of a
    // streaming reply — for a token scan that is otherwise linear.
    final lineComment = rules.lineComments.firstWhere(
      (marker) => code.startsWith(marker, i),
      orElse: () => '',
    );
    if (lineComment.isNotEmpty) {
      final end = code.indexOf('\n', i);
      final stop = end < 0 ? code.length : end;
      emit(code.substring(i, stop), CodeKind.comment);
      i = stop;
      continue;
    }

    final block = rules.blockComment;
    if (block != null && code.startsWith(block.$1, i)) {
      final close = code.indexOf(block.$2, i + block.$1.length);
      final stop = close < 0 ? code.length : close + block.$2.length;
      emit(code.substring(i, stop), CodeKind.comment);
      i = stop;
      continue;
    }

    var opened = false;
    for (final quote in rules.strings) {
      if (!code.startsWith(quote.$1, i)) continue;
      final end = code.indexOf(quote.$2, i + quote.$1.length);
      final stop = end < 0 ? code.length : end + quote.$2.length;
      emit(code.substring(i, stop), CodeKind.string);
      i = stop;
      opened = true;
      break;
    }
    if (opened) continue;

    final char = code[i];
    if (char == '#' && name == 'yaml') {
      // A YAML comment only starts at the beginning of a line or after space;
      // `sha256#1` is not a comment. This is why yaml has no `lineComments`.
      final before = i == 0 ? ' ' : code[i - 1];
      if (before == ' ' || before == '\n') {
        final end = code.indexOf('\n', i);
        final stop = end < 0 ? code.length : end;
        emit(code.substring(i, stop), CodeKind.comment);
        i = stop;
        continue;
      }
    }

    final number = _number.matchAsPrefix(code, i);
    if (number != null && (i == 0 || !_isWordChar(code[i - 1])) && char != '_') {
      emit(number.group(0)!, CodeKind.number);
      i = number.end;
      continue;
    }

    final word = _word.matchAsPrefix(code, i);
    if (word != null) {
      final text = word.group(0)!;
      // SQL writes keywords in either case; every other table is cased.
      bool has(Set<String> table) {
        if (table.contains(text)) return true;
        if (!rules.caseInsensitive) return false;
        return table.contains(text.toUpperCase()) || table.contains(text.toLowerCase());
      }

      if (has(rules.keywords)) {
        emit(text, CodeKind.keyword);
      } else if (has(rules.types)) {
        emit(text, CodeKind.type);
      } else if (has(rules.literals)) {
        emit(text, CodeKind.literal);
      } else {
        plain.write(text);
      }
      i = word.end;
      continue;
    }

    plain.write(char);
    i += 1;
  }

  flush();
  return spans;
}

List<CodeSpan> _highlightDiff(String code) {
  final spans = <CodeSpan>[];
  for (final line in code.split('\n')) {
    final kind = line.startsWith('+++') || line.startsWith('---')
        ? CodeKind.meta
        : line.startsWith('+')
            ? CodeKind.added
            : line.startsWith('-')
                ? CodeKind.removed
                : line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('index ')
                    ? CodeKind.meta
                    : CodeKind.plain;
    spans.add(CodeSpan('$line\n', kind));
  }
  // The split added one trailing newline beyond the input's own newlines.
  if (spans.isNotEmpty) {
    final last = spans.removeLast();
    final text = last.text.endsWith('\n') ? last.text.substring(0, last.text.length - 1) : last.text;
    spans.add(CodeSpan(text, last.kind));
  }
  return spans;
}

bool _isWordChar(String char) =>
    RegExp(r'[A-Za-z0-9_$]').hasMatch(char);
