/// Checks the pure pieces touched by the review fixes.
///
/// The Flutter toolchain in this sandbox cannot run `flutter test` (the analysis
/// server and the test runner are both blocked by file policy), so the parts of
/// the fixes that are pure functions are checked here through `dart run`.
library;

import 'dart:async';

int _passed = 0;
int _failed = 0;

void _check(String name, Object? actual, Object? expected) {
  if ('$actual' == '$expected') {
    _passed += 1;
    print('ok   $name -> $actual');
  } else {
    _failed += 1;
    print('FAIL $name -> got $actual, want $expected');
  }
}

/// Mirrors the comparator shape used by the job list.
int _compareJobs({
  required bool leftLive,
  required bool rightLive,
  required DateTime? leftAt,
  required DateTime? rightAt,
}) {
  if (leftLive != rightLive) return leftLive ? -1 : 1;
  if (leftAt == null && rightAt == null) return 0;
  if (leftAt == null) return 1;
  if (rightAt == null) return -1;
  return rightAt.compareTo(leftAt);
}

void main() {
  // --- job list ordering: live first, newest start first, unknown last ---
  final a = DateTime(2026, 1, 1);
  final b = DateTime(2026, 1, 2);

  _check('live beats finished', _compareJobs(leftLive: true, rightLive: false, leftAt: a, rightAt: b) < 0, true);
  _check('finished loses to live', _compareJobs(leftLive: false, rightLive: true, leftAt: b, rightAt: a) > 0, true);
  _check('newer start first', _compareJobs(leftLive: true, rightLive: true, leftAt: b, rightAt: a) < 0, true);
  _check('older start last', _compareJobs(leftLive: true, rightLive: true, leftAt: a, rightAt: b) > 0, true);

  // A comparator that returns 0 for "unknown vs known" is not a strict weak
  // ordering, so the sorted result depends on the input order. Unknowns must
  // sink to the end in both directions.
  _check('unknown sinks (left)', _compareJobs(leftLive: true, rightLive: true, leftAt: null, rightAt: a) > 0, true);
  _check('unknown sinks (right)', _compareJobs(leftLive: true, rightLive: true, leftAt: a, rightAt: null) < 0, true);
  _check('two unknowns tie', _compareJobs(leftLive: true, rightLive: true, leftAt: null, rightAt: null), 0);

  // Antisymmetry: swapping the arguments must flip the sign, which is what a
  // strict weak ordering means and what the old "return 0" branch broke.
  bool antisymmetric = true;
  for (final leftAt_ in <DateTime?>[null, a, b]) {
    for (final rightAt_ in <DateTime?>[null, a, b]) {
      for (final leftLive_ in <bool>[true, false]) {
        for (final rightLive_ in <bool>[true, false]) {
          final ab = _compareJobs(leftLive: leftLive_, rightLive: rightLive_, leftAt: leftAt_, rightAt: rightAt_);
          final ba = _compareJobs(leftLive: rightLive_, rightLive: leftLive_, leftAt: rightAt_, rightAt: leftAt_);
          if (ab.sign != -ba.sign) antisymmetric = false;
        }
      }
    }
  }
  _check('comparator is antisymmetric', antisymmetric, true);

  // Sorting must put unknowns last regardless of the order they arrived in.
  final items = <(bool, DateTime?)>[
    (true, null),
    (true, a),
    (true, b),
    (false, null),
  ];
  final forwards = [...items]..sort((l, r) => _compareJobs(leftLive: l.$1, rightLive: r.$1, leftAt: l.$2, rightAt: r.$2));
  final backwards = [...items.reversed]
      .toList()
    ..sort((l, r) => _compareJobs(leftLive: l.$1, rightLive: r.$1, leftAt: l.$2, rightAt: r.$2));
  _check('order does not depend on input order', '$forwards', '$backwards');
  _check('unknowns land at the end', forwards.last.$2, null);

  // --- session id shortening: a short id must not throw ---
  String shortId(String sessionId) => sessionId.length <= 8 ? sessionId : sessionId.substring(0, 8);

  _check('long id is cut', shortId('01JABCDEFGHIJKLMNOP'), '01JABCDE');
  _check('exactly eight stays', shortId('01JABCDE'), '01JABCDE');
  _check('short id stays', shortId('abc'), 'abc');
  _check('empty id stays', shortId(''), '');

  // --- a stream that dies before the snapshot must still stop the spinner ---
  // The page clears `_loading` in onError/onDone; this models that rule.
  var loading = true;
  String? error;
  final controller = StreamController<int>();
  final sub = controller.stream.listen(
    (_) {},
    onError: (Object e) {
      loading = false;
      error = '$e';
    },
    onDone: () {
      loading = false;
      error ??= 'closed';
    },
  );
  controller.addError(StateError('connection stopped answering'));
  scheduleMicrotask(() async {
    await controller.close();
    await sub.cancel();
    _check('error before snapshot clears loading', loading, false);
    _check('error is reported', error?.contains('stopped answering'), true);

    var doneLoading = true;
    final c2 = StreamController<int>();
    final s2 = c2.stream.listen(
      (_) {},
      onDone: () {
        doneLoading = false;
      },
    );
    await c2.close();
    await s2.cancel();
    _check('done before snapshot clears loading', doneLoading, false);

    // --- a failed answer must leave the question visible ---
    final pending = <String>['q1', 'q2'];
    Future<void> answer(int index, {required bool fail}) async {
      final question = pending[index];
      final at = pending.indexOf(question);
      pending.remove(question);
      try {
        if (fail) throw StateError('the question stream is not open');
      } on Object {
        pending.insert(at < 0 ? 0 : at, question);
      }
    }

    await answer(0, fail: true);
    _check('failed answer keeps the question', pending.join(','), 'q1,q2');
    await answer(1, fail: false);
    _check('successful answer removes it', pending.join(','), 'q1');
    await answer(0, fail: true);
    _check('restored at its old position', pending.join(','), 'q1');

    print('');
    print(_failed == 0 ? 'ALL APP FIX CHECKS PASS ($_passed)' : 'FAILURES: $_failed of ${_passed + _failed}');
    if (_failed != 0) throw StateError('fix checks failed');
  });
}
