/// A small CommonMark subset, shaped for what a chat reply actually contains.
///
/// This is deliberately not a complete Markdown parser. It covers headings,
/// paragraphs, ordered and unordered lists (two levels), fenced code, block
/// quotes, tables and horizontal rules, plus inline strong/emphasis/code/link.
/// Anything else falls through as plain text, which is the same thing the
/// desktop does with syntax it does not paint.
///
/// Two behaviours matter more here than spec conformance:
///
/// * A fence that is still open is a code block, not a broken paragraph. Text
///   arrives a few characters at a time, so for a moment between the opening
///   ``` and the closing one every reply *is* an unclosed fence. Treating that
///   as text would make blocks flash between two shapes while they stream.
/// * Parsing is cheap and side-effect free, so the caller may reparse the whole
///   reply on every delta. A reply is a few kilobytes; the alternative, an
///   incremental parser held across frames, buys nothing and can disagree with
///   itself.
library;

/// One block-level element of a message.
sealed class MdBlock {
  const MdBlock();
}

class MdHeading extends MdBlock {
  const MdHeading(this.level, this.spans);

  final int level;
  final List<MdInline> spans;
}

class MdParagraph extends MdBlock {
  const MdParagraph(this.spans);

  final List<MdInline> spans;
}

class MdCodeBlock extends MdBlock {
  const MdCodeBlock({required this.code, this.language, this.closed = true});

  final String code;
  final String? language;

  /// False while the closing fence has not arrived yet — the block is still
  /// being typed into.
  final bool closed;
}

class MdListItem {
  const MdListItem({required this.spans, required this.depth, this.number});

  final List<MdInline> spans;

  /// 0 for a top-level item, 1 for one indented under it.
  final int depth;

  /// The literal number of an ordered item, so a list starting at 3 keeps 3.
  final int? number;
}

class MdListBlock extends MdBlock {
  const MdListBlock({required this.items, required this.ordered});

  final List<MdListItem> items;
  final bool ordered;
}

class MdQuote extends MdBlock {
  const MdQuote(this.paragraphs);

  final List<List<MdInline>> paragraphs;
}

class MdTable extends MdBlock {
  const MdTable({required this.header, required this.rows, required this.aligns});

  final List<List<MdInline>> header;
  final List<List<List<MdInline>>> rows;

  /// One entry per column: -1 left, 0 centre, 1 right.
  final List<int> aligns;
}

class MdDivider extends MdBlock {
  const MdDivider();
}

/// One inline run inside a block.
sealed class MdInline {
  const MdInline();
}

class MdText extends MdInline {
  const MdText(this.text);

  final String text;
}

class MdStrong extends MdInline {
  const MdStrong(this.children);

  final List<MdInline> children;
}

class MdEm extends MdInline {
  const MdEm(this.children);

  final List<MdInline> children;
}

class MdCodeSpan extends MdInline {
  const MdCodeSpan(this.text);

  final String text;
}

class MdLink extends MdInline {
  const MdLink({required this.label, required this.url});

  final String label;
  final String url;
}

