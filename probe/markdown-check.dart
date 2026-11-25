// Checks the markdown parser against the shapes a DSH reply actually takes.
//
// Run from the repo root:
//   dart run --packages=app/.dart_tool/package_config.json probe/markdown-check.dart
//
// The point of a separate script (rather than only widget tests) is speed: this
// runs without a Flutter binding, so a parser change can be checked in a second.

import 'package:pocket_harness/src/dsh/markdown.dart';

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

void main() {
  check('a plain paragraph is one block', () {
    final blocks = parseMarkdown('hello there');
    equal(blocks.length, 1);
    final block = blocks.single as MdParagraph;
    equal(inlineToPlainText(block.spans), 'hello there');
  });

  check('headings keep their level', () {
    final blocks = parseMarkdown('# one\n\n### three');
    equal(blocks.length, 2);
    equal((blocks[0] as MdHeading).level, 1);
    equal((blocks[1] as MdHeading).level, 3);
    equal(inlineToPlainText((blocks[1] as MdHeading).spans), 'three');
  });

  check('a closed fence keeps its language and body', () {
    final blocks = parseMarkdown('```dart\nvoid main() {}\n```');
    final code = blocks.single as MdCodeBlock;
    equal(code.language, 'dart');
    equal(code.code, 'void main() {}');
    equal(code.closed, true);
  });

  check('an open fence is still a code block while streaming', () {
    final blocks = parseMarkdown('```python\nprint(1)');
    final code = blocks.single as MdCodeBlock;
    equal(code.language, 'python');
    equal(code.code, 'print(1)');
    equal(code.closed, false);
  });

  check('an empty open fence renders as an empty block', () {
    final blocks = parseMarkdown('```');
    final code = blocks.single as MdCodeBlock;
    equal(code.code, '');
    equal(code.closed, false);
    equal(code.language, null);
  });

  check('bullets become one list', () {
    final blocks = parseMarkdown('- one\n- two\n- three');
    final list = blocks.single as MdListBlock;
    equal(list.ordered, false);
    equal(list.items.length, 3);
    equal(inlineToPlainText(list.items[1].spans), 'two');
  });

  check('an indented bullet is a second level', () {
    final blocks = parseMarkdown('- one\n  - nested\n- two');
    final list = blocks.single as MdListBlock;
    equal(list.items.length, 3);
    equal(list.items[0].depth, 0);
    equal(list.items[1].depth, 1);
    equal(list.items[2].depth, 0);
  });

  check('ordered list keeps its starting number', () {
    final blocks = parseMarkdown('3. three\n4. four');
    final list = blocks.single as MdListBlock;
    equal(list.ordered, true);
    equal(list.items[0].number, 3);
    equal(list.items[1].number, 4);
  });

  check('a quote keeps its paragraphs', () {
    final blocks = parseMarkdown('> first\n>\n> second');
    final quote = blocks.single as MdQuote;
    equal(quote.paragraphs.length, 2);
    equal(inlineToPlainText(quote.paragraphs[0]), 'first');
    equal(inlineToPlainText(quote.paragraphs[1]), 'second');
  });

  check('a table has header, rows and alignment', () {
    final blocks = parseMarkdown('| a | b |\n| --- | ---: |\n| 1 | 2 |');
    final table = blocks.single as MdTable;
    equal(table.header.length, 2);
    equal(table.rows.length, 1);
    equal(table.aligns[0], -1);
    equal(table.aligns[1], 1);
    equal(inlineToPlainText(table.header[0]), 'a');
    equal(inlineToPlainText(table.rows[0][1]), '2');
  });

  check('a rule is a divider, not a list', () {
    final blocks = parseMarkdown('---');
    equal(blocks.single is MdDivider, true);
  });

  check('strong, emphasis and code spans split out', () {
    final spans = parseInline('a **b** c *d* e `f` g');
    equal(spans.length, 7);
    equal(spans[1] is MdStrong, true);
    equal(spans[3] is MdEm, true);
    equal(spans[5] is MdCodeSpan, true);
    equal((spans[5] as MdCodeSpan).text, 'f');
  });

  check('bold inside bold-ish runs does not mis-close', () {
    final spans = parseInline('**bold** then **again**');
    final strongs = spans.whereType<MdStrong>().toList();
    equal(strongs.length, 2);
    equal(inlineToPlainText(strongs[0].children), 'bold');
    equal(inlineToPlainText(strongs[1].children), 'again');
  });

  check('snake_case words are not emphasis', () {
    final spans = parseInline('call my_func_name here');
    equal(spans.whereType<MdEm>().length, 0);
    equal(inlineToPlainText(spans), 'call my_func_name here');
  });

  check('a link keeps its label and url', () {
    final spans = parseInline('see [the docs](https://example.com/x) now');
    final link = spans.whereType<MdLink>().single;
    equal(link.label, 'the docs');
    equal(link.url, 'https://example.com/x');
  });

  check('an unterminated marker stays literal', () {
    final spans = parseInline('a **b');
    equal(linkText(spans), 'a **b');
  });

  check('a backslash escapes the next character', () {
    final spans = parseInline(r'not \* emphasis');
    equal(linkText(spans), 'not * emphasis');
    equal(spans.whereType<MdEm>().length, 0);
  });

  check('an inline code span keeps its text verbatim', () {
    final spans = parseInline(r'use `a**b**c` here');
    final code = spans.whereType<MdCodeSpan>().single;
    equal(code.text, 'a**b**c');
  });

  check('a paragraph interrupted by a list resumes after it', () {
    final blocks = parseMarkdown('before\n- one\n- two\nafter');
    equal(blocks.length, 3);
    equal(blocks[0] is MdParagraph, true);
    equal(blocks[1] is MdListBlock, true);
    equal(blocks[2] is MdParagraph, true);
  });

  check('windows line endings parse the same as unix', () {
    final blocks = parseMarkdown('a\r\n\r\nb');
    equal(blocks.length, 2);
  });

  check('empty input yields nothing', () {
    equal(parseMarkdown('').length, 0);
    equal(parseMarkdown('   \n\n  ').length, 0);
  });

  check('indented code inside a list is not swallowed by the list', () {
    final blocks = parseMarkdown('- item\n\n```js\nlet a = 1;\n```');
    equal(blocks.length, 2);
    equal(blocks[0] is MdListBlock, true);
    equal(blocks[1] is MdCodeBlock, true);
  });

  check('a table with escaped pipes keeps them inside the cell', () {
    final rows = splitTableRow(r'| a \| b | c |');
    equal(rows.length, 2);
    equal(rows[0].trim(), 'a | b');
  });

  check('a realistic reply parses into the expected block order', () {
    const reply = '''
## Summary

The build **failed** because the lock file was stale.

- delete `pubspec.lock`
- run `flutter pub get`

```bash
flutter pub get
```

| step | result |
| --- | --- |
| 1 | ok |

> note: rerun the tests.
''';
    final blocks = parseMarkdown(reply);
    final kinds = blocks.map((block) => block.runtimeType.toString()).toList();
    equal(
      kinds.join(','),
      'MdHeading,MdParagraph,MdListBlock,MdCodeBlock,MdTable,MdQuote',
    );
  });

  print('');
  if (failures == 0) {
    print('ALL MARKDOWN CHECKS PASS ($checks checks)');
  } else {
    print('$failures of $checks checks FAILED');
  }
}

/// Flattens spans without depending on the renderer.
String linkText(List<MdInline> spans) => inlineToPlainText(spans);
