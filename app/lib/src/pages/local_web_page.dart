import 'package:material_ui/material_ui.dart';
import 'package:webview_flutter/webview_flutter.dart';

/// 用一个 WebView 打开手机本机跑起来的 dsh。
///
/// 这里只加载 `127.0.0.1` 上的页面，不做任何注入：dsh 的界面自己会带
/// token 完成鉴权（地址里已经带了 `?token=`，服务端会回 303 加 cookie）。
class LocalWebPage extends StatefulWidget {
  const LocalWebPage({super.key, required this.url});

  final String url;

  @override
  State<LocalWebPage> createState() => _LocalWebPageState();
}

class _LocalWebPageState extends State<LocalWebPage> {
  late final WebViewController _controller = WebViewController()
    ..setJavaScriptMode(JavaScriptMode.unrestricted)
    ..setBackgroundColor(const Color(0xFFFFFFFF))
    ..loadRequest(Uri.parse(widget.url));

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('dsh（本机）'),
        actions: [
          IconButton(
            tooltip: '刷新',
            onPressed: _controller.reload,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: WebViewWidget(controller: _controller),
    );
  }
}
