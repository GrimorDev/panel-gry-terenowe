import 'dart:async';
import 'dart:convert';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';

import 'src/core/api_client.dart';
import 'src/core/local_store.dart';
import 'src/core/models.dart';
import 'src/core/sync_service.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(HufcMobileApp(store: LocalStore(), api: ApiClient()));
}

class HufcMobileApp extends StatefulWidget {
  const HufcMobileApp({super.key, required this.store, required this.api});

  final LocalStore store;
  final ApiClient api;

  @override
  State<HufcMobileApp> createState() => _HufcMobileAppState();
}

class _HufcMobileAppState extends State<HufcMobileApp> {
  AuthSession? _session;
  AppState? _state;
  bool _booting = true;
  bool _online = false;
  bool _syncing = false;
  int _queueCount = 0;
  String _apiBaseUrl = ApiClient.defaultBaseUrl;

  @override
  void initState() {
    super.initState();
    _boot();
    Connectivity().onConnectivityChanged.listen((_) => _refreshOnline(sync: true));
  }

  Future<void> _boot() async {
    final savedApiBaseUrl = await widget.store.get('api_base_url');
    if (savedApiBaseUrl != null) widget.api.setBaseUrl(savedApiBaseUrl);
    final auth = await widget.store.readAuth();
    final cached = await widget.store.readState();
    final online = await _isOnline();
    setState(() {
      _session = auth;
      _state = cached;
      _apiBaseUrl = widget.api.baseUrl;
      _online = online;
      _booting = false;
    });
    await _refreshQueue();
    if (auth != null && online) await _sync();
  }

  Future<bool> _isOnline() async {
    final result = await Connectivity().checkConnectivity();
    return !result.contains(ConnectivityResult.none);
  }

  Future<void> _refreshOnline({bool sync = false}) async {
    final online = await _isOnline();
    if (!mounted) return;
    setState(() => _online = online);
    if (online && sync && _session != null) await _sync();
  }

  Future<void> _refreshQueue() async {
    final count = await widget.store.queueCount();
    if (mounted) setState(() => _queueCount = count);
  }

  Future<void> _login(String email, String password) async {
    final session = await widget.api.login(email, password);
    await widget.store.saveAuth(session);
    final state = await widget.api.state(session.token);
    await widget.store.saveState(state);
    if (!mounted) return;
    setState(() {
      _session = session;
      _state = state;
      _online = true;
    });
  }

  Future<void> _setApiBaseUrl(String value) async {
    widget.api.setBaseUrl(value);
    await widget.store.put('api_base_url', widget.api.baseUrl);
    if (!mounted) return;
    setState(() => _apiBaseUrl = widget.api.baseUrl);
  }

  Future<void> _logout() async {
    await widget.store.clearAuth();
    if (!mounted) return;
    setState(() => _session = null);
  }

  Future<void> _sync() async {
    if (_session == null || _syncing) return;
    setState(() => _syncing = true);
    try {
      final latest = await SyncService(store: widget.store, api: widget.api).sync(_session!, gameId: _state?.game.id);
      if (mounted && latest != null) setState(() => _state = latest);
    } catch (_) {
      if (mounted) setState(() => _online = false);
    } finally {
      await _refreshQueue();
      if (mounted) setState(() => _syncing = false);
    }
  }

  Future<void> _saveLocal(AppState state) async {
    await widget.store.saveState(state);
    if (mounted) setState(() => _state = state);
  }

