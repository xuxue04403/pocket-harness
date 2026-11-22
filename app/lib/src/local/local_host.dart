import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';

/// 本机 dsh 的原生通道：拿路径、起进程、读输出。
///
/// 只有一个约束值得记住：所有方法都在 Android 上才可用。iOS 上
/// `MethodChannel` 会抛 `MissingPluginException`，所以调用方要先看 [supported]。
class LocalHost {
  LocalHost({MethodChannel? methods, EventChannel? events})
      : _methods = methods ?? const MethodChannel('cn.pocketharness/native'),
        _events = events ?? const EventChannel('cn.pocketharness/native/events');

  final MethodChannel _methods;
  final EventChannel _events;

  static bool get supported => Platform.isAndroid;

  StreamSubscription<LocalLine>? _lines;
  final StreamController<LocalLine> _out = StreamController<LocalLine>.broadcast();

  /// EventChannel 的 `onListen` 要跨一次平台往返才到，原生侧的 sink 在那之前是
  /// null。proot 一条命令可能 150 ms 就跑完，如果这时才开始订阅，输出和 exit
  /// 事件会全部丢掉 —— 表现是「装了却一直显示没装」，而 `_runToEnd` 永远
  /// 等不到 done。所以订阅要能被 await。
  Completer<void>? _listening;

  /// 逐行的输出，`kind` 是 `stdout` / `stderr` / `exit`。
  Stream<LocalLine> get lines => _out.stream;

  Future<LocalPaths> paths() async {
    final Map<Object?, Object?> raw =
        (await _methods.invokeMapMethod<Object?, Object?>('paths')) ?? <Object?, Object?>{};
    return LocalPaths(
      abi: '${raw['abi'] ?? ''}',
      nativeLibraryDir: '${raw['nativeLibraryDir'] ?? ''}',
      filesDir: '${raw['filesDir'] ?? ''}',
      cacheDir: '${raw['cacheDir'] ?? ''}',
    );
  }

  Future<void> start({
    required String tag,
    required List<String> argv,
    String? cwd,
  }) async {
    await _listenOnce();
    await _methods.invokeMethod<bool>('start', <String, Object?>{
      'tag': tag,
      'argv': argv,
      'cwd': cwd,
    });
  }

  Future<bool> stop(String tag) async =>
      (await _methods.invokeMethod<bool>('stop', <String, Object?>{'tag': tag})) ?? false;

  Future<void> killAll() async => _methods.invokeMethod<bool>('killAll');

  Future<void> _listenOnce() async {
    if (_lines != null) {
      return _listening?.future ?? Future<void>.value();
    }
    final Completer<void> ready = Completer<void>();
    _listening = ready;
    _lines = _events.receiveBroadcastStream().where((Object? e) => e is Map).map((Object? e) {
      final Map<Object?, Object?> map = e as Map<Object?, Object?>;
      return LocalLine(
        tag: '${map['tag'] ?? ''}',
        kind: '${map['kind'] ?? ''}',
        line: '${map['line'] ?? ''}',
        code: map['code'] is int ? map['code'] as int : null,
      );
    }).listen(_out.add, onError: _out.addError);
    // 原生侧的 sink 是在 EventChannel 的 onListen 里赋值的，那要跨一次平台往返。
    // 这里主动问一次 `running`：它在同一个 channel 上排队，回来就说明 onListen
    // 已经跑过了（原生侧还会把这段时间的输出缓冲起来，不会丢）。
    try {
      await _methods.invokeMethod<List<Object?>>('running');
    } on Object {
      // 老版本没有这个方法，退化成一次让路。
      await Future<void>.delayed(const Duration(milliseconds: 60));
    }
    ready.complete();
  }

  Future<void> dispose() async {
    await _lines?.cancel();
    _lines = null;
    await _out.close();
  }
}

class LocalPaths {
  const LocalPaths({
    required this.abi,
    required this.nativeLibraryDir,
    required this.filesDir,
    required this.cacheDir,
  });

  final String abi;
  final String nativeLibraryDir;
  final String filesDir;
  final String cacheDir;
}

class LocalLine {
  const LocalLine({
    required this.tag,
    required this.kind,
    required this.line,
    this.code,
  });

  final String tag;
  final String kind;
  final String line;
  final int? code;
}
