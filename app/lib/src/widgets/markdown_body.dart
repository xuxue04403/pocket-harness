/// Renders a message body the way the desktop does it.
///
/// The desktop does not put replies in chat bubbles: text starts at the left
/// edge, fills the width, and each block gets real vertical rhythm. That is
/// what makes a long answer readable — a bubble narrows the line and every
/// extra line costs a scroll. The phone previously drew every reply as a
/// `SelectableText` of raw Markdown, so `**bold**` and `| a | b |` were shown
/// literally.
///
/// Everything here is a plain widget built from a pure parse, so a streaming
/// reply can reparse on every delta without losing scroll position: only the
/// subtree whose blocks changed gets rebuilt, and nothing is reloaded from
/// anywhere.
library;

import 'package:flutter/gestures.dart' show TapGestureRecognizer;
import 'package:flutter/services.dart' show Clipboard, ClipboardData;
import 'package:material_ui/material_ui.dart';

import '../dsh/code_highlight.dart';
import '../dsh/markdown.dart';

/// Colours for fenced code, close to the desktop's dark code surface but
/// expressed through the app's own theme so light and dark both work.
class MarkdownTheme {
  const MarkdownTheme({
    required this.codeBackground,
    required this.codeForeground,
    required this.keyword,
    required this.string,
    required this.comment,
    required this.number,
    required this.type,
    required this.literal,
    required this.added,
    required this.removed,
    required this.meta,
    required this.link,
  });

  final Color codeBackground;
  final Color codeForeground;
  final Color keyword;
  final Color string;
  final Color comment;
  final Color number;
  final Color type;
  final Color literal;
  final Color added;
  final Color removed;
  final Color meta;
  final Color link;

  /// A dark palette for either brightness: code blocks look like code blocks,
  /// not like inline text, and contrast inside them does not depend on the
  /// surrounding theme.
  static const dark = MarkdownTheme(
    codeBackground: Color(0xFF1E2127),
    codeForeground: Color(0xFFD7DAE0),
    keyword: Color(0xFFC792EA),
    string: Color(0xFFC3E88D),
    comment: Color(0xFF7A8290),
    number: Color(0xFFF78C6C),
    type: Color(0xFF82AAFF),
    literal: Color(0xFFFF9CAC),
    added: Color(0xFF7FD88F),
    removed: Color(0xFFE0707A),
    meta: Color(0xFF89DDFF),
    link: Color(0xFF4E8CF7),
  );
}

/// Renders one message body.
///
/// [streaming] is true while the reply is still arriving; it only affects the
/// trailing caret and whether a fence without a closing fence is treated as a
/// code block (which it is either way — see `markdown.dart`).
class MarkdownBody extends StatelessWidget {
  const MarkdownBody({
    super.key,
    required this.text,
    this.streaming = false,
    this.theme,
    this.selectable = true,
    this.onOpenLink,
    this.textStyle,
  });

  final String text;
  final bool streaming;
  final MarkdownTheme? theme;
  final bool selectable;
  final ValueChanged<String>? onOpenLink;
  final TextStyle? textStyle;

  @override
  Widget build(BuildContext context) {
    final blocks = parseMarkdown(text);
    final resolved = theme ?? MarkdownTheme.dark;
    final base = textStyle ?? Theme.of(context).textTheme.bodyMedium;
    final children = <Widget>[];
    for (var index = 0; index < blocks.length; index += 1) {
      if (index > 0) children.add(const SizedBox(height: 10));
      children.add(
        _BlockView(
          block: blocks[index],
          theme: resolved,
          base: base,
          selectable: selectable,
          onOpenLink: onOpenLink,
        ),
      );
    }
    if (streaming) children.add(const _Caret());
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: children,
    );
  }
}

class _Caret extends StatelessWidget {
  const _Caret();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 2),
      child: Align(
        alignment: Alignment.centerLeft,
        child: _CaretBlink(),
      ),
    );
  }
}

/// A small blinking block, the same affordance the desktop uses to say "more
/// text is coming". Kept as its own widget so the blink timer does not rebuild
/// the whole message on every frame.
class _CaretBlink extends StatefulWidget {
  const _CaretBlink();