/// Parses [text] into blocks. Never throws: malformed input degrades to text.
List<MdBlock> parseMarkdown(String text) {
  final lines = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  final blocks = <MdBlock>[];
  final paragraph = <String>[];

  void flushParagraph() {
    if (paragraph.isEmpty) return;
    blocks.add(MdParagraph(parseInline(paragraph.join('\n').trimRight())));
    paragraph.clear();
  }

  var index = 0;
  while (index < lines.length) {
    final line = lines[index];

    final fence = RegExp(r'^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)').firstMatch(line);
    if (fence != null) {
      flushParagraph();
      final marker = fence.group(2)!;
      final language = fence.group(3) ?? '';
      final body = <String>[];
      var closed = false;
      index += 1;
      while (index < lines.length) {
        final inner = lines[index];
        final closing = RegExp('^\\s{0,3}${RegExp.escape(marker[0])}{${marker.length},}\\s*\$');
        if (closing.hasMatch(inner)) {
          closed = true;
          index += 1;
          break;
        }
        body.add(inner);
        index += 1;
      }
      blocks.add(
        MdCodeBlock(
          code: body.join('\n'),
          language: language.isEmpty ? null : language,
          closed: closed,
        ),
      );
      continue;
    }

    if (line.trim().isEmpty) {
      flushParagraph();
      index += 1;
      continue;
    }

    final heading = RegExp(r'^(#{1,6})\s+(.*)$').firstMatch(line);
    if (heading != null) {
      flushParagraph();
      final level = heading.group(1)!.length;
      final body = heading.group(2)!.replaceFirst(RegExp(r'\s+#+\s*$'), '');
      blocks.add(MdHeading(level, parseInline(body.trim())));
      index += 1;
      continue;
    }

    if (RegExp(r'^\s{0,3}([-*_])\s*(\1\s*){2,}$').hasMatch(line)) {
      flushParagraph();
      blocks.add(const MdDivider());
      index += 1;
      continue;
    }

    if (RegExp(r'^\s{0,3}>').hasMatch(line)) {
      flushParagraph();
      final paragraphs = <List<MdInline>>[];
      final quote = <String>[];
      while (index < lines.length && RegExp(r'^\s{0,3}>').hasMatch(lines[index])) {
        final stripped = lines[index].replaceFirst(RegExp(r'^\s{0,3}>\s?'), '');
        if (stripped.trim().isEmpty) {
          if (quote.isNotEmpty) {
            paragraphs.add(parseInline(quote.join('\n').trim()));
            quote.clear();
          }
        } else {
          quote.add(stripped);
        }
        index += 1;
      }
      if (quote.isNotEmpty) paragraphs.add(parseInline(quote.join('\n').trim()));
      blocks.add(MdQuote(paragraphs));
      continue;
    }

    // A table is only a table when the line after it is the dashed separator.
    if (line.contains('|') && index + 1 < lines.length) {
      final separator = lines[index + 1];
      if (RegExp(r'^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$').hasMatch(separator)) {
        flushParagraph();
        final aligns = <int>[];
        for (final cell in splitTableRow(separator)) {
          final trimmed = cell.trim();
          if (trimmed.startsWith(':') && trimmed.endsWith(':')) {
            aligns.add(0);
          } else if (trimmed.endsWith(':')) {
            aligns.add(1);
          } else {
            aligns.add(-1);
          }
        }
        final header = splitTableRow(line).map((cell) => parseInline(cell.trim())).toList();
        index += 2;
        final rows = <List<List<MdInline>>>[];
        while (index < lines.length && lines[index].contains('|') && lines[index].trim().isNotEmpty) {
          rows.add(splitTableRow(lines[index]).map((cell) => parseInline(cell.trim())).toList());
          index += 1;
        }
        blocks.add(MdTable(header: header, rows: rows, aligns: aligns));
        continue;
      }
    }

    final bullet = RegExp(r'^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$').firstMatch(line);
    if (bullet != null) {
      flushParagraph();
      final itemLine = RegExp(r'^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$');
      final items = <MdListItem>[];
      var ordered = RegExp(r'\d').hasMatch(bullet.group(2)!.substring(0, 1));
      while (index < lines.length) {
        // A blank line between items belongs to the list, not between two
        // lists. Ending the block there restarted the numbering of every
        // ordered list ("1. one / 1. two / 1. three") and put a paragraph gap
        // where the writer had asked for spacing.
        var lookahead = index;
        while (lookahead < lines.length && lines[lookahead].trim().isEmpty) {
          lookahead += 1;
        }
        if (lookahead >= lines.length) break;
        final match = itemLine.firstMatch(lines[lookahead]);
        if (match == null) break;
        final indent = match.group(1)!.replaceAll('\t', '  ').length;
        final marker = match.group(2)!;
        final isOrdered = RegExp(r'\d').hasMatch(marker.substring(0, 1));
        // A list that changes marker style starts a different list.
        if (items.isNotEmpty && isOrdered != ordered) break;
        index = lookahead + 1;
        final number = isOrdered ? int.tryParse(marker.replaceAll(RegExp(r'[.)]'), '')) : null;
        items.add(
          MdListItem(
            spans: parseInline(match.group(3)!.trim()),
            depth: indent >= 2 ? 1 : 0,
            number: number,
          ),
        );
      }
      blocks.add(MdListBlock(items: items, ordered: ordered));
      continue;
    }

    paragraph.add(line);
    index += 1;
  }

  flushParagraph();
  return blocks;
}

