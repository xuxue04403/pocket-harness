// Checks for the scroll-follow arithmetic used by the chat transcript.
//
// Run with:
//   dart run --packages=app/.dart_tool/package_config.json probe/scroll-follow-check.dart

import 'package:pocket_harness/src/dsh/scroll_follow.dart';

int failures = 0;

/// Compares numerically, so `7500` and `7500.0` agree: the helpers work in
/// doubles and the intent of a check is the number, not the representation.
void checkNumber(String name, double actual, num expected) {
  final ok = (actual - expected).abs() < 0.0001;
  print('${ok ? 'ok  ' : 'FAIL'} $name -> $actual${ok ? '' : ' (expected $expected)'}');
  if (!ok) failures += 1;
}

void checkBool(String name, bool actual, bool expected) {
  final ok = actual == expected;
  print('${ok ? 'ok  ' : 'FAIL'} $name -> $actual${ok ? '' : ' (expected $expected)'}');
  if (!ok) failures += 1;
}

void main() {
  // Following the tail.
  checkBool('a brand new page follows', followsTail(0, 0), true);
  checkBool('sitting at the bottom follows', followsTail(1000, 1000), true);
  checkBool('just inside the slack follows', followsTail(900, 1000), true);
  checkBool('scrolled up does not follow', followsTail(400, 1000), false);
  checkBool('scrolled far up does not follow', followsTail(0, 5000), false);
  checkBool('a tiny viewport still follows', followsTail(0, 20), true);
  checkBool('custom slack', followsTail(700, 1000, slack: 50), false);
  checkBool('custom slack follows', followsTail(960, 1000, slack: 50), true);

  // Holding the reader's place when older messages are prepended.
  // 2000 tall, reader at 1500 (500 from the bottom). 8000 after prepending.
  checkNumber('keeps distance from the bottom', offsetHoldingDistance(1500, 2000, 8000), 7500);
  checkNumber('no growth means no move', offsetHoldingDistance(1500, 2000, 2000), 1500);
  checkNumber('never below zero', offsetHoldingDistance(10, 2000, 100), 0);
  // The list shrank below the old distance from the bottom: clamp to the end.
  checkNumber('never past the end', offsetHoldingDistance(0, 100, 50), 0);
  checkNumber(
    'reading the very top stays put in distance terms',
    offsetHoldingDistance(0, 3000, 9000),
    6000,
  );

  print(failures == 0 ? 'ALL SCROLL FOLLOW CHECKS PASS' : '$failures CHECK(S) FAILED');
  if (failures != 0) throw StateError('$failures scroll-follow checks failed');
}