  Future<void> _mutate(String url, Map<String, dynamic> body, AppState optimistic) async {
    await _saveLocal(optimistic);
    if (_session == null) return;
    if (_online) {
      try {
        final latest = await widget.api.postState(_session!.token, url, body);
        await _saveLocal(latest);
        return;
      } catch (_) {
        if (mounted) setState(() => _online = false);
      }
    }
    await widget.store.enqueue(url, 'POST', body);
    await _refreshQueue();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Mój Hufiec',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF1F5C36)),
        useMaterial3: true,
        scaffoldBackgroundColor: const Color(0xFFF7F3EC),
      ),
      home: _booting
          ? const BootScreen()
          : _session == null
              ? LoginScreen(
                  onLogin: _login,
                  apiBaseUrl: _apiBaseUrl,
                  onApiBaseUrlChanged: _setApiBaseUrl,
                )
              : ShellScreen(
                  session: _session!,
                  state: _state,
                  online: _online,
                  syncing: _syncing,
                  queueCount: _queueCount,
                  onLogout: _logout,
                  onSync: _sync,
                  onMutate: _mutate,
                ),
    );
  }
}

class BootScreen extends StatelessWidget {
  const BootScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const Scaffold(body: Center(child: HufcLoader()));
  }
}

class LoginScreen extends StatefulWidget {
  const LoginScreen({
    super.key,
    required this.onLogin,
    required this.apiBaseUrl,
    required this.onApiBaseUrlChanged,
  });