/// Splits a table row on unescaped pipes, dropping the optional outer pipes.
List<String> splitTableRow(String line) {
  var body = line.trim();
  if (body.startsWith('|')) body = body.substring(1);
  if (body.endsWith('|')) body = body.substring(0, body.length - 1);
  final cells = <String>[];
  final buffer = StringBuffer();
  for (var i = 0; i < body.length; i += 1) {
    final char = body[i];
    if (char == r'\' && i + 1 < body.length && body[i + 1] == '|') {
      buffer.write('|');
      i += 1;
      continue;
    }
    if (char == '|') {
      cells.add(buffer.toString());
      buffer.clear();
      continue;
    }
    buffer.write(char);
  }
  cells.add(buffer.toString());
  return cells;
}

/// Parses inline runs. Unterminated markers are left as literal text, which is
/// what a reader expects from a half-typed reply.
List<MdInline> parseInline(String text) {
  final spans = <MdInline>[];
  final buffer = StringBuffer();

  void flushText() {
    if (buffer.isEmpty) return;
    spans.add(MdText(buffer.toString()));
    buffer.clear();
  }

  var i = 0;
  while (i < text.length) {
    final char = text[i];

    if (char == r'\' && i + 1 < text.length) {
      buffer.write(text[i + 1]);
      i += 2;
      continue;
    }

    if (char == '`') {
      final ticks = _runLength(text, i, '`');
      final closing = text.indexOf('`' * ticks, i + ticks);
      if (closing > i + ticks) {
        flushText();
        var body = text.substring(i + ticks, closing);
        if (body.length > 2 && body.startsWith(' ') && body.endsWith(' ')) {
          body = body.substring(1, body.length - 1);
        }
        spans.add(MdCodeSpan(body));
        i = closing + ticks;
        continue;
      }
    }

    if (char == '*' || char == '_') {
      final marker = char * _runLength(text, i, char);
      final closing = _findClosing(text, i + marker.length, marker);
      if (closing > 0) {
        final body = text.substring(i + marker.length, closing);
        if (body.isNotEmpty) {
          flushText();
          final children = parseInline(body);
          spans.add(marker.length >= 2 ? MdStrong(children) : MdEm(children));
          i = closing + marker.length;
          continue;
        }
      }
    }

    if (char == '[') {
      final close = _matchingBracket(text, i);
      if (close > 0 && close + 1 < text.length && text[close + 1] == '(') {
        final end = text.indexOf(')', close + 2);
        if (end > 0) {
          final label = text.substring(i + 1, close);
          final url = text.substring(close + 2, end).trim();
          if (url.isNotEmpty) {
            flushText();
            spans.add(MdLink(label: label, url: url));
            i = end + 1;
            continue;
          }
        }
      }
    }

    buffer.write(char);
    i += 1;
  }

  flushText();
  return spans;
}

int _runLength(String text, int start, String char) {
  var length = 0;
  while (start + length < text.length && text[start + length] == char) {
    length += 1;
  }
  return length;
}

/// Finds a closing marker that is not followed by the same character, so `***`
/// does not close on the first `**` of a longer run.
///
/// The "glued to a word" rule applies to `_` only: `my_func_name` must stay
/// literal, while `*d*` is emphasis even though `d` touches both markers.
int _findClosing(String text, int from, String marker) {
  final char = marker[0];
  var i = from;
  while (i < text.length) {
    if (text[i] == char) {
      final run = _runLength(text, i, char);
      if (run >= marker.length) {
        final before = i == 0 ? ' ' : text[i - 1];
        final after = i + run >= text.length ? ' ' : text[i + run];
        if (marker.length == 1 && char == '_' && before != ' ' && after != ' ') {
          i += run;
          continue;
        }
        return i;
      }
      i += run;
      continue;
    }
    i += 1;
  }
  return -1;
}

int _matchingBracket(String text, int start) {
  var depth = 0;
  for (var i = start; i < text.length; i += 1) {
    if (text[i] == r'\') {
      i += 1;
      continue;
    }
    if (text[i] == '[') depth += 1;
    if (text[i] == ']') {
      depth -= 1;
      if (depth == 0) return i;
    }
  }
  return -1;
}

/// The plain text of a span list, for subtitles and accessibility labels.
String inlineToPlainText(List<MdInline> spans) {
  final buffer = StringBuffer();
  for (final span in spans) {
    switch (span) {
      case MdText(:final text):
        buffer.write(text);
      case MdCodeSpan(:final text):
        buffer.write(text);
      case MdStrong(:final children):
        buffer.write(inlineToPlainText(children));
      case MdEm(:final children):
        buffer.write(inlineToPlainText(children));
      case MdLink(:final label):
        buffer.write(label);
    }
  }
  return buffer.toString();
}
