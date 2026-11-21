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
    _listenOnce();
    await _methods.invokeMethod<bool>('start', <String, Object?>{
      'tag': tag,
      'argv': argv,
      'cwd': cwd,
    });
  }

  Future<bool> stop(String tag) async =>
      (await _methods.invokeMethod<bool>('stop', <String, Object?>{'tag': tag})) ?? false;

  Future<void> killAll() async => _methods.invokeMethod<bool>('killAll');

  void _listenOnce() {
    if (_lines != null) {
      return;
    }
    _lines = _events.receiveBroadcastStream().where((Object? e) => e is Map).map((Object? e) {
      final Map<Object?, Object?> map = e as Map<Object?, Object?>;
      return LocalLine(
        tag: '${map['tag'] ?? ''}',
        kind: '${map['kind'] ?? ''}',
        line: '${map['line'] ?? ''}',
        code: map['code'] is int ? map['code'] as int : null,
      );
    }).listen(_out.add, onError: _out.addError);
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
