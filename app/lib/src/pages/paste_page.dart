import 'package:dsh_link/dsh_link.dart';
import 'package:material_ui/material_ui.dart';

/// Pairs by typing or pasting the pairing code instead of scanning it.
///
/// The desktop prints the same `pocketharness://pair?...` text it draws as a
/// QR code, so anyone whose camera is unavailable, broken, or looking at a
/// remote screen can still pair by pasting that line.
class PastePage extends StatefulWidget {
  const PastePage({super.key});

  @override
  State<PastePage> createState() => _PastePageState();
}

class _PastePageState extends State<PastePage> {
  final TextEditingController _controller = TextEditingController();
  String? _error;

  void _submit() {
    final text = _controller.text.trim();
    if (text.isEmpty) {
      setState(() => _error = '请先粘贴配对码。');
      return;
    }
    try {
      Navigator.of(context).pop(PairingTicket.decode(text));
    } on FormatException catch (error) {
      setState(() => _error = error.message);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('输入配对码')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              '配对码以 pocketharness://pair 开头，会打印在电脑上的 Pocket Harness 日志里。',
              style: theme.textTheme.bodyMedium,
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _controller,
              minLines: 3,
              maxLines: 6,
              autofocus: true,
              style: theme.textTheme.bodySmall,
              decoration: InputDecoration(
                hintText: 'pocketharness://pair?t=...',
                errorText: _error,
                border: const OutlineInputBorder(),
              ),
              onChanged: (_) {
                if (_error != null) setState(() => _error = null);
              },
            ),
            const SizedBox(height: 16),
            FilledButton(onPressed: _submit, child: const Text('配对')),
          ],
        ),
      ),
    );
  }
}