  @override
  State<_CaretBlink> createState() => _CaretBlinkState();
}

class _CaretBlinkState extends State<_CaretBlink>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return FadeTransition(
      opacity: _controller.drive(Tween(begin: 0.9, end: 0.15)),
      child: Container(
        width: 7,
        height: 15,
        decoration: BoxDecoration(
          color: theme.colorScheme.primary,
          borderRadius: BorderRadius.circular(1.5),
        ),
      ),
    );
  }
}

class _BlockView extends StatelessWidget {
  const _BlockView({
    required this.block,
    required this.theme,
    required this.base,
    required this.selectable,
    required this.onOpenLink,
  });

  final MdBlock block;
  final MarkdownTheme theme;
  final TextStyle? base;
  final bool selectable;
  final ValueChanged<String>? onOpenLink;

  @override
  Widget build(BuildContext context) {
    final context2 = Theme.of(context);
    switch (block) {
      case MdHeading(:final level, :final spans):
        final style = switch (level) {
          1 => context2.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700),
          2 => context2.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
          3 => context2.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700),
          _ => context2.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w700),
        };
        return Padding(
          padding: EdgeInsets.only(top: level <= 2 ? 6 : 2, bottom: 2),
          child: _InlineText(
            spans: spans,
            style: style,
            theme: theme,
            selectable: selectable,
            onOpenLink: onOpenLink,
          ),
        );

      case MdParagraph(:final spans):
        return _InlineText(
          spans: spans,
          style: base?.copyWith(height: 1.55),
          theme: theme,
          selectable: selectable,
          onOpenLink: onOpenLink,
        );

      case final MdCodeBlock code:
        return _CodeCard(block: code, theme: theme);

      case final MdListBlock list:
        return _ListView(
          block: list,
          theme: theme,
          base: base,
          selectable: selectable,
          onOpenLink: onOpenLink,
        );

      case MdQuote(:final paragraphs):
        return _QuoteView(
          paragraphs: paragraphs,
          theme: theme,
          base: base,
          selectable: selectable,
          onOpenLink: onOpenLink,
        );

      case final MdTable table:
        return _TableView(
          block: table,
          theme: theme,
          base: base,
          selectable: selectable,
          onOpenLink: onOpenLink,
        );

      case MdDivider():
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Divider(height: 1, color: context2.colorScheme.outlineVariant),
        );
    }
  }
}

class _InlineText extends StatelessWidget {
  const _InlineText({
    required this.spans,
    required this.style,
    required this.theme,
    required this.selectable,
    required this.onOpenLink,
  });

  final List<MdInline> spans;
  final TextStyle? style;
  final MarkdownTheme theme;
  final bool selectable;
  final ValueChanged<String>? onOpenLink;

  @override
  Widget build(BuildContext context) {
    final text = TextSpan(children: _spans(context, spans, style, theme, onOpenLink));
    // Selectable so a phone user can copy a command out of a reply; streaming
    // text skips selection because a SelectableText that rebuilds on every
    // delta costs a selection controller per chunk.
    if (!selectable) {
      return Text.rich(text, style: style);
    }
    return SelectableText.rich(text, style: style);
  }
}

List<InlineSpan> _spans(
  BuildContext context,
  List<MdInline> spans,
  TextStyle? style,
  MarkdownTheme theme,
  ValueChanged<String>? onOpenLink,
) {
  final out = <InlineSpan>[];
  for (final span in spans) {
    switch (span) {
      case MdText(:final text):
        out.add(TextSpan(text: text));
      case MdStrong(:final children):
        out.add(
          TextSpan(
            children: _spans(context, children, style, theme, onOpenLink),
            style: const TextStyle(fontWeight: FontWeight.w700),
          ),
        );
      case MdEm(:final children):
        out.add(
          TextSpan(
            children: _spans(context, children, style, theme, onOpenLink),
            style: const TextStyle(fontStyle: FontStyle.italic),
          ),
        );
      case MdCodeSpan(:final text):
        out.add(
          TextSpan(
            text: text,
            style: TextStyle(
              fontFamily: 'monospace',
              fontSize: (style?.fontSize ?? 14) - 1,
              backgroundColor: theme.codeBackground.withValues(alpha: 0.10),
            ),
          ),
        );
      case MdLink(:final label, :final url):
        out.add(
          TextSpan(
            text: label,
            style: TextStyle(color: theme.link, decoration: TextDecoration.underline),
            recognizer: onOpenLink == null
                ? null
                : (TapGestureRecognizer()..onTap = () => onOpenLink(url)),
          ),
        );
    }
  }
  return out;
}

