import 'package:dsh_link/dsh_link.dart';

/// A question the Host is waiting on, normalised for the phone UI.
///
/// DSH asks the human two different things while a turn is blocked: whether a
/// tool may run (`approval/request`) and what the answer to a question is
/// (`user-questions/request`). Both arrive as the same forwarded waterfall, so
/// one view can show either as long as the raw request is kept for the reply.
sealed class PendingQuestion {
  const PendingQuestion({required this.invocation, required this.title});

  /// The forwarded waterfall this came from.
  final RemoteInvocation invocation;

  /// One line naming what is being asked.
  final String title;

  /// Whether answering this one is a simple yes/no.
  bool get isApproval;
}

/// A tool waiting for permission to run.
class ApprovalQuestion extends PendingQuestion {
  const ApprovalQuestion({
    required super.invocation,
    required super.title,
    this.toolName,
    this.reason,
  });

  final String? toolName;
  final String? reason;

  @override
  bool get isApproval => true;
}

/// A `ask_user_question` prompt: one or more questions with fixed choices.
class ChoiceQuestion extends PendingQuestion {
  const ChoiceQuestion({
    required super.invocation,
    required super.title,
    required this.questions,
  });

  final List<QuestionChoice> questions;

  @override
  bool get isApproval => false;

  /// Builds the value DSH's answer listener expects.
  ///
  /// [selections] maps a question id to the chosen labels (empty for a skipped
  /// question) and [custom] carries the free-text "Other" answer.
  Map<String, Object?> answerValue(
    Map<String, List<String>> selections, {
    Map<String, String> custom = const {},
  }) {
    return {
      'answers': [
        for (final question in questions)
          {
            'id': question.id,
            'selected': selections[question.id] ?? const <String>[],
            if (custom[question.id] != null) 'custom': custom[question.id],
          },
      ],
    };
  }
}

/// One question inside a [ChoiceQuestion].
class QuestionChoice {
  const QuestionChoice({
    required this.id,
    required this.question,
    required this.options,
    this.header,
    this.detail,
    this.multiSelect = false,
  });

  /// Stable id the Host echoes back in the answer.
  final String id;
  final String question;
  final String? header;
  final String? detail;
  final List<QuestionOption> options;
  final bool multiSelect;
}

/// One selectable answer.
class QuestionOption {
  const QuestionOption({required this.label, this.description});

  final String label;
  final String? description;
}

/// Approvals accept exactly one permitting outcome; anything else fails closed.
const String approvalAllowedOnce = 'allowed-once';
const String approvalRejected = 'rejected';

/// Reads a forwarded waterfall, or returns null when it is something the phone
/// cannot render (an unknown event, or a question with no choices).
PendingQuestion? readQuestion(RemoteInvocation invocation) {
  switch (invocation.event) {
    case 'approval/request':
      final toolName = _string(invocation.request['toolName']);
      final reason = _displayReason(invocation.request['displayReason']) ??
          _string(invocation.request['reason']);
      final subject = toolName ?? '某个工具';
      return ApprovalQuestion(
        invocation: invocation,
        title: reason == null ? '$subject 想要执行' : '$subject: $reason',
        toolName: toolName,
        reason: reason,
      );
    case 'user-questions/request':
      final parsed = _readChoices(invocation.request);
      if (parsed.isEmpty) return null;
      return ChoiceQuestion(
        invocation: invocation,
        title: parsed.length == 1 ? parsed.first.question : '${parsed.length} 个问题',
        questions: parsed,
      );
    default:
      return null;
  }
}

List<QuestionChoice> _readChoices(Map<String, Object?> request) {
  final raw = request['questions'];
  if (raw is! List) return const [];
  final parsed = <QuestionChoice>[];
  for (final entry in raw) {
    if (entry is! Map<String, Object?>) continue;
    final text = _string(entry['question']);
    if (text == null) continue;
    parsed.add(QuestionChoice(
      // A question without an id cannot be answered, because the answer is keyed
      // by it; fall back to its position so one malformed entry does not hide the
      // rest of the prompt.
      id: _string(entry['id']) ?? 'question-${parsed.length}',
      question: text,
      header: _string(entry['header']),
      detail: _string(entry['detail']),
      multiSelect: entry['multiSelect'] == true,
      options: _readOptions(entry['options']),
    ));
  }
  return parsed;
}

List<QuestionOption> _readOptions(Object? raw) {
  if (raw is! List) return const [];
  final options = <QuestionOption>[];
  for (final entry in raw) {
    // Options are `{label, description}` on current Hosts and bare strings on
    // older ones; accept both so a version skew degrades instead of crashing.
    if (entry is String) {
      options.add(QuestionOption(label: entry));
      continue;
    }
    if (entry is! Map<String, Object?>) continue;
    final label = _string(entry['label']);
    if (label == null) continue;
    options.add(QuestionOption(label: label, description: _string(entry['description'])));
  }
  return options;
}

String? _displayReason(Object? value) {
  if (value is! Map<String, Object?>) return null;
  // Prefer English when the phone has no translation for this Host's locale.
  final english = _string(value['en']);
  if (english != null) return english;
  for (final entry in value.values) {
    final text = _string(entry);
    if (text != null) return text;
  }
  return null;
}

String? _string(Object? value) {
  if (value is! String) return null;
  final trimmed = value.trim();
  return trimmed.isEmpty ? null : trimmed;
}