  final Future<void> Function(String email, String password) onLogin;
  final String apiBaseUrl;
  final Future<void> Function(String value) onApiBaseUrlChanged;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _apiBaseUrl = TextEditingController();
  bool _loading = false;
  bool _passwordVisible = false;
  bool _showServerSettings = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _apiBaseUrl.text = widget.apiBaseUrl;
  }

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _apiBaseUrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final email = _email.text.trim();
    final password = _password.text;
    if (email.isEmpty || password.isEmpty) {
      setState(() => _error = 'Wpisz e-mail i hasło.');
      return;
    }
    FocusScope.of(context).unfocus();
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await widget.onApiBaseUrlChanged(_apiBaseUrl.text);
      await widget.onLogin(email, password);
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      resizeToAvoidBottomInset: true,
      body: SafeArea(
        child: Stack(
          children: [
            Positioned.fill(
              child: DecoratedBox(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: [
                      const Color(0xFFF7F3EC),
                      const Color(0xFFF7F3EC),
                      theme.colorScheme.primary.withValues(alpha: 0.08),
                    ],
                  ),
                ),
              ),
            ),
            Center(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(22),
                keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 420),
                  child: Card(
                    elevation: 0,
                    color: Colors.white.withValues(alpha: 0.96),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(28)),
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Row(
                            children: [
                              Container(
                                width: 42,
                                height: 42,
                                alignment: Alignment.center,
                                decoration: BoxDecoration(
                                  color: theme.colorScheme.primary,
                                  borderRadius: BorderRadius.circular(14),
                                  boxShadow: [
                                    BoxShadow(
                                      color: theme.colorScheme.primary.withValues(alpha: 0.25),
                                      blurRadius: 18,
                                      offset: const Offset(0, 8),
                                    ),
                                  ],
                                ),
                                child: const Text('H', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w900)),
                              ),
                              const SizedBox(width: 12),
                              const Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text('Mój Hufiec', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w900)),
                                    Text('Aplikacja wychowawcy', style: TextStyle(color: Colors.black54)),
                                  ],
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 28),
                          const Text('Logowanie', style: TextStyle(fontSize: 28, fontWeight: FontWeight.w900)),
                          const SizedBox(height: 8),
                          const Text(
                            'Zaloguj się raz z internetem. Potem aplikacja zapisze dane do pracy w terenie.',
                            style: TextStyle(color: Colors.black54),
                          ),
                          const SizedBox(height: 24),
                          TextField(
                            controller: _email,
                            enabled: !_loading,
                            keyboardType: TextInputType.emailAddress,
                            textInputAction: TextInputAction.next,
                            autocorrect: false,
                            decoration: const InputDecoration(
                              labelText: 'E-mail',
                              prefixIcon: Icon(Icons.mail_outline),
                              border: OutlineInputBorder(),
                            ),
                          ),
                          const SizedBox(height: 14),
                          TextField(
                            controller: _password,
                            enabled: !_loading,
                            obscureText: !_passwordVisible,
                            enableSuggestions: false,
                            autocorrect: false,
                            textInputAction: TextInputAction.done,
                            onSubmitted: (_) => _loading ? null : _submit(),
                            decoration: InputDecoration(
                              labelText: 'Hasło',
                              prefixIcon: const Icon(Icons.lock_outline),
                              border: const OutlineInputBorder(),
                              suffixIcon: IconButton(
                                tooltip: _passwordVisible ? 'Ukryj hasło' : 'Pokaż hasło',
                                onPressed: _loading ? null : () => setState(() => _passwordVisible = !_passwordVisible),
                                icon: Icon(_passwordVisible ? Icons.visibility_off_outlined : Icons.visibility_outlined),
                              ),
                            ),
                          ),
                          const SizedBox(height: 10),
                          TextButton.icon(
                            onPressed: _loading ? null : () => setState(() => _showServerSettings = !_showServerSettings),
                            icon: Icon(_showServerSettings ? Icons.expand_less : Icons.tune),
                            label: const Text('Adres serwera'),
                          ),
                          AnimatedCrossFade(
                            duration: const Duration(milliseconds: 180),
                            crossFadeState: _showServerSettings ? CrossFadeState.showSecond : CrossFadeState.showFirst,
                            firstChild: const SizedBox.shrink(),
                            secondChild: Padding(
                              padding: const EdgeInsets.only(top: 4, bottom: 10),
                              child: TextField(
                                controller: _apiBaseUrl,
                                enabled: !_loading,
                                keyboardType: TextInputType.url,
                                autocorrect: false,
                                decoration: const InputDecoration(
                                  labelText: 'Adres API',
                                  helperText: 'Np. https://twoja-domena.pl',
                                  prefixIcon: Icon(Icons.public),
                                  border: OutlineInputBorder(),
                                ),
                              ),
                            ),
                          ),
                          if (_error != null) ...[
                            const SizedBox(height: 10),
                            Container(
                              padding: const EdgeInsets.all(14),
                              decoration: BoxDecoration(
                                color: theme.colorScheme.errorContainer,
                                borderRadius: BorderRadius.circular(16),
                              ),
                              child: Text(_error!, style: TextStyle(color: theme.colorScheme.onErrorContainer)),
                            ),
                          ],
                          const SizedBox(height: 18),
                          FilledButton(
                            onPressed: _loading ? null : _submit,
                            style: FilledButton.styleFrom(
                              minimumSize: const Size.fromHeight(54),
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
                            ),
                            child: _loading
                                ? const Row(
                                    mainAxisAlignment: MainAxisAlignment.center,
                                    children: [
                                      HufcLoader(size: 24, color: Colors.white),
                                      SizedBox(width: 12),
                                      Text('Logowanie...'),
                                    ],
                                  )
                                : const Text('Zaloguj się'),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class ShellScreen extends StatefulWidget {
  const ShellScreen({
    super.key,
    required this.session,
    required this.state,
    required this.online,
    required this.syncing,
    required this.queueCount,
    required this.onLogout,
    required this.onSync,
    required this.onMutate,
  });

  final AuthSession session;
  final AppState? state;
  final bool online;
  final bool syncing;
  final int queueCount;
  final VoidCallback onLogout;
  final Future<void> Function() onSync;
  final Future<void> Function(String url, Map<String, dynamic> body, AppState optimistic) onMutate;

  @override
  State<ShellScreen> createState() => _ShellScreenState();
}

class _ShellScreenState extends State<ShellScreen> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    final pages = [
      DashboardPage(session: widget.session, state: state, online: widget.online, queueCount: widget.queueCount),
      GamesPage(state: state, onMutate: widget.onMutate),
      CompetitionPage(state: state, onMutate: widget.onMutate),
      SyncPage(online: widget.online, syncing: widget.syncing, queueCount: widget.queueCount, onSync: widget.onSync, onLogout: widget.onLogout),
    ];
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.online ? 'Mój Hufiec' : 'Mój Hufiec - offline'),
        actions: [
          if (widget.syncing) const Padding(padding: EdgeInsets.all(14), child: HufcLoader(size: 22)),
          IconButton(onPressed: widget.onSync, icon: const Icon(Icons.sync)),
        ],
      ),
      body: AnimatedSwitcher(duration: const Duration(milliseconds: 220), child: pages[_tab]),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (value) => setState(() => _tab = value),
        destinations: [
          const NavigationDestination(icon: Icon(Icons.dashboard_outlined), selectedIcon: Icon(Icons.dashboard), label: 'Pulpit'),
          const NavigationDestination(icon: Icon(Icons.flag_outlined), selectedIcon: Icon(Icons.flag), label: 'Gry'),
          const NavigationDestination(icon: Icon(Icons.emoji_events_outlined), selectedIcon: Icon(Icons.emoji_events), label: 'Namioty'),
          NavigationDestination(
            icon: Badge(isLabelVisible: widget.queueCount > 0, label: Text('${widget.queueCount}'), child: const Icon(Icons.cloud_sync_outlined)),
            selectedIcon: Badge(isLabelVisible: widget.queueCount > 0, label: Text('${widget.queueCount}'), child: const Icon(Icons.cloud_sync)),
            label: 'Sync',
          ),
        ],
      ),
    );
  }
}