/// A code block with a language tag and a copy button, on a dark card.
class _CodeCard extends StatelessWidget {
  const _CodeCard({required this.block, required this.theme});

  final MdCodeBlock block;
  final MarkdownTheme theme;

  @override
  Widget build(BuildContext context) {
    final language = block.language;
    final spans = highlightCode(block.code, language);
    final lines = block.code.isEmpty ? 1 : '\n'.allMatches(block.code).length + 1;

    return ClipRRect(
      borderRadius: BorderRadius.circular(10),
      child: Container(
        color: theme.codeBackground,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(
              padding: const EdgeInsets.fromLTRB(12, 6, 6, 6),
              color: Colors.white.withValues(alpha: 0.04),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      language?.trim().isNotEmpty == true ? language!.trim() : 'code',
                      style: TextStyle(
                        fontSize: 11.5,
                        color: theme.codeForeground.withValues(alpha: 0.55),
                        fontFamily: 'monospace',
                      ),
                    ),
                  ),
                  if (!block.closed)
                    Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: Text(
                        '写入中',
                        style: TextStyle(
                          fontSize: 11,
                          color: theme.codeForeground.withValues(alpha: 0.45),
                        ),
                      ),
                    ),
                  _CopyButton(code: block.code, foreground: theme.codeForeground),
                ],
              ),
            ),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // Line numbers make a diff-readable block obvious and cost
                    // one narrow column; they are skipped for one-liners,
                    // where the gutter is pure noise.
                    if (lines > 2)
                      Padding(
                        padding: const EdgeInsets.only(right: 10),
                        child: Text(
                          List.generate(lines, (index) => '${index + 1}').join('\n'),
                          style: TextStyle(
                            fontFamily: 'monospace',
                            fontSize: 12.5,
                            height: 1.45,
                            color: theme.codeForeground.withValues(alpha: 0.28),
                          ),
                          textAlign: TextAlign.right,
                        ),
                      ),
                    Text.rich(
                      TextSpan(
                        children: [
                          for (final span in spans)
                            TextSpan(
                              text: span.text,
                              style: TextStyle(color: _colorFor(span.kind, theme)),
                            ),
                        ],
                      ),
                      style: TextStyle(
                        fontFamily: 'monospace',
                        fontSize: 12.5,
                        height: 1.45,
                        color: theme.codeForeground,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _CopyButton extends StatelessWidget {
  const _CopyButton({required this.code, required this.foreground});

  final String code;
  final Color foreground;

  @override
  Widget build(BuildContext context) {
    return TextButton(
      style: TextButton.styleFrom(
        minimumSize: const Size(0, 28),
        padding: const EdgeInsets.symmetric(horizontal: 8),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      ),
      onPressed: () {
        Clipboard.setData(ClipboardData(text: code));
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          const SnackBar(content: Text('已复制代码'), duration: Duration(seconds: 1)),
        );
      },
      child: Text(
        '复制',
        style: TextStyle(fontSize: 11.5, color: foreground.withValues(alpha: 0.75)),
      ),
    );
  }
}

Color _colorFor(CodeKind kind, MarkdownTheme theme) => switch (kind) {
      CodeKind.keyword => theme.keyword,
      CodeKind.string => theme.string,
      CodeKind.comment => theme.comment,
      CodeKind.number => theme.number,
      CodeKind.type => theme.type,
      CodeKind.literal => theme.literal,
      CodeKind.added => theme.added,
      CodeKind.removed => theme.removed,
      CodeKind.meta => theme.meta,
      CodeKind.plain => theme.codeForeground,
    };

class _ListView extends StatelessWidget {
  const _ListView({
    required this.block,
    required this.theme,
    required this.base,
    required this.selectable,
    required this.onOpenLink,
  });

  final MdListBlock block;
  final MarkdownTheme theme;
  final TextStyle? base;
  final bool selectable;
  final ValueChanged<String>? onOpenLink;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var index = 0; index < block.items.length; index += 1)
          Padding(
            padding: EdgeInsets.only(
              left: block.items[index].depth == 0 ? 2 : 22,
              bottom: index == block.items.length - 1 ? 0 : 5,
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 20,
                  child: Padding(
                    padding: const EdgeInsets.only(top: 1),
                    child: Text(
                      block.ordered ? '${block.items[index].number ?? index + 1}.' : '•',
                      style: base?.copyWith(height: 1.55),
                    ),
                  ),
                ),
                Expanded(
                  child: _InlineText(
                    spans: block.items[index].spans,
                    style: base?.copyWith(height: 1.55),
                    theme: theme,
                    selectable: selectable,
                    onOpenLink: onOpenLink,
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

class _QuoteView extends StatelessWidget {
  const _QuoteView({
    required this.paragraphs,
    required this.theme,
    required this.base,
    required this.selectable,
    required this.onOpenLink,
  });

  final List<List<MdInline>> paragraphs;
  final MarkdownTheme theme;
  final TextStyle? base;
  final bool selectable;
  final ValueChanged<String>? onOpenLink;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      decoration: BoxDecoration(
        border: Border(left: BorderSide(color: scheme.primary.withValues(alpha: 0.5), width: 3)),
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.35),
      ),
      padding: const EdgeInsets.fromLTRB(12, 8, 10, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var index = 0; index < paragraphs.length; index += 1)
            Padding(
              padding: EdgeInsets.only(bottom: index == paragraphs.length - 1 ? 0 : 6),
              child: _InlineText(
                spans: paragraphs[index],
                style: base?.copyWith(
                  height: 1.5,
                  color: scheme.onSurfaceVariant,
                ),
                theme: theme,
                selectable: selectable,
                onOpenLink: onOpenLink,
              ),
            ),
        ],
      ),
    );
  }
}

