import 'package:dsh_link/dsh_link.dart';
import 'package:material_ui/material_ui.dart';

import 'pages/hosts_page.dart';
import 'storage/host_store.dart';

/// A pairing code supplied at build or run time, used to seed a Host list.
///
/// This exists so an automated smoke run can reach a real Host without a
/// camera; a normal build leaves it empty because the value is absent unless
/// `--dart-define=POCKET_HARNESS_PAIR_TICKET=...` is passed.
const String _seededTicket = String.fromEnvironment('POCKET_HARNESS_PAIR_TICKET');

/// Root of the phone app.
///
/// One screen deep so far: the Host list, which is where both a first pairing
/// and a return visit start. Sessions hang off the Host the person picks.
class PocketHarnessApp extends StatefulWidget {
  const PocketHarnessApp({super.key});

  @override
  State<PocketHarnessApp> createState() => _PocketHarnessAppState();
}

class _PocketHarnessAppState extends State<PocketHarnessApp> {
  late final Future<HostStore> _store = _bootstrap();

  /// Opens storage and, when a code was supplied at launch, records it once.
  Future<HostStore> _bootstrap() async {
    final store = await HostStore.open();
    if (_seededTicket.isEmpty || store.hosts().isNotEmpty) return store;
    try {
      await store.saveHost(PairingTicket.decode(_seededTicket));
    } on FormatException {
      // A malformed build-time value is ignored: the normal pairing flow still
      // works, and failing to start would be worse than starting unpaired.
    }
    return store;
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Pocket Harness',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF1F6F5C)),
        useMaterial3: true,
      ),
      darkTheme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF1F6F5C),
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
      ),
      home: FutureBuilder<HostStore>(
        future: _store,
        builder: (context, snapshot) {
          if (snapshot.hasError) {
            return _StartupError(message: '${snapshot.error}');
          }
          if (!snapshot.hasData) {
            return const Scaffold(body: Center(child: CircularProgressIndicator()));
          }
          return HostsPage(store: snapshot.data!);
        },
      ),
    );
  }
}

class _StartupError extends StatelessWidget {
  const _StartupError({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, size: 48),
              const SizedBox(height: 12),
              Text('Pocket Harness could not start', style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              Text(message, textAlign: TextAlign.center),
            ],
          ),
        ),
      ),
    );
  }
}
