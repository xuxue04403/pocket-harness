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
