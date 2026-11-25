// Checks the code colouriser: it must never lose or reorder a character, and
// it must tag the four things that make code readable (comments, strings,
// numbers, keywords).
//
//   dart run --packages=app/.dart_tool/package_config.json probe/highlight-check.dart

import 'package:pocket_harness/src/dsh/code_highlight.dart';

var failures = 0;
var checks = 0;

void check(String name, void Function() body) {
  checks += 1;
  try {
    body();
    print('ok   $name');
  } catch (error) {
    failures += 1;
    print('FAIL $name');
    print('     $error');
  }
}

void equal(Object? actual, Object? expected, [String where = '']) {
  final a = actual.toString();
  final b = expected.toString();
  if (a != b) throw StateError('$where expected <$b> got <$a>');
}

String rebuild(List<CodeSpan> spans) => spans.map((span) => span.text).join();

Set<String> kindsOf(List<CodeSpan> spans, CodeKind kind) =>
    spans.where((span) => span.kind == kind).map((span) => span.text).toSet();

void main() {
  check('a fence tag maps to a table', () {
    equal(languageFor('dart'), 'dart');
    equal(languageFor('JS'), 'javascript');
    equal(languageFor('ts'), 'typescript');
    equal(languageFor('sh'), 'bash');
    equal(languageFor('yml'), 'yaml');
  });

  check('unknown or missing tags are not coloured', () {
    equal(languageFor('brainfuck2'), null);
    equal(languageFor(null), null);
    equal(languageFor(''), null);
    equal(languageFor('text'), null);
  });

  check('dart: keywords, strings, comments, numbers', () {
    const code = 'final a = 42; // note\nvoid main() { print("hi"); }';
    final spans = highlightCode(code, 'dart');
    equal(rebuild(spans), code);
    equal(kindsOf(spans, CodeKind.keyword).contains('final'), true);
    equal(kindsOf(spans, CodeKind.keyword).contains('void'), true);
    equal(kindsOf(spans, CodeKind.number).contains('42'), true);
    equal(kindsOf(spans, CodeKind.string).contains('"hi"'), true);
    equal(kindsOf(spans, CodeKind.comment).contains('// note'), true);
  });

  check('python: hash comments and triple-quoted strings', () {
    const code = 'def f():  # go\n    return """a\nb"""\n';
    final spans = highlightCode(code, 'python');
    equal(rebuild(spans), code);
    equal(kindsOf(spans, CodeKind.keyword).contains('def'), true);
    equal(kindsOf(spans, CodeKind.comment).contains('# go'), true);
    equal(kindsOf(spans, CodeKind.string).contains('"""a\nb"""'), true);
  });

  check('bash: shebang line is a comment', () {
    const code = '#!/usr/bin/env bash\nset -e\nnpm run build\n';
    final spans = highlightCode(code, 'bash');
    equal(rebuild(spans), code);
    equal(kindsOf(spans, CodeKind.comment).contains('#!/usr/bin/env bash'), true);
    equal(kindsOf(spans, CodeKind.keyword).contains('set'), true);
  });

  check('json: keys are strings and true/null are literals', () {
    const code = '{"a": 1, "b": true, "c": null}';
    final spans = highlightCode(code, 'json');
    equal(rebuild(spans), code);
    equal(kindsOf(spans, CodeKind.string).contains('"a"'), true);
    equal(kindsOf(spans, CodeKind.number).contains('1'), true);
    equal(kindsOf(spans, CodeKind.literal).contains('true'), true);
    equal(kindsOf(spans, CodeKind.literal).contains('null'), true);
  });

  check('yaml: a hash inside a word is not a comment', () {
    // `#` is only a comment at the start of a line or after whitespace. The
    // first version listed '#' as a line comment and tried to enforce that in a
    // later branch, which could never run: the scanner jumped on the '#' before
    // any contextual test. Checking that the whole `sha256#1` is not a comment
    // missed it, because the comment span was `#1`. Assert on the fragments.
    const code = 'key: sha256#1\n# real comment\nlist:\n  - one\n';
    final spans = highlightCode(code, 'yaml');
    equal(rebuild(spans), code);
    final comments = kindsOf(spans, CodeKind.comment);
    equal(comments.any((text) => text.contains('#1')), false);
    equal(comments.contains('# real comment'), true);
  });

  check('sql: keywords are case-insensitive by table, strings keep quotes', () {
    const code = "SELECT * FROM t WHERE a = 'x' -- trailing";
    final spans = highlightCode(code, 'sql');
    equal(rebuild(spans), code);
    equal(kindsOf(spans, CodeKind.keyword).contains('SELECT'), true);
    equal(kindsOf(spans, CodeKind.keyword).contains('WHERE'), true);
    equal(kindsOf(spans, CodeKind.string).contains("'x'"), true);
    equal(kindsOf(spans, CodeKind.comment).contains('-- trailing'), true);
  });

  check('an unterminated string swallows the rest but loses nothing', () {
    const code = 'let s = "unclosed\nmore';
    final spans = highlightCode(code, 'javascript');
    equal(rebuild(spans), code);
    equal(kindsOf(spans, CodeKind.string).contains('"unclosed\nmore'), true);
  });

  check('diff: added, removed and file headers are tagged', () {
    const code = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same\n';
    final spans = highlightCode(code, 'diff');
    equal(rebuild(spans), code);
    equal(kindsOf(spans, CodeKind.added).contains('+new\n'), true);
    equal(kindsOf(spans, CodeKind.removed).contains('-old\n'), true);
    equal(kindsOf(spans, CodeKind.meta).contains('--- a/x\n'), true);
  });

  check('an unknown language yields one plain span', () {
    const code = 'whatever\n';
    final spans = highlightCode(code, 'notalanguage');
    equal(spans.length, 1);
    equal(spans.single.kind, CodeKind.plain);
    equal(spans.single.text, code);
  });

  check('empty code yields one empty span, not nothing', () {
    final spans = highlightCode('', 'dart');
    equal(spans.length, 1);
    equal(spans.single.text, '');
  });

  check('a number glued to a word is not a number', () {
    const code = 'abc123 456';
    final spans = highlightCode(code, 'dart');
    equal(rebuild(spans), code);
    equal(kindsOf(spans, CodeKind.number).contains('456'), true);
    equal(kindsOf(spans, CodeKind.number).contains('123'), false);
  });

  check('a long realistic block rebuilds exactly', () {
    const code = '''
import 'dart:async';

/// Sends it.
class Sender {
  final int retries;
  Sender({this.retries = 3});

  Future<void> send(String body) async {
    for (var i = 0; i < retries; i += 1) {
      try {
        await _post(body);
        return;
      } catch (e) {
        // swallow and retry
      }
    }
    throw StateError('gave up');
  }
}
''';
    final spans = highlightCode(code, 'dart');
    equal(rebuild(spans), code);
    equal(spans.length > 10, true);
  });

  print('');
  if (failures == 0) {
    print('ALL HIGHLIGHT CHECKS PASS ($checks checks)');
  } else {
    print('$failures of $checks checks FAILED');
  }
}
