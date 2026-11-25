import 'host_link.dart';

/// One project's sessions: everything the Host reported for a single working
/// directory.
class SessionGroup {
  SessionGroup({required this.key, required this.sessions});

  /// The working directory, or the empty string for sessions that have none.
  final String key;
  final List<SessionSummary> sessions;

  /// Newest activity in this project, which decides where the section sits.
  DateTime get newest => sessions.isEmpty
      ? DateTime.fromMillisecondsSinceEpoch(0)
      : sessions.first.updatedAt;

  /// The folder name a person recognises. The full path would not fit on a
  /// phone and is shown verbatim below it instead.
  String get label => key.isEmpty ? '未指定目录' : basename(key);

  /// How many of this project's sessions are still working.
  int get running => sessions.where((session) => session.running).length;
}

/// Groups the flat list the Host sends into one section per working directory,
/// the way the desktop's sidebar does.
///
/// The Host answers `session/list` in activity order with no project structure
/// at all, which is why the flat list read as noise: four "未命名会话" rows in a
/// row, each with a different folder underneath. Grouping here — not on the
/// Host — keeps the wire protocol unchanged and still gives every session one
/// home.
///
/// Sections are ordered by their newest activity, except that sessions with no
/// directory always sink to the bottom: they are leftovers, and putting one at
/// the top because it was touched a minute ago pushes real projects down.
///
/// This lives outside the page so it can be tested without a widget tree, and
/// so the phone's grouping rules stay readable in one place.
List<SessionGroup> groupSessionsByProject(List<SessionSummary> sessions) {
  final buckets = <String, List<SessionSummary>>{};
  for (final session in sessions) {
    final cwd = session.cwd;
    final key = cwd == null || cwd.isEmpty ? '' : cwd;
    (buckets[key] ??= <SessionSummary>[]).add(session);
  }
  final groups = <SessionGroup>[];
  buckets.forEach((key, members) {
    // The Host already sorts by activity, but a group is only as recent as its
    // newest member, and that is what decides where the section sits.
    members.sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    groups.add(SessionGroup(key: key, sessions: members));
  });
  groups.sort((a, b) {
    if (a.key.isEmpty != b.key.isEmpty) return a.key.isEmpty ? 1 : -1;
    return b.newest.compareTo(a.newest);
  });
  return groups;
}

/// The last path segment, for a chat title that fits on one line.
String basename(String path) {
  var trimmed = path;
  while (trimmed.length > 1 &&
      (trimmed.endsWith(r'\') || trimmed.endsWith('/'))) {
    trimmed = trimmed.substring(0, trimmed.length - 1);
  }
  final cut = trimmed.lastIndexOf(RegExp(r'[\\/]'));
  final name = cut == -1 ? trimmed : trimmed.substring(cut + 1);
  return name.isEmpty ? trimmed : name;
}

/// The projects a freshly opened page folds shut, keyed the way the page keys
/// them.
///
/// The page opens as a project index rather than a session list: 22 projects of
/// 900-odd sessions all expanded is the same wall of titles the grouping exists
/// to remove, only indented and slower to scroll. Everything starts folded so
/// the first screen answers "which projects do I have", and opening one answers
/// "what is in it". Kept here rather than in the widget so the rule is testable
/// without a widget tree.
Set<String> projectsFoldedOnOpen(List<SessionGroup> groups) {
  return groups.map((group) => group.key).toSet();
}

/// The sessions worth a row on the phone, which is what the desktop sidebar
/// lists.
///
/// DSH answers `session/list` with every session it ever created — 941 of them
/// on the machine this was written against, of which only 3 ever got an agent. A
/// folder where the desktop listed one session came back with nine, which read
/// as the phone and the computer disagreeing about the same folder.
///
/// Seven of those nine are start-up failures, not conversations: the same prompt
/// was queued eight times in an hour, each turn began, and no agent was ever
/// bound — so each has a user row carrying that prompt as its title, and
/// `agentAvailable` false. None of them can be opened (the Host has no agent to
/// resume), and the desktop never lists them. `blank` cannot stand in for this
/// check: those rows carry `blank: false` because a prompt landed in them, which
/// is exactly what makes them look real in a list. `probe/session-count.mjs`
/// prints these counts against a live Host so none of this has to be taken on
/// faith.
///
/// This flag is the one the desktop filters on, so it is the one the phone
/// filters on too. It is read as `!= false` rather than `== true` on purpose:
/// sessions the Host reports without the field at all are older, real sessions.
List<SessionSummary> sessionsWorthShowing(List<SessionSummary> sessions) {
  return sessions.where((session) => session.agentAvailable).toList();
}
