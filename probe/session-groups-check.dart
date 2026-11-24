// Runnable check for the session grouping rules.
//
// `flutter test` cannot run in this sandbox (the Flutter tool shells out to
// git and is denied), and the grouping logic is where the behaviour actually
// lives, so it is exercised directly here. Run with:
//   D:\IDE\dsh-bot\toolchain\flutter\bin\dart.bat run probe\group_check.dart
import 'dart:io';

import 'package:pocket_harness/src/dsh/host_link.dart';
import 'package:pocket_harness/src/dsh/session_groups.dart';

var failures = 0;

void check(String what, bool ok) {
  if (ok) {
    stdout.writeln('  ok   $what');
    return;
  }
  failures += 1;
  stdout.writeln('  FAIL $what');
}

SessionSummary session(
  String id,
  String? cwd,
  int updatedAt, {
  bool running = false,
}) => SessionSummary(
  sessionId: id,
  title: id,
  updatedAt: DateTime.fromMillisecondsSinceEpoch(updatedAt),
  running: running,
  cwd: cwd,
);

void main() {
  stdout.writeln('groupSessionsByProject');

  final grouped = groupSessionsByProject([
    session('a', r'D:\IDE\dsh-bot', 3000, running: true),
    session('b', r'D:\IDE\UU', 2000),
    session('c', r'D:\IDE\dsh-bot', 1000, running: true),
  ]);
  check('makes one section per directory', grouped.length == 2);
  check(
    'orders sections by newest activity',
    grouped.map((group) => group.key).join('|') == r'D:\IDE\dsh-bot|D:\IDE\UU',
  );
  check(
    'sorts members newest first',
    grouped.first.sessions.map((s) => s.sessionId).join(',') == 'a,c',
  );
  check(
    'labels a section with the folder name',
    grouped.first.label == 'dsh-bot',
  );
  check('counts running sessions', grouped.first.running == 2);
  check(
    'keeps the whole path available',
    grouped.first.key == r'D:\IDE\dsh-bot',
  );

  final ordered = groupSessionsByProject([
    session('old', r'D:\one', 1000),
    session('newest', r'D:\two', 9000),
    session('middle', r'D:\three', 5000),
  ]);
  check(
    'orders by the newest member, not first appearance',
    ordered.map((group) => group.key).join('|') == r'D:\two|D:\three|D:\one',
  );

  final orphans = groupSessionsByProject([
    session('idle', null, 9999),
    session('blank', '', 9998),
    session('real', r'D:\work', 1),
  ]);
  check(
    'keeps directory-less sessions together at the bottom',
    orphans.last.key.isEmpty,
  );
  check(
    'merges null and empty directories into one section',
    orphans.last.sessions.map((s) => s.sessionId).join(',') == 'idle,blank',
  );
  check('names that section 未指定目录', orphans.last.label == '未指定目录');
  check('keeps real projects above them', orphans.first.key == r'D:\work');
  check('handles an empty list', groupSessionsByProject(const []).isEmpty);

  stdout.writeln('basename');
  check('windows path', basename(r'D:\IDE\dsh-bot') == 'dsh-bot');
  check('posix path', basename('/home/x/work') == 'work');
  check('trailing separator', basename(r'D:\IDE\dsh-bot\') == 'dsh-bot');
  check('bare name', basename('work') == 'work');

  stdout.writeln('');
  if (failures == 0) {
    stdout.writeln('ALL SESSION GROUP CHECKS PASS');
  } else {
    stdout.writeln('$failures CHECK(S) FAILED');
    exitCode = 1;
  }
}