class DashboardPage extends StatelessWidget {
  const DashboardPage({super.key, required this.session, required this.state, required this.online, required this.queueCount});

  final AuthSession session;
  final AppState? state;
  final bool online;
  final int queueCount;

  @override
  Widget build(BuildContext context) {
    final game = state?.game;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        HufcHero(name: session.user.name, subtitle: online ? 'Połączono z serwerem' : 'Tryb offline - zapis lokalny'),
        const SizedBox(height: 16),
        StatCard(title: 'Aktywna gra', value: game?.name ?? 'Brak danych'),
        StatCard(title: 'Kolejka synchronizacji', value: queueCount == 0 ? 'Wszystko zapisane' : '$queueCount zmian czeka'),
        if (state == null) const EmptyNotice(text: 'Brak lokalnych danych. Zaloguj się raz z internetem, żeby pobrać bazę do telefonu.'),
      ],
    );
  }
}

class GamesPage extends StatefulWidget {
  const GamesPage({super.key, required this.state, required this.onMutate});

  final AppState? state;
  final Future<void> Function(String url, Map<String, dynamic> body, AppState optimistic) onMutate;

  @override
  State<GamesPage> createState() => _GamesPageState();
}

class _GamesPageState extends State<GamesPage> {
  Timer? _tick;
  int? _teamId;
  int? _stationId;
  int _points = 5;
  bool _correct = false;
  int _cooperation = 3;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && widget.state?.game.timerRunning == true) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  int _remaining(Game game) {
    if (!game.timerRunning) return game.remainingSeconds;
    final elapsed = DateTime.now().difference(game.timerUpdatedAt).inSeconds;
    return (game.remainingSeconds - elapsed).clamp(0, game.durationMinutes * 60);
  }

  Future<void> _timer(String command) async {
    final state = widget.state;
    if (state == null) return;
    final raw = _clone(state.raw);
    final game = Map<String, dynamic>.from(raw['game'] as Map);
    final left = _remaining(state.game);
    game['remaining_seconds'] = left;
    game['timer_updated_at'] = DateTime.now().toIso8601String();
    if (command == 'start') game['timer_running'] = true;
    if (command == 'pause') game['timer_running'] = false;
    if (command == 'reset') {
      game['timer_running'] = false;
      game['remaining_seconds'] = jsonInt(game['duration_minutes'], fallback: 90) * 60;
    }
    raw['game'] = game;
    await widget.onMutate('/api/timer', {'game_id': state.game.id, 'command': command}, AppState.fromJson(raw));
  }

  Future<void> _saveScore() async {
    final state = widget.state;
    final teamId = _teamId;
    final stationId = _stationId;
    if (state == null || teamId == null || stationId == null) return;
    final raw = _clone(state.raw);
    final scores = jsonList(raw['scores']);
    scores.removeWhere((score) => jsonInt(score['team_id']) == teamId && jsonInt(score['station_id']) == stationId);
    scores.add({'team_id': teamId, 'station_id': stationId, 'points': _points, 'correct': _correct, 'cooperation': _cooperation, 'finished_at': DateTime.now().toIso8601String()});
    raw['scores'] = scores;
    final teams = jsonList(raw['teams']);
    for (final team in teams) {
      final id = jsonInt(team['id']);
      team['total_points'] = scores.where((score) => jsonInt(score['team_id']) == id).fold<int>(0, (sum, score) => sum + jsonInt(score['points']));
    }
    raw['teams'] = teams;
    await widget.onMutate('/api/scores', {
      'game_id': state.game.id,
      'team_id': teamId,
      'station_id': stationId,
      'points': _points,
      'correct': _correct,
      'cooperation': _cooperation,
      'comment': 'Zapis z aplikacji mobilnej',
    }, AppState.fromJson(raw));
  }

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    if (state == null) return const EmptyNotice(text: 'Brak danych gry w telefonie.');
    final game = state.game;
    final teams = state.teams.where((team) => team.gameId == game.id).toList()..sort((a, b) => b.totalPoints.compareTo(a.totalPoints));
    final stations = state.stations.where((station) => station.gameId == game.id).toList()..sort((a, b) => a.order.compareTo(b.order));
    _teamId ??= teams.isNotEmpty ? teams.first.id : null;
    _stationId ??= stations.isNotEmpty ? stations.first.id : null;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(game.name, style: Theme.of(context).textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w900)),
        const SizedBox(height: 12),
        CardPanel(
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text(_formatSeconds(_remaining(game)), style: const TextStyle(fontSize: 68, fontWeight: FontWeight.w900, color: Color(0xFF1F5C36))),
            LinearProgressIndicator(value: (1 - (_remaining(game) / (game.durationMinutes * 60)).clamp(0, 1)).toDouble()),
            const SizedBox(height: 14),
            Wrap(spacing: 10, children: [
              FilledButton(onPressed: () => _timer('start'), child: const Text('Start')),
              OutlinedButton(onPressed: () => _timer('pause'), child: const Text('Pauza')),
              OutlinedButton(onPressed: () => _timer('reset'), child: const Text('Reset')),
            ]),
          ]),
        ),
        CardPanel(
          title: 'Ranking',
          child: Column(children: teams.map((team) => ListTile(title: Text(team.name), trailing: Text('${team.totalPoints} pkt', style: const TextStyle(fontWeight: FontWeight.w800)))).toList()),
        ),
        CardPanel(
          title: 'Ocena stacji',
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            DropdownButtonFormField<int>(initialValue: _teamId, items: teams.map((team) => DropdownMenuItem(value: team.id, child: Text(team.name))).toList(), onChanged: (value) => setState(() => _teamId = value), decoration: const InputDecoration(labelText: 'Drużyna')),
            const SizedBox(height: 10),
            DropdownButtonFormField<int>(initialValue: _stationId, items: stations.map((station) => DropdownMenuItem(value: station.id, child: Text(station.title))).toList(), onChanged: (value) => setState(() => _stationId = value), decoration: const InputDecoration(labelText: 'Stacja')),
            Slider(value: _points.toDouble(), min: 0, max: 10, divisions: 10, label: '$_points', onChanged: (value) => setState(() => _points = value.round())),
            Center(child: Text('$_points pkt', style: const TextStyle(fontSize: 34, fontWeight: FontWeight.w900))),
            SwitchListTile(value: _correct, onChanged: (value) => setState(() => _correct = value), title: const Text('Poprawna odpowiedź')),
            DropdownButtonFormField<int>(initialValue: _cooperation, items: [1, 2, 3, 4, 5].map((value) => DropdownMenuItem(value: value, child: Text('Współpraca $value/5'))).toList(), onChanged: (value) => setState(() => _cooperation = value ?? 3), decoration: const InputDecoration(labelText: 'Współpraca')),
            const SizedBox(height: 12),
            FilledButton(onPressed: _saveScore, child: const Text('Zapisz lokalnie')),
          ]),
        ),
      ],
    );
  }
}