class _TableView extends StatelessWidget {
  const _TableView({
    required this.block,
    required this.theme,
    required this.base,
    required this.selectable,
    required this.onOpenLink,
  });

  final MdTable block;
  final MarkdownTheme theme;
  final TextStyle? base;
  final bool selectable;
  final ValueChanged<String>? onOpenLink;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final columns = block.header.isEmpty ? 1 : block.header.length;
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: DataTable(
        headingRowHeight: 38,
        dataRowMinHeight: 34,
        dataRowMaxHeight: 60,
        columnSpacing: 18,
        horizontalMargin: 8,
        headingRowColor: WidgetStatePropertyAll(
          scheme.surfaceContainerHighest.withValues(alpha: 0.5),
        ),
        border: TableBorder(
          horizontalInside: BorderSide(color: scheme.outlineVariant.withValues(alpha: 0.6)),
          bottom: BorderSide(color: scheme.outlineVariant.withValues(alpha: 0.6)),
        ),
        columns: [
          for (var index = 0; index < columns; index += 1)
            DataColumn(
              label: _InlineText(
                spans: index < block.header.length ? block.header[index] : const [],
                style: base?.copyWith(fontWeight: FontWeight.w600, height: 1.35),
                theme: theme,
                selectable: false,
                onOpenLink: onOpenLink,
              ),
              numeric: index < block.aligns.length && block.aligns[index] == 1,
            ),
        ],
        rows: [
          for (final row in block.rows)
            DataRow(
              cells: [
                for (var index = 0; index < columns; index += 1)
                  DataCell(
                    Container(
                      alignment: switch (index < block.aligns.length ? block.aligns[index] : -1) {
                        0 => Alignment.center,
                        1 => Alignment.centerRight,
                        _ => Alignment.centerLeft,
                      },
                      child: _InlineText(
                        spans: index < row.length ? row[index] : const [],
                        style: base?.copyWith(height: 1.35),
                        theme: theme,
                        selectable: selectable,
                        onOpenLink: onOpenLink,
                      ),
                    ),
                  ),
              ],
            ),
        ],
      ),
    );
  }
}