class CompetitionPage extends StatefulWidget {
  const CompetitionPage({super.key, required this.state, required this.onMutate});

  final AppState? state;
  final Future<void> Function(String url, Map<String, dynamic> body, AppState optimistic) onMutate;

  @override
  State<CompetitionPage> createState() => _CompetitionPageState();
}

class _CompetitionPageState extends State<CompetitionPage> {
  int? _tentId;
  String _category = 'Porządek';
  int _points = 1;
  final _reason = TextEditingController();

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  Future<void> _addPoints() async {
    final state = widget.state;
    final tentId = _tentId;
    if (state == null || tentId == null || _reason.text.trim().isEmpty) return;
    final raw = _clone(state.raw);
    final tents = jsonList(raw['competition_tents']);
    final tent = tents.firstWhere((item) => jsonInt(item['id']) == tentId, orElse: () => <String, dynamic>{});
    tent['total_points'] = jsonInt(tent['total_points']) + _points;
    raw['competition_tents'] = tents;
    final points = jsonList(raw['competition_points']);
    points.insert(0, {'id': -DateTime.now().millisecondsSinceEpoch, 'tent_id': tentId, 'tent_name': jsonString(tent['name']), 'category': _category, 'points': _points, 'reason': _reason.text.trim()});
    raw['competition_points'] = points;
    await widget.onMutate('/api/competition/points', {'tent_id': tentId, 'category': _category, 'points': _points, 'reason': _reason.text.trim()}, AppState.fromJson(raw));
    _reason.clear();
  }

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    if (state == null) return const EmptyNotice(text: 'Brak danych współzawodnictwa w telefonie.');
    final tents = [...state.tents]..sort((a, b) => b.totalPoints.compareTo(a.totalPoints));
    _tentId ??= tents.isNotEmpty ? tents.first.id : null;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text('Współzawodnictwo', style: Theme.of(context).textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w900)),
        CardPanel(
          title: 'Ranking namiotów',
          child: Column(children: tents.map((tent) => ListTile(title: Text(tent.name), subtitle: Text('${tent.memberCount} osób'), trailing: Text('${tent.totalPoints} pkt', style: const TextStyle(fontWeight: FontWeight.w900)))).toList()),
        ),
        CardPanel(
          title: 'Dodaj punkty',
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            DropdownButtonFormField<int>(initialValue: _tentId, items: tents.map((tent) => DropdownMenuItem(value: tent.id, child: Text(tent.name))).toList(), onChanged: (value) => setState(() => _tentId = value), decoration: const InputDecoration(labelText: 'Namiot')),
            const SizedBox(height: 10),
            DropdownButtonFormField<String>(initialValue: _category, items: ['Porządek', 'Zachowanie', 'Aktywność', 'Dodatkowe'].map((value) => DropdownMenuItem(value: value, child: Text(value))).toList(), onChanged: (value) => setState(() => _category = value ?? 'Porządek'), decoration: const InputDecoration(labelText: 'Kategoria')),
            const SizedBox(height: 10),
            Row(children: [
              IconButton.filledTonal(onPressed: () => setState(() => _points--), icon: const Icon(Icons.remove)),
              Expanded(child: Center(child: Text('$_points pkt', style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w900)))),
              IconButton.filledTonal(onPressed: () => setState(() => _points++), icon: const Icon(Icons.add)),
            ]),
            const SizedBox(height: 10),
            TextField(controller: _reason, minLines: 2, maxLines: 3, decoration: const InputDecoration(labelText: 'Powód')),
            const SizedBox(height: 12),
            FilledButton(onPressed: _addPoints, child: const Text('Dodaj wpis')),
          ]),
        ),
        CardPanel(
          title: 'Historia punktów',
          child: Column(children: state.points.map((point) => ListTile(title: Text('${point.tentName} - ${point.category}'), subtitle: Text(point.reason), trailing: Text('${point.points > 0 ? '+' : ''}${point.points}'))).toList()),
        ),
      ],
    );
  }
}

class SyncPage extends StatelessWidget {
  const SyncPage({super.key, required this.online, required this.syncing, required this.queueCount, required this.onSync, required this.onLogout});

  final bool online;
  final bool syncing;
  final int queueCount;
  final Future<void> Function() onSync;
  final VoidCallback onLogout;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        CardPanel(
          title: 'Synchronizacja',
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text(online ? 'Internet jest dostępny' : 'Brak internetu'),
            Text(queueCount == 0 ? 'Nie ma zmian do wysłania' : '$queueCount zmian czeka lokalnie'),
            const SizedBox(height: 16),
            FilledButton(onPressed: syncing ? null : onSync, child: syncing ? const HufcLoader(size: 24, color: Colors.white) : const Text('Synchronizuj teraz')),
          ]),
        ),
        OutlinedButton(onPressed: onLogout, child: const Text('Wyloguj z telefonu')),
      ],
    );
  }
}

class HufcHero extends StatelessWidget {
  const HufcHero({super.key, required this.name, required this.subtitle});
  final String name;
  final String subtitle;
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(color: const Color(0xFF1F5C36), borderRadius: BorderRadius.circular(24)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(subtitle, style: const TextStyle(color: Colors.white70)),
        const SizedBox(height: 8),
        Text(name, style: const TextStyle(color: Colors.white, fontSize: 30, fontWeight: FontWeight.w900)),
      ]),
    );
  }
}

class CardPanel extends StatelessWidget {
  const CardPanel({super.key, this.title, required this.child});
  final String? title;
  final Widget child;
  @override
  Widget build(BuildContext context) {
    return Card(
      elevation: 0,
      margin: const EdgeInsets.only(top: 16),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (title != null) Text(title!, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w900)),
          if (title != null) const SizedBox(height: 12),
          child,
        ]),
      ),
    );
  }
}

class StatCard extends StatelessWidget {
  const StatCard({super.key, required this.title, required this.value});
  final String title;
  final String value;
  @override
  Widget build(BuildContext context) => CardPanel(title: title, child: Text(value, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)));
}

class EmptyNotice extends StatelessWidget {
  const EmptyNotice({super.key, required this.text});
  final String text;
  @override
  Widget build(BuildContext context) => Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(text, textAlign: TextAlign.center)));
}

class HufcLoader extends StatelessWidget {
  const HufcLoader({super.key, this.size = 40, this.color});
  final double size;
  final Color? color;
  @override
  Widget build(BuildContext context) {
    return SizedBox.square(
      dimension: size,
      child: CircularProgressIndicator(strokeWidth: size < 30 ? 3 : 4, color: color ?? const Color(0xFF1F5C36)),
    );
  }
}

Map<String, dynamic> _clone(Map<String, dynamic> raw) => jsonDecode(jsonEncode(raw)) as Map<String, dynamic>;

String _formatSeconds(int seconds) {
  final minutes = (seconds ~/ 60).toString().padLeft(2, '0');
  final secs = (seconds % 60).toString().padLeft(2, '0');
  return '$minutes:$secs';
}
