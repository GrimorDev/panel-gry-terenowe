import 'dart:async';
import 'dart:convert';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:image_picker/image_picker.dart';
import 'package:permission_handler/permission_handler.dart';

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

class _HufcMobileAppState extends State<HufcMobileApp> with WidgetsBindingObserver {
  final FlutterLocalNotificationsPlugin _notifications = FlutterLocalNotificationsPlugin();
  AuthSession? _session;
  AppState? _state;
  bool _booting = true;
  bool _online = false;
  bool _syncing = false;
  int _queueCount = 0;
  String _apiBaseUrl = ApiClient.defaultBaseUrl;
  ThemeMode _themeMode = ThemeMode.system;
  String _accentHex = '#1F5C36';
  bool _emailNotifications = true;
  bool _pushNotifications = false;
  bool _photoLocation = false;
  bool _notificationsReady = false;
  StreamSubscription<List<ConnectivityResult>>? _connectivitySubscription;
  Timer? _realtimeTimer;
  int _knownMessageId = 0;
  int _knownSessionId = 0;
  String? _pendingConversationKey;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _boot();
    _connectivitySubscription = Connectivity().onConnectivityChanged.listen((_) => _refreshOnline(sync: true, showNotifications: true));
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _connectivitySubscription?.cancel();
    _realtimeTimer?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(_recoverConnection(showNotifications: true));
      _startRealtimePolling();
    }
  }

  Future<void> _boot() async {
    final savedApiBaseUrl = await widget.store.get('api_base_url');
    final savedThemeMode = await widget.store.get('theme_mode');
    final savedAccent = await widget.store.get('accent_color');
    final savedEmailNotifications = await widget.store.get('notify_email');
    final savedPushNotifications = await widget.store.get('notify_push');
    final savedPhotoLocation = await widget.store.get('photo_location');
    if (savedApiBaseUrl != null) widget.api.setBaseUrl(savedApiBaseUrl);
    final auth = await widget.store.readAuth();
    final cached = await widget.store.readState();
    final online = await _isOnline();
    setState(() {
      _session = auth;
      _state = cached;
      _apiBaseUrl = widget.api.baseUrl;
      _online = online;
      _themeMode = _themeModeFromString(savedThemeMode);
      _accentHex = savedAccent ?? _accentHex;
      _emailNotifications = savedEmailNotifications != 'false';
      _pushNotifications = savedPushNotifications == 'true';
      _photoLocation = savedPhotoLocation == 'true';
      _booting = false;
    });
    await _refreshQueue();
    _updateRealtimeBaselines(cached);
    if (_pushNotifications) await _configureNotifications(request: false);
    if (auth != null && online) {
      await _sync(showNotifications: false);
      _startRealtimePolling();
    }
  }

  Future<bool> _isOnline() async {
    final result = await Connectivity().checkConnectivity();
    return !result.contains(ConnectivityResult.none);
  }

  Future<void> _refreshOnline({bool sync = false, bool showNotifications = false}) async {
    final online = await _isOnline();
    if (!mounted) return;
    if (!online) {
      setState(() => _online = false);
      return;
    }
    if (online && sync && _session != null) {
      await _sync(showNotifications: showNotifications);
    } else {
      setState(() => _online = true);
    }
  }

  Future<void> _recoverConnection({bool showNotifications = false}) async {
    if (_session == null) {
      await _refreshOnline();
      return;
    }
    final online = await _isOnline();
    if (!mounted) return;
    if (!online) {
      setState(() => _online = false);
      return;
    }
    await _sync(showNotifications: showNotifications);
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
    _updateRealtimeBaselines(state);
    _startRealtimePolling();
  }

  Future<void> _setApiBaseUrl(String value) async {
    widget.api.setBaseUrl(value);
    await widget.store.put('api_base_url', widget.api.baseUrl);
    if (!mounted) return;
    setState(() => _apiBaseUrl = widget.api.baseUrl);
  }

  Future<void> _setThemeMode(ThemeMode mode) async {
    await widget.store.put('theme_mode', mode.name);
    if (!mounted) return;
    setState(() => _themeMode = mode);
  }

  Future<void> _setAccentHex(String value) async {
    await widget.store.put('accent_color', value);
    if (!mounted) return;
    setState(() => _accentHex = value);
  }

  Future<void> _setEmailNotifications(bool value) async {
    await widget.store.put('notify_email', value.toString());
    if (!mounted) return;
    setState(() => _emailNotifications = value);
  }

  Future<void> _setPushNotifications(bool value) async {
    var enabled = value;
    if (value) {
      enabled = await _configureNotifications(request: true);
    }
    await widget.store.put('notify_push', enabled.toString());
    if (!mounted) return;
    setState(() => _pushNotifications = enabled);
  }

  Future<void> _setPhotoLocation(bool value) async {
    var enabled = value;
    if (value) {
      final status = await Permission.locationWhenInUse.request();
      enabled = status.isGranted || status.isLimited;
      if (!enabled && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Telefon nie pozwolił użyć lokalizacji. Włącz zgodę w ustawieniach systemu.')));
      }
    }
    await widget.store.put('photo_location', enabled.toString());
    if (!mounted) return;
    setState(() => _photoLocation = enabled);
  }

  Future<void> _logout() async {
    _realtimeTimer?.cancel();
    await widget.store.clearAuth();
    if (!mounted) return;
    setState(() => _session = null);
  }

  Future<void> _sync({bool showNotifications = false}) async {
    if (_session == null || _syncing) return;
    setState(() => _syncing = true);
    try {
      final latest = await SyncService(store: widget.store, api: widget.api).sync(_session!, gameId: _state?.game.id);
      if (latest != null) {
        if (showNotifications) await _notifyRealtimeChanges(latest);
        _updateRealtimeBaselines(latest);
        if (mounted) {
          setState(() {
            _state = latest;
            _online = true;
          });
        }
      } else if (mounted) {
        setState(() => _online = true);
      }
    } catch (_) {
      final hasNetwork = await _isOnline();
      if (mounted) setState(() => _online = hasNetwork);
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
    if (!_online) {
      await widget.store.enqueue(url, 'POST', body);
      await _refreshQueue();
      return;
    }
    unawaited(_sendMutationInBackground(url, body));
  }

  Future<void> _delete(String url, AppState optimistic) async {
    await _saveLocal(optimistic);
    if (_session == null) return;
    if (!_online) {
      await widget.store.enqueue(url, 'DELETE', {});
      await _refreshQueue();
      return;
    }
    unawaited(_sendDeleteInBackground(url));
  }

  Future<void> _sendMutationInBackground(String url, Map<String, dynamic> body) async {
    if (_session == null) return;
    try {
      final latest = await widget.api.postState(_session!.token, url, body);
      if (mounted && url != '/api/timer') await _saveLocal(latest);
    } catch (_) {
      await widget.store.enqueue(url, 'POST', body);
      final hasNetwork = await _isOnline();
      if (mounted) setState(() => _online = hasNetwork);
    } finally {
      await _refreshQueue();
    }
  }

  Future<bool> _configureNotifications({required bool request}) async {
    const android = AndroidInitializationSettings('@mipmap/ic_launcher');
    const ios = DarwinInitializationSettings();
    if (!_notificationsReady) {
      await _notifications.initialize(
        const InitializationSettings(android: android, iOS: ios),
        onDidReceiveNotificationResponse: _handleNotificationResponse,
      );
      _notificationsReady = true;
      final launchDetails = await _notifications.getNotificationAppLaunchDetails();
      final launchResponse = launchDetails?.notificationResponse;
      if ((launchDetails?.didNotificationLaunchApp ?? false) && launchResponse != null) {
        _handleNotificationResponse(launchResponse);
      }
    }
    if (!request) return true;
    final permission = await Permission.notification.request();
    final granted = permission.isGranted || permission.isLimited;
    if (!granted && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Telefon zablokował powiadomienia. Włącz zgodę w ustawieniach systemu.')));
    }
    return granted;
  }

  void _handleNotificationResponse(NotificationResponse response) {
    const prefix = 'conversation:';
    final payload = response.payload ?? '';
    if (!payload.startsWith(prefix)) return;
    final key = payload.substring(prefix.length);
    if (key.isEmpty || !mounted) return;
    setState(() => _pendingConversationKey = key);
    unawaited(_recoverConnection());
  }

  void _consumePendingConversation() {
    if (mounted) setState(() => _pendingConversationKey = null);
  }

  Future<void> _showLocalNotification(String title, String body, {String? payload}) async {
    if (!_pushNotifications) return;
    await _configureNotifications(request: false);
    const android = AndroidNotificationDetails(
      'moj_hufiec_realtime',
      'Mój Hufiec',
      channelDescription: 'Nowe wiadomości i zbiórki z systemu Mój Hufiec.',
      importance: Importance.high,
      priority: Priority.high,
    );
    const ios = DarwinNotificationDetails();
    final id = DateTime.now().millisecondsSinceEpoch.remainder(2147483647);
    await _notifications.show(id, title, body, const NotificationDetails(android: android, iOS: ios), payload: payload);
  }

  void _startRealtimePolling() {
    _realtimeTimer?.cancel();
    if (_session != null && !_syncing) unawaited(_recoverConnection(showNotifications: true));
    _realtimeTimer = Timer.periodic(const Duration(seconds: 12), (_) {
      if (_session != null && !_syncing) unawaited(_recoverConnection(showNotifications: true));
    });
  }

  void _updateRealtimeBaselines(AppState? state) {
    if (state == null) return;
    _knownMessageId = _maxPositiveId(jsonList(state.raw['messages']), _knownMessageId);
    _knownSessionId = _maxPositiveId(jsonList(state.raw['sessions']), _knownSessionId);
  }

  int _maxPositiveId(List<Map<String, dynamic>> items, int fallback) {
    var maxId = fallback;
    for (final item in items) {
      final id = jsonInt(item['id']);
      if (id > maxId) maxId = id;
    }
    return maxId;
  }

  Future<void> _notifyRealtimeChanges(AppState latest) async {
    if (!_pushNotifications || _session == null) return;
    final userId = _session!.user.id;
    final newMessages = jsonList(latest.raw['messages'])
        .where((item) => jsonInt(item['id']) > _knownMessageId && jsonInt(item['sender_id']) != userId)
        .toList()
      ..sort((a, b) => jsonInt(a['id']).compareTo(jsonInt(b['id'])));
    for (final message in newMessages.take(3)) {
      final sender = jsonString(message['sender_name'], fallback: 'Mój Hufiec');
      final body = jsonString(message['body'], fallback: jsonString(message['attachment_name'], fallback: 'Wysłano załącznik.'));
      final key = _conversationKeyForMessage(message, userId);
      await _showLocalNotification('Nowa wiadomość od $sender', body, payload: key == null ? null : 'conversation:$key');
    }

    final newSessions = jsonList(latest.raw['sessions'])
        .where((item) => jsonInt(item['id']) > _knownSessionId)
        .toList()
      ..sort((a, b) => jsonInt(a['id']).compareTo(jsonInt(b['id'])));
    for (final session in newSessions.take(2)) {
      final title = jsonString(session['title'], fallback: 'Zbiórka');
      final date = _shortDate(jsonString(session['session_date']));
      await _showLocalNotification('Nowa zbiórka: $title', date.isEmpty ? 'Dodano wydarzenie do harmonogramu.' : date);
    }
  }

  Future<void> _sendDeleteInBackground(String url) async {
    if (_session == null) return;
    try {
      final latest = await widget.api.deleteState(_session!.token, url);
      if (mounted) await _saveLocal(latest);
    } catch (_) {
      await widget.store.enqueue(url, 'DELETE', {});
      final hasNetwork = await _isOnline();
      if (mounted) setState(() => _online = hasNetwork);
    } finally {
      await _refreshQueue();
    }
  }

  @override
  Widget build(BuildContext context) {
    final accent = _colorFromHex(_accentHex);
    return MaterialApp(
      title: 'Mój Hufiec',
      debugShowCheckedModeBanner: false,
      theme: _appTheme(brightness: Brightness.light, accent: accent),
      darkTheme: _appTheme(brightness: Brightness.dark, accent: accent),
      themeMode: _themeMode,
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
                  apiBaseUrl: _apiBaseUrl,
                  online: _online,
                  syncing: _syncing,
                  queueCount: _queueCount,
                  onLogout: _logout,
                  onSync: _sync,
                  onMutate: _mutate,
                  onDelete: _delete,
                  themeMode: _themeMode,
                  accentHex: _accentHex,
                  emailNotifications: _emailNotifications,
                  pushNotifications: _pushNotifications,
                  photoLocation: _photoLocation,
                  onThemeModeChanged: _setThemeMode,
                  onAccentChanged: _setAccentHex,
                  onEmailNotificationsChanged: _setEmailNotifications,
                  onPushNotificationsChanged: _setPushNotifications,
                  onPhotoLocationChanged: _setPhotoLocation,
                  openConversationKey: _pendingConversationKey,
                  onOpenConversationConsumed: _consumePendingConversation,
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
                          const Row(
                            children: [
                              _BrandLogoMark(size: 42),
                              SizedBox(width: 12),
                              Expanded(
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
    required this.apiBaseUrl,
    required this.online,
    required this.syncing,
    required this.queueCount,
    required this.onLogout,
    required this.onSync,
    required this.onMutate,
    required this.onDelete,
    required this.themeMode,
    required this.accentHex,
    required this.emailNotifications,
    required this.pushNotifications,
    required this.photoLocation,
    required this.onThemeModeChanged,
    required this.onAccentChanged,
    required this.onEmailNotificationsChanged,
    required this.onPushNotificationsChanged,
    required this.onPhotoLocationChanged,
    this.openConversationKey,
    required this.onOpenConversationConsumed,
  });

  final AuthSession session;
  final AppState? state;
  final String apiBaseUrl;
  final bool online;
  final bool syncing;
  final int queueCount;
  final VoidCallback onLogout;
  final Future<void> Function() onSync;
  final Future<void> Function(String url, Map<String, dynamic> body, AppState optimistic) onMutate;
  final Future<void> Function(String url, AppState optimistic) onDelete;
  final ThemeMode themeMode;
  final String accentHex;
  final bool emailNotifications;
  final bool pushNotifications;
  final bool photoLocation;
  final ValueChanged<ThemeMode> onThemeModeChanged;
  final ValueChanged<String> onAccentChanged;
  final ValueChanged<bool> onEmailNotificationsChanged;
  final ValueChanged<bool> onPushNotificationsChanged;
  final ValueChanged<bool> onPhotoLocationChanged;
  final String? openConversationKey;
  final VoidCallback onOpenConversationConsumed;

  @override
  State<ShellScreen> createState() => _ShellScreenState();
}

class _ShellScreenState extends State<ShellScreen> {
  int _tab = 0;
  bool _chatFocused = false;
  final _scaffoldKey = GlobalKey<ScaffoldState>();

  @override
  void initState() {
    super.initState();
    if (widget.openConversationKey != null) {
      _tab = 5;
      _chatFocused = true;
    }
  }

  @override
  void didUpdateWidget(covariant ShellScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.openConversationKey != null && widget.openConversationKey != oldWidget.openConversationKey) {
      setState(() {
        _tab = 5;
        _chatFocused = true;
      });
    }
  }

  void _selectTab(int index) {
    setState(() {
      _tab = index;
      _chatFocused = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    final pages = <_MobilePage>[
      _MobilePage('Pulpit', Icons.dashboard_outlined, Icons.dashboard, DashboardPage(session: widget.session, state: state, online: widget.online, queueCount: widget.queueCount)),
      _MobilePage('Podopieczni', Icons.person_outline, Icons.person, WardsPage(state: state, session: widget.session, onMutate: widget.onMutate, onDelete: widget.onDelete)),
      _MobilePage('Grupy', Icons.groups_outlined, Icons.groups, GroupsPage(state: state)),
      _MobilePage('Zbiórki', Icons.calendar_month_outlined, Icons.calendar_month, MeetingsPage(state: state, onMutate: widget.onMutate, onDelete: widget.onDelete)),
      _MobilePage('Galeria', Icons.photo_library_outlined, Icons.photo_library, MobileGalleryPage(state: state, session: widget.session, apiBaseUrl: widget.apiBaseUrl, onMutate: widget.onMutate)),
      _MobilePage('Wiadomości', Icons.chat_bubble_outline, Icons.chat_bubble, MessagesPage(state: state, session: widget.session, apiBaseUrl: widget.apiBaseUrl, onMutate: widget.onMutate, onConversationModeChanged: (value) => setState(() => _chatFocused = value), openConversationKey: widget.openConversationKey, onOpenConversationConsumed: widget.onOpenConversationConsumed)),
      _MobilePage('Gry', Icons.flag_outlined, Icons.flag, GamesPage(state: state, onMutate: widget.onMutate)),
      _MobilePage('Współzawodnictwo', Icons.emoji_events_outlined, Icons.emoji_events, CompetitionPage(state: state, onMutate: widget.onMutate, onDelete: widget.onDelete)),
      _MobilePage('Sync', Icons.cloud_sync_outlined, Icons.cloud_sync, SyncPage(online: widget.online, syncing: widget.syncing, queueCount: widget.queueCount, onSync: widget.onSync, onLogout: widget.onLogout)),
      _MobilePage('Ustawienia', Icons.settings_outlined, Icons.settings, SettingsPage(session: widget.session, apiBaseUrl: widget.apiBaseUrl, queueCount: widget.queueCount, themeMode: widget.themeMode, accentHex: widget.accentHex, emailNotifications: widget.emailNotifications, pushNotifications: widget.pushNotifications, photoLocation: widget.photoLocation, onThemeModeChanged: widget.onThemeModeChanged, onAccentChanged: widget.onAccentChanged, onEmailNotificationsChanged: widget.onEmailNotificationsChanged, onPushNotificationsChanged: widget.onPushNotificationsChanged, onPhotoLocationChanged: widget.onPhotoLocationChanged, onLogout: widget.onLogout, onSync: widget.onSync)),
    ];
    final bottomDestinations = [0, 3, 5, 4, 9];
    final bottomIndex = bottomDestinations.contains(_tab) ? bottomDestinations.indexOf(_tab) : 4;
    return Scaffold(
      key: _scaffoldKey,
      drawer: _MobileDrawer(
        pages: pages,
        currentIndex: _tab,
        session: widget.session,
        queueCount: widget.queueCount,
        onLogout: widget.onLogout,
        onSelect: _selectTab,
      ),
      appBar: _chatFocused ? null : AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(pages[_tab].label, style: const TextStyle(fontWeight: FontWeight.w900)),
            Text(widget.online ? 'Połączono z serwerem' : 'Tryb offline', style: const TextStyle(fontSize: 12)),
          ],
        ),
        actions: [
          if (widget.syncing) const Padding(padding: EdgeInsets.all(14), child: HufcLoader(size: 22)),
          IconButton(onPressed: widget.syncing ? null : () => widget.onSync(), icon: const Icon(Icons.sync)),
        ],
      ),
      body: AnimatedSwitcher(
        duration: const Duration(milliseconds: 220),
        switchInCurve: Curves.easeOutCubic,
        switchOutCurve: Curves.easeInCubic,
        child: KeyedSubtree(key: ValueKey(_tab), child: pages[_tab].child),
      ),
      bottomNavigationBar: _chatFocused ? null : NavigationBar(
        selectedIndex: bottomIndex,
        onDestinationSelected: (value) {
          _selectTab(bottomDestinations[value]);
        },
        destinations: [
          NavigationDestination(icon: Icon(pages[0].icon), selectedIcon: Icon(pages[0].selectedIcon), label: pages[0].label),
          NavigationDestination(icon: Icon(pages[3].icon), selectedIcon: Icon(pages[3].selectedIcon), label: pages[3].label),
          NavigationDestination(icon: Icon(pages[5].icon), selectedIcon: Icon(pages[5].selectedIcon), label: pages[5].label),
          NavigationDestination(icon: Icon(pages[4].icon), selectedIcon: Icon(pages[4].selectedIcon), label: pages[4].label),
          NavigationDestination(icon: Icon(pages[9].icon), selectedIcon: Icon(pages[9].selectedIcon), label: pages[9].label),
        ],
      ),
    );
  }
}

class _MobileDrawer extends StatelessWidget {
  const _MobileDrawer({
    required this.pages,
    required this.currentIndex,
    required this.session,
    required this.queueCount,
    required this.onSelect,
    required this.onLogout,
  });

  final List<_MobilePage> pages;
  final int currentIndex;
  final AuthSession session;
  final int queueCount;
  final ValueChanged<int> onSelect;
  final VoidCallback onLogout;

  @override
  Widget build(BuildContext context) {
    const drawerColor = Color(0xFF123D25);
    return Drawer(
      width: 292,
      backgroundColor: drawerColor,
      child: SafeArea(
        child: Column(
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 14, 16, 22),
              child: Row(
                children: [
                  _BrandLogoMark(size: 42),
                  SizedBox(width: 12),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('Mój Hufiec', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w900, fontSize: 16)),
                      Text('Panel wychowawcy', style: TextStyle(color: Colors.white70, fontSize: 12)),
                    ]),
                  ),
                ],
              ),
            ),
            Expanded(
              child: ListView.builder(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                itemCount: pages.length,
                itemBuilder: (context, index) {
                  final page = pages[index];
                  final selected = currentIndex == index;
                  return Padding(
                    padding: const EdgeInsets.only(bottom: 6),
                    child: ListTile(
                      selected: selected,
                      selectedTileColor: Colors.white.withValues(alpha: 0.14),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: selected ? BorderSide(color: Colors.white.withValues(alpha: 0.28)) : BorderSide.none),
                      leading: Icon(selected ? page.selectedIcon : page.icon, color: selected ? Colors.white : Colors.white70),
                      title: Text(page.label, style: TextStyle(color: selected ? Colors.white : Colors.white70, fontWeight: FontWeight.w900)),
                      trailing: page.label == 'Sync' && queueCount > 0 ? Badge(label: Text('$queueCount')) : null,
                      onTap: () {
                        Navigator.of(context).pop();
                        onSelect(index);
                      },
                    ),
                  );
                },
              ),
            ),
            const Divider(color: Colors.white24),
            ListTile(
              leading: _Initials(text: session.user.name),
              title: Text(session.user.name, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w900)),
              subtitle: Text(session.user.role, style: const TextStyle(color: Colors.white70)),
            ),
            ListTile(
              leading: const Icon(Icons.logout, color: Colors.white70),
              title: const Text('Wyloguj się', style: TextStyle(color: Colors.white70, fontWeight: FontWeight.w900)),
              onTap: onLogout,
            ),
            const SizedBox(height: 10),
          ],
        ),
      ),
    );
  }
}

class _MobilePage {
  const _MobilePage(this.label, this.icon, this.selectedIcon, this.child);

  final String label;
  final IconData icon;
  final IconData selectedIcon;
  final Widget child;
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
    final wards = state == null ? <Map<String, dynamic>>[] : jsonList(state!.raw['wards']);
    final groups = state == null ? <Map<String, dynamic>>[] : jsonList(state!.raw['cohorts']);
    final sessions = state == null ? <Map<String, dynamic>>[] : jsonList(state!.raw['sessions']);
    final messages = state == null ? <Map<String, dynamic>>[] : jsonList(state!.raw['messages']);
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        HufcHero(name: session.user.name, subtitle: online ? 'Połączono z serwerem' : 'Tryb offline - zapis lokalny'),
        const SizedBox(height: 16),
        Row(children: [
          Expanded(child: _MetricTile(label: 'Dzieci', value: '${wards.length}', icon: Icons.person_outline)),
          const SizedBox(width: 10),
          Expanded(child: _MetricTile(label: 'Grupy', value: '${groups.length}', icon: Icons.groups_outlined)),
          const SizedBox(width: 10),
          Expanded(child: _MetricTile(label: 'Wiadomości', value: '${messages.length}', icon: Icons.chat_bubble_outline)),
        ]),
        const SizedBox(height: 12),
        _InfoBlock(title: 'Aktywna gra', value: game?.name ?? 'Brak danych', icon: Icons.flag_outlined),
        const SizedBox(height: 12),
        _InfoBlock(title: 'Kolejka synchronizacji', value: queueCount == 0 ? 'Wszystko zapisane' : '$queueCount zmian czeka', icon: Icons.sync_outlined),
        CardPanel(
          title: 'Nadchodzące zbiórki',
          child: Column(
            children: [
              if (sessions.isEmpty) const EmptyNotice(text: 'Brak zaplanowanych zbiórek w pamięci telefonu.'),
              for (final item in sessions.take(3))
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: Row(children: [
                    Expanded(child: Text(jsonString(item['title'], fallback: 'Zbiórka'), style: const TextStyle(fontWeight: FontWeight.w900))),
                    Text(_shortDate(jsonString(item['session_date']))),
                  ]),
                ),
            ],
          ),
        ),
        if (state == null) const EmptyNotice(text: 'Brak lokalnych danych. Zaloguj się raz z internetem, żeby pobrać bazę do telefonu.'),
      ],
    );
  }
}

class SettingsPage extends StatefulWidget {
  const SettingsPage({
    super.key,
    required this.session,
    required this.apiBaseUrl,
    required this.queueCount,
    required this.themeMode,
    required this.accentHex,
    required this.emailNotifications,
    required this.pushNotifications,
    required this.photoLocation,
    required this.onThemeModeChanged,
    required this.onAccentChanged,
    required this.onEmailNotificationsChanged,
    required this.onPushNotificationsChanged,
    required this.onPhotoLocationChanged,
    required this.onLogout,
    required this.onSync,
  });

  final AuthSession session;
  final String apiBaseUrl;
  final int queueCount;
  final ThemeMode themeMode;
  final String accentHex;
  final bool emailNotifications;
  final bool pushNotifications;
  final bool photoLocation;
  final ValueChanged<ThemeMode> onThemeModeChanged;
  final ValueChanged<String> onAccentChanged;
  final ValueChanged<bool> onEmailNotificationsChanged;
  final ValueChanged<bool> onPushNotificationsChanged;
  final ValueChanged<bool> onPhotoLocationChanged;
  final VoidCallback onLogout;
  final Future<void> Function() onSync;

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  final _currentPassword = TextEditingController();
  final _newPassword = TextEditingController();
  int _tab = 0;

  @override
  void dispose() {
    _currentPassword.dispose();
    _newPassword.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tabs = ['Profil', 'Wygląd', 'Powiadomienia', 'Konto'];
    return HufcPage(
      title: 'Ustawienia',
      subtitle: 'Konto, wygląd aplikacji, powiadomienia i praca offline.',
      children: [
        CardPanel(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(
                  children: [
                    for (var index = 0; index < tabs.length; index++)
                      Padding(
                        padding: const EdgeInsets.only(right: 8),
                        child: ChoiceChip(
                          label: Text(tabs[index]),
                          selected: _tab == index,
                          onSelected: (_) => setState(() => _tab = index),
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: 18),
              AnimatedSwitcher(
                duration: const Duration(milliseconds: 180),
                child: KeyedSubtree(
                  key: ValueKey(_tab),
                  child: switch (_tab) {
                    0 => _profileTab(context),
                    1 => _appearanceTab(context),
                    2 => _notificationsTab(context),
                    _ => _accountTab(context),
                  },
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _profileTab(BuildContext context) {
    final user = widget.session.user;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [
        _Initials(text: user.name),
        const SizedBox(width: 12),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(user.name, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w900)),
          Text(user.role, style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)),
        ])),
      ]),
      const SizedBox(height: 18),
      _ReadonlyField(label: 'Imię i nazwisko', value: user.name),
      const SizedBox(height: 10),
      _ReadonlyField(label: 'E-mail', value: user.email),
      const SizedBox(height: 10),
      _ReadonlyField(label: 'Serwer', value: widget.apiBaseUrl),
      const SizedBox(height: 12),
      Text('Zmiany profilu są zapisywane w panelu webowym i pobierane przy synchronizacji.', style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)),
    ]);
  }

  Widget _appearanceTab(BuildContext context) {
    final accents = ['#1F5C36', '#D86F45', '#F7F3EC', '#0B1E14'];
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text('Tryb aplikacji', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w900)),
      const SizedBox(height: 10),
      SegmentedButton<ThemeMode>(
        segments: const [
          ButtonSegment(value: ThemeMode.system, label: Text('Auto')),
          ButtonSegment(value: ThemeMode.light, label: Text('Jasny')),
          ButtonSegment(value: ThemeMode.dark, label: Text('Ciemny')),
        ],
        selected: {widget.themeMode},
        onSelectionChanged: (value) => widget.onThemeModeChanged(value.first),
      ),
      const SizedBox(height: 18),
      Text('Kolor akcentu', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w900)),
      const SizedBox(height: 10),
      Wrap(
        spacing: 10,
        children: [
          for (final accent in accents)
            InkWell(
              onTap: () => widget.onAccentChanged(accent),
              borderRadius: BorderRadius.circular(14),
              child: Container(
                width: 46,
                height: 46,
                decoration: BoxDecoration(
                  color: _colorFromHex(accent),
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(color: widget.accentHex == accent ? Theme.of(context).colorScheme.onSurface : Colors.white54, width: widget.accentHex == accent ? 3 : 1),
                ),
              ),
            ),
        ],
      ),
    ]);
  }

  Widget _notificationsTab(BuildContext context) {
    return Column(children: [
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: const Text('E-mail', style: TextStyle(fontWeight: FontWeight.w900)),
        subtitle: const Text('Podsumowania i przypomnienia po podpięciu SMTP.'),
        value: widget.emailNotifications,
        onChanged: widget.onEmailNotificationsChanged,
      ),
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: const Text('Powiadomienia push', style: TextStyle(fontWeight: FontWeight.w900)),
        subtitle: const Text('Aplikacja zapamięta zgodę i użyje jej przy obsłudze push.'),
        value: widget.pushNotifications,
        onChanged: widget.onPushNotificationsChanged,
      ),
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: const Text('Lokalizacja do zdjęć', style: TextStyle(fontWeight: FontWeight.w900)),
        subtitle: const Text('Pozwala dopisywać miejsce wykonania zdjęcia.'),
        value: widget.photoLocation,
        onChanged: widget.onPhotoLocationChanged,
      ),
    ]);
  }

  Widget _accountTab(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      TextField(controller: _currentPassword, obscureText: true, decoration: const InputDecoration(labelText: 'Aktualne hasło')),
      const SizedBox(height: 10),
      TextField(controller: _newPassword, obscureText: true, decoration: const InputDecoration(labelText: 'Nowe hasło')),
      const SizedBox(height: 12),
      FilledButton(
        onPressed: () {
          _currentPassword.clear();
          _newPassword.clear();
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Zmiana hasła wymaga potwierdzenia przez serwer.')));
        },
        child: const Text('Zmień hasło'),
      ),
      const SizedBox(height: 12),
      OutlinedButton(onPressed: widget.onLogout, child: const Text('Wyloguj się')),
      const SizedBox(height: 12),
      Text('Kolejka synchronizacji: ${widget.queueCount == 0 ? 'wszystko zapisane' : '${widget.queueCount} zmian czeka'}'),
    ]);
  }
}

class _ReadonlyField extends StatelessWidget {
  const _ReadonlyField({required this.label, required this.value});
  final String label;
  final String value;
  @override
  Widget build(BuildContext context) {
    return TextFormField(
      initialValue: value,
      readOnly: true,
      decoration: InputDecoration(labelText: label),
    );
  }
}


class WardsPage extends StatelessWidget {
  const WardsPage({super.key, required this.state, required this.session, required this.onMutate, required this.onDelete});
  final AppState? state;
  final AuthSession session;
  final Future<void> Function(String url, Map<String, dynamic> body, AppState optimistic) onMutate;
  final Future<void> Function(String url, AppState optimistic) onDelete;

  Map<int, Map<String, dynamic>> _groupsById(AppState state) {
    return {for (final item in jsonList(state.raw['cohorts'])) jsonInt(item['id']): item};
  }

  String _groupName(Map<int, Map<String, dynamic>> groups, int id) {
    return jsonString(groups[id]?['name'], fallback: 'Bez grupy');
  }

  bool _canManageWard(Map<String, dynamic> ward, Map<int, Map<String, dynamic>> groups) {
    if (session.user.isAdmin) return true;
    final cohort = groups[jsonInt(ward['cohort_id'])];
    return jsonInt(cohort?['caretaker_user_id']) == session.user.id;
  }

  int _nextLocalId(List<Map<String, dynamic>> items) {
    return items.fold<int>(0, (max, item) => jsonInt(item['id']) > max ? jsonInt(item['id']) : max) + 1;
  }

  void _showDetails(BuildContext context, Map<String, dynamic> ward, String groupName) {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 6, 20, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(children: [
                _Initials(text: jsonString(ward['name'], fallback: 'P')),
                const SizedBox(width: 12),
                Expanded(child: Text(jsonString(ward['name'], fallback: 'Podopieczny'), style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w900))),
              ]),
              const SizedBox(height: 18),
              _DetailRow(label: 'Wiek', value: '${jsonInt(ward['age'])} lat'),
              _DetailRow(label: 'Grupa', value: groupName),
              _DetailRow(label: 'Rodzic / opiekun', value: jsonString(ward['parent_name'], fallback: 'Brak danych')),
              _DetailRow(label: 'Kontakt', value: jsonString(ward['parent_phone'], fallback: 'Brak telefonu')),
              const SizedBox(height: 12),
              Align(alignment: Alignment.centerRight, child: FilledButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Zamknij'))),
            ],
          ),
        ),
      ),
    );
  }

  void _openEditor(BuildContext context, {Map<String, dynamic>? ward}) {
    final state = this.state;
    if (state == null) return;
    final groups = _groupsById(state);
    final groupList = groups.values.toList();
    final existing = ward != null;
    var saving = false;
    var selectedCohortId = existing ? jsonInt(ward['cohort_id']) : (groupList.isNotEmpty ? jsonInt(groupList.first['id']) : 0);
    final name = TextEditingController(text: jsonString(ward?['name']));
    final age = TextEditingController(text: existing ? '${jsonInt(ward?['age'], fallback: 12)}' : '12');
    final parent = TextEditingController(text: jsonString(ward?['parent_name']));
    final contact = TextEditingController(text: jsonString(ward?['parent_phone'], fallback: jsonString(ward?['contact'])));

    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (context) => StatefulBuilder(
        builder: (context, setModalState) => SafeArea(
          child: SingleChildScrollView(
            padding: EdgeInsets.fromLTRB(20, 6, 20, MediaQuery.of(context).viewInsets.bottom + 24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(children: [
                  Expanded(child: Text(existing ? 'Edytuj podopiecznego' : 'Dodaj podopiecznego', style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w900))),
                  OutlinedButton(onPressed: saving ? null : () => Navigator.of(context).pop(), child: const Text('Zamknij')),
                ]),
                const SizedBox(height: 14),
                TextField(controller: name, textInputAction: TextInputAction.next, decoration: const InputDecoration(labelText: 'Imię i nazwisko')),
                const SizedBox(height: 10),
                TextField(controller: age, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Wiek')),
                const SizedBox(height: 10),
                TextField(controller: parent, textInputAction: TextInputAction.next, decoration: const InputDecoration(labelText: 'Rodzic / opiekun')),
                const SizedBox(height: 10),
                TextField(controller: contact, keyboardType: TextInputType.phone, decoration: const InputDecoration(labelText: 'Kontakt')),
                const SizedBox(height: 10),
                DropdownButtonFormField<int>(
                  initialValue: selectedCohortId == 0 ? null : selectedCohortId,
                  decoration: const InputDecoration(labelText: 'Grupa'),
                  items: [
                    const DropdownMenuItem<int>(value: 0, child: Text('Bez grupy')),
                    for (final group in groupList) DropdownMenuItem<int>(value: jsonInt(group['id']), child: Text(jsonString(group['name'], fallback: 'Grupa'))),
                  ],
                  onChanged: saving ? null : (value) => selectedCohortId = value ?? 0,
                ),
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: saving
                      ? null
                      : () async {
                          final cleanName = name.text.trim();
                          if (cleanName.isEmpty) {
                            ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Podaj imię i nazwisko podopiecznego.')));
                            return;
                          }
                          setModalState(() => saving = true);
                          final raw = _clone(state.raw);
                          final wards = jsonList(raw['wards']);
                          final id = existing ? jsonInt(ward['id']) : _nextLocalId(wards);
                          final next = {
                            ...(ward ?? <String, dynamic>{}),
                            'id': id,
                            'name': cleanName,
                            'age': jsonInt(age.text, fallback: 12),
                            'parent_name': parent.text.trim(),
                            'contact': contact.text.trim(),
                            'parent_phone': contact.text.trim(),
                            'cohort_id': selectedCohortId == 0 ? null : selectedCohortId,
                            'cohort_name': _groupName(groups, selectedCohortId),
                          };
                          raw['wards'] = existing ? wards.map((item) => jsonInt(item['id']) == id ? next : item).toList() : [next, ...wards];
                          await onMutate('/api/wards', {
                            if (existing) 'id': id,
                            'name': cleanName,
                            'age': jsonInt(age.text, fallback: 12),
                            'parent_name': parent.text.trim(),
                            'contact': contact.text.trim(),
                            'cohort_id': selectedCohortId == 0 ? null : selectedCohortId,
                            'game_id': state.game.id,
                          }, state.copyWithRaw(raw));
                          if (context.mounted) Navigator.of(context).pop();
                        },
                  child: saving ? const HufcLoader(size: 22, color: Colors.white) : const Text('Zapisz'),
                ),
                if (existing) ...[
                  const SizedBox(height: 18),
                  const Divider(),
                  const SizedBox(height: 8),
                  Text('Usunięcie podopiecznego', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w900)),
                  const SizedBox(height: 4),
                  Text('Ta akcja usunie osobę z listy i historii przypisań w panelu.', style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)),
                  const SizedBox(height: 10),
                  OutlinedButton(
                    onPressed: saving
                        ? null
                        : () async {
                            setModalState(() => saving = true);
                            final raw = _clone(state.raw);
                            raw['wards'] = jsonList(raw['wards']).where((item) => jsonInt(item['id']) != jsonInt(ward['id'])).toList();
                            await onDelete('/api/wards/${jsonInt(ward['id'])}?gameId=${state.game.id}', state.copyWithRaw(raw));
                            if (context.mounted) Navigator.of(context).pop();
                          },
                    child: const Text('Usuń podopiecznego'),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (state == null) return const EmptyNotice(text: 'Brak listy podopiecznych w telefonie.');
    final wards = jsonList(state!.raw['wards']);
    final groups = _groupsById(state!);
    return HufcPage(
      title: 'Podopieczni',
      subtitle: 'Lista osób pod opieką, dostępna także offline.',
      actions: [
        if (session.user.isAdmin)
          FilledButton.icon(
            onPressed: () => _openEditor(context),
            icon: const Icon(Icons.add),
            label: const Text('Dodaj podopiecznego'),
          ),
      ],
      children: [
        if (wards.isEmpty) const EmptyNotice(text: 'Nie ma jeszcze podopiecznych.'),
        for (final ward in wards)
          HufcListCard(
            onTap: () => _canManageWard(ward, groups) ? _openEditor(context, ward: ward) : _showDetails(context, ward, _groupName(groups, jsonInt(ward['cohort_id']))),
            leading: _Initials(text: jsonString(ward['name'], fallback: 'P')),
            title: jsonString(ward['name'], fallback: 'Podopieczny'),
            subtitle: '${jsonInt(ward['age'])} lat - ${_groupName(groups, jsonInt(ward['cohort_id']))} - ${jsonString(ward['parent_name'], fallback: 'brak opiekuna')}',
            trailing: Icon(_canManageWard(ward, groups) ? Icons.edit_outlined : Icons.chevron_right),
          ),
      ],
    );
  }
}

class GroupsPage extends StatelessWidget {
  const GroupsPage({super.key, required this.state});
  final AppState? state;

  @override
  Widget build(BuildContext context) {
    if (state == null) return const EmptyNotice(text: 'Brak grup w telefonie.');
    final groups = jsonList(state!.raw['cohorts']);
    final wards = jsonList(state!.raw['wards']);
    return HufcPage(
      title: 'Grupy',
      subtitle: 'Roczniki, drużyny i przypisani wychowawcy.',
      children: [
        for (final group in groups)
          CardPanel(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(child: Text(jsonString(group['name'], fallback: 'Grupa'), style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w900))),
                Text('${jsonInt(group['ward_count'])} osób'),
              ]),
              const SizedBox(height: 6),
              Text('Wychowawca: ${jsonString(group['caretaker_user_name'], fallback: jsonString(group['caretaker'], fallback: 'Bez opiekuna'))}'),
              const SizedBox(height: 10),
              Text(
                wards.where((ward) => jsonInt(ward['cohort_id']) == jsonInt(group['id'])).map((ward) => jsonString(ward['name'])).where((name) => name.isNotEmpty).join(', ').isEmpty
                    ? 'Brak podopiecznych w tej grupie.'
                    : wards.where((ward) => jsonInt(ward['cohort_id']) == jsonInt(group['id'])).map((ward) => jsonString(ward['name'])).where((name) => name.isNotEmpty).join(', '),
                style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant),
              ),
            ]),
          ),
      ],
    );
  }
}

class MeetingsPage extends StatelessWidget {
  const MeetingsPage({super.key, required this.state, required this.onMutate, required this.onDelete});
  final AppState? state;
  final Future<void> Function(String url, Map<String, dynamic> body, AppState optimistic) onMutate;
  final Future<void> Function(String url, AppState optimistic) onDelete;

  void _openEditor(BuildContext context, Map<String, dynamic> session) {
    final state = this.state;
    if (state == null) return;
    final title = TextEditingController(text: jsonString(session['title']));
    final date = TextEditingController(text: _dateInput(jsonString(session['session_date'])));
    final location = TextEditingController(text: jsonString(session['location']));
    final planned = TextEditingController(text: '${jsonInt(session['planned_count'], fallback: jsonInt(session['total']))}');
    var saving = false;
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (context) => StatefulBuilder(
        builder: (context, setModalState) => Padding(
          padding: EdgeInsets.fromLTRB(20, 6, 20, MediaQuery.of(context).viewInsets.bottom + 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(jsonInt(session['id']) > 0 ? 'Edytuj zbiórkę' : 'Zaplanuj zbiórkę', style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w900)),
              const SizedBox(height: 14),
              TextField(controller: title, decoration: const InputDecoration(labelText: 'Tytuł')),
              const SizedBox(height: 10),
              TextField(controller: date, keyboardType: TextInputType.datetime, decoration: const InputDecoration(labelText: 'Data')),
              const SizedBox(height: 10),
              TextField(controller: location, decoration: const InputDecoration(labelText: 'Lokalizacja')),
              const SizedBox(height: 10),
              TextField(controller: planned, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Planowana liczba osób')),
              const SizedBox(height: 16),
              FilledButton(
                onPressed: saving
                    ? null
                    : () async {
                        setModalState(() => saving = true);
                        final raw = Map<String, dynamic>.from(state.raw);
                        final sessions = jsonList(raw['sessions']);
                        final next = {
                          ...session,
                          'title': title.text.trim(),
                          'session_date': date.text.trim(),
                          'location': location.text.trim(),
                          'planned_count': jsonInt(planned.text),
                          'total': jsonInt(planned.text),
                          'present_count': _sessionPresent(session),
                          'attendance': _sessionPresent(session),
                        };
                        raw['sessions'] = sessions.map((item) => jsonInt(item['id']) == jsonInt(session['id']) ? next : item).toList();
                        await onMutate('/api/sessions', {
                          'id': jsonInt(session['id']),
                          'title': title.text.trim(),
                          'session_date': date.text.trim(),
                          'location': location.text.trim(),
                          'total': jsonInt(planned.text),
                          'attendance': _sessionPresent(session),
                          'game_id': state.game.id,
                        }, state.copyWithRaw(raw));
                        if (context.mounted) Navigator.of(context).pop();
                      },
                child: saving ? const HufcLoader(size: 22, color: Colors.white) : const Text('Zapisz'),
              ),
              const SizedBox(height: 10),
              OutlinedButton(
                onPressed: saving
                    ? null
                    : () async {
                        final raw = Map<String, dynamic>.from(state.raw);
                        raw['sessions'] = jsonList(raw['sessions']).where((item) => jsonInt(item['id']) != jsonInt(session['id'])).toList();
                        await onDelete('/api/sessions/${jsonInt(session['id'])}?gameId=${state.game.id}', state.copyWithRaw(raw));
                        if (context.mounted) Navigator.of(context).pop();
                      },
                child: const Text('Usuń zbiórkę'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (state == null) return const EmptyNotice(text: 'Brak zbiórek w telefonie.');
    final sessions = jsonList(state!.raw['sessions']);
    return HufcPage(
      title: 'Zbiórki',
      subtitle: 'Harmonogram i frekwencja w jednym miejscu.',
      children: [
        for (final session in sessions)
          CardPanel(
            child: InkWell(
              onTap: () => _openEditor(context, session),
              borderRadius: BorderRadius.circular(18),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(child: Text(jsonString(session['title'], fallback: 'Zbiórka'), style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w900))),
                Text(_shortDate(jsonString(session['session_date']))),
              ]),
              const SizedBox(height: 10),
              LinearProgressIndicator(value: _attendanceRatio(session)),
              const SizedBox(height: 8),
                Row(children: [
                  Expanded(child: Text('Obecność: ${_sessionPresent(session)}/${_sessionPlanned(session)} · ${jsonString(session['location'], fallback: 'brak lokalizacji')}')),
                  const Icon(Icons.edit_outlined, size: 20),
                ]),
              ]),
            ),
          ),
      ],
    );
  }
}

class MobileGalleryPage extends StatefulWidget {
  const MobileGalleryPage({super.key, required this.state, required this.session, required this.apiBaseUrl, required this.onMutate});
  final AppState? state;
  final AuthSession session;
  final String apiBaseUrl;
  final Future<void> Function(String url, Map<String, dynamic> body, AppState optimistic) onMutate;

  @override
  State<MobileGalleryPage> createState() => _MobileGalleryPageState();
}

class _MobileGalleryPageState extends State<MobileGalleryPage> {
  bool _uploading = false;
  bool _albums = false;
  int? _albumSessionId;

  Future<void> _pick(ImageSource source) async {
    final state = widget.state;
    if (state == null || _uploading) return;
    final sessions = jsonList(state.raw['sessions']);
    if (sessions.isEmpty) {
      _toast('Najpierw dodaj zbiórkę, żeby przypisać zdjęcie do galerii.');
      return;
    }
    final picker = ImagePicker();
    final file = await picker.pickImage(source: source, imageQuality: 72, maxWidth: 1600);
    if (file == null) return;
    setState(() => _uploading = true);
    try {
      final bytes = await file.readAsBytes();
      final mime = file.mimeType ?? 'image/jpeg';
      final title = file.name.replaceAll(RegExp(r'\.[^.]+$'), '').trim().isEmpty ? 'Zdjęcie' : file.name.replaceAll(RegExp(r'\.[^.]+$'), '');
      final imageData = 'data:$mime;base64,${base64Encode(bytes)}';
      final session = sessions.firstWhere((item) => jsonInt(item['id']) == _albumSessionId, orElse: () => sessions.first);
      final photo = {
        'id': -DateTime.now().millisecondsSinceEpoch,
        'session_id': jsonInt(session['id']),
        'title': title,
        'image_data': imageData,
        'mime_type': mime,
        'color': '#1F5C36',
        'created_at': DateTime.now().toIso8601String(),
        'session_title': jsonString(session['title'], fallback: 'Galeria'),
        'session_date': jsonString(session['session_date']),
        'session_location': jsonString(session['location']),
      };
      final raw = Map<String, dynamic>.from(state.raw);
      raw['photos'] = [photo, ...jsonList(raw['photos'])];
      await widget.onMutate('/api/photos', {
        'session_id': jsonInt(session['id']),
        'title': title,
        'image_data': imageData,
        'mime_type': mime,
        'game_id': state.game.id,
      }, state.copyWithRaw(raw));
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  void _toast(String text) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    if (state == null) return const EmptyNotice(text: 'Brak galerii w telefonie.');
    final photos = jsonList(state.raw['photos']);
    final sessions = jsonList(state.raw['sessions']);
    final shownPhotos = _albumSessionId == null ? photos : photos.where((photo) => jsonInt(photo['session_id']) == _albumSessionId).toList();
    final albumTitle = _albumSessionId == null
        ? null
        : jsonString(sessions.firstWhere((item) => jsonInt(item['id']) == _albumSessionId, orElse: () => {'title': 'Album'})['title'], fallback: 'Album');
    return HufcPage(
      title: _albumSessionId == null ? 'Galeria' : albumTitle!,
      subtitle: 'Zdjęcia z zajęć. Możesz robić zdjęcia, wgrywać je i otwierać podgląd.',
      actions: [
        FilledButton.icon(onPressed: _uploading ? null : () => _pick(ImageSource.camera), icon: const Icon(Icons.photo_camera), label: const Text('Zrób')),
        OutlinedButton.icon(onPressed: _uploading ? null : () => _pick(ImageSource.gallery), icon: const Icon(Icons.photo_library), label: const Text('Wgraj')),
      ],
      children: [
        if (_albumSessionId != null)
          Align(
            alignment: Alignment.centerLeft,
            child: OutlinedButton.icon(onPressed: () => setState(() => _albumSessionId = null), icon: const Icon(Icons.arrow_back), label: const Text('Albumy')),
          ),
        if (_albumSessionId == null)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: SegmentedButton<bool>(
              segments: const [
                ButtonSegment(value: false, label: Text('Zdjęcia'), icon: Icon(Icons.photo_library_outlined)),
                ButtonSegment(value: true, label: Text('Albumy'), icon: Icon(Icons.folder_copy_outlined)),
              ],
              selected: {_albums},
              onSelectionChanged: (value) => setState(() => _albums = value.first),
            ),
          ),
        if (_uploading) const Padding(padding: EdgeInsets.only(bottom: 12), child: LinearProgressIndicator()),
        if (_albums && _albumSessionId == null)
          GridView.builder(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            itemCount: sessions.length + 1,
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: 2, crossAxisSpacing: 12, mainAxisSpacing: 12, childAspectRatio: 1.15),
            itemBuilder: (context, index) {
              if (index == 0) {
                return _AlbumTile(
                  title: 'Utwórz album',
                  subtitle: 'Nowa galeria',
                  icon: Icons.add,
                  onTap: () => _toast('Album tworzy się automatycznie po dodaniu zbiórki w aplikacji web.'),
                );
              }
              final session = sessions[index - 1];
              final count = photos.where((photo) => jsonInt(photo['session_id']) == jsonInt(session['id'])).length;
              final cover = photos.firstWhere((photo) => jsonInt(photo['session_id']) == jsonInt(session['id']), orElse: () => <String, dynamic>{});
              return _AlbumTile(
                title: jsonString(session['title'], fallback: 'Album'),
                subtitle: '$count zdjęć',
                photo: cover,
                token: widget.session.token,
                apiBaseUrl: widget.apiBaseUrl,
                onTap: () => setState(() {
                  _albums = false;
                  _albumSessionId = jsonInt(session['id']);
                }),
              );
            },
          )
        else
          GridView.builder(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            itemCount: shownPhotos.length,
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: 2, crossAxisSpacing: 12, mainAxisSpacing: 12),
            itemBuilder: (context, index) => _PhotoTile(
              photo: shownPhotos[index],
              token: widget.session.token,
              apiBaseUrl: widget.apiBaseUrl,
              onTap: () => showDialog(context: context, builder: (_) => _PhotoPreviewDialog(photo: shownPhotos[index], token: widget.session.token, apiBaseUrl: widget.apiBaseUrl)),
            ),
          ),
        if (!_albums && shownPhotos.isEmpty) const EmptyNotice(text: 'Nie ma jeszcze zdjęć w tym widoku.'),
      ],
    );
  }
}

class MessagesPage extends StatefulWidget {
  const MessagesPage({
    super.key,
    required this.state,
    required this.session,
    required this.apiBaseUrl,
    required this.onMutate,
    this.onConversationModeChanged,
    this.openConversationKey,
    this.onOpenConversationConsumed,
  });
  final AppState? state;
  final AuthSession session;
  final String apiBaseUrl;
  final Future<void> Function(String url, Map<String, dynamic> body, AppState optimistic) onMutate;
  final ValueChanged<bool>? onConversationModeChanged;
  final String? openConversationKey;
  final VoidCallback? onOpenConversationConsumed;

  @override
  State<MessagesPage> createState() => _MessagesPageState();
}

class _MessagesPageState extends State<MessagesPage> {
  final _controller = TextEditingController();
  _Conversation? _selected;
  bool _sending = false;
  bool _attaching = false;

  @override
  void initState() {
    super.initState();
    _scheduleOpenRequestedConversation();
  }

  @override
  void didUpdateWidget(covariant MessagesPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.openConversationKey != null && (widget.openConversationKey != oldWidget.openConversationKey || widget.state != oldWidget.state)) {
      _scheduleOpenRequestedConversation();
    }
  }

  @override
  void dispose() {
    widget.onConversationModeChanged?.call(false);
    _controller.dispose();
    super.dispose();
  }

  void _scheduleOpenRequestedConversation() {
    WidgetsBinding.instance.addPostFrameCallback((_) => _openRequestedConversation());
  }

  void _openRequestedConversation() {
    final key = widget.openConversationKey;
    final state = widget.state;
    if (!mounted || key == null || state == null) return;
    final conversations = _buildConversations(state, widget.session.user);
    for (final conversation in conversations) {
      if (conversation.key == key) {
        setState(() => _selected = conversation);
        widget.onConversationModeChanged?.call(true);
        widget.onOpenConversationConsumed?.call();
        return;
      }
    }
    widget.onOpenConversationConsumed?.call();
  }

  void _openConversation(_Conversation conversation) {
    setState(() => _selected = conversation);
    widget.onConversationModeChanged?.call(true);
  }

  void _closeConversation() {
    setState(() => _selected = null);
    widget.onConversationModeChanged?.call(false);
  }

  Future<void> _send() async {
    final state = widget.state;
    final selected = _selected;
    final text = _controller.text.trim();
    if (state == null || selected == null || text.isEmpty || _sending) return;
    _controller.clear();
    setState(() => _sending = true);
    try {
      final message = {
        'id': -DateTime.now().millisecondsSinceEpoch,
        'sender_id': widget.session.user.id,
        'sender_name': widget.session.user.name,
        'target_type': selected.targetType,
        'target_id': selected.targetId == 0 ? null : selected.targetId,
        'body': text,
        'created_at': DateTime.now().toIso8601String(),
      };
      final raw = Map<String, dynamic>.from(state.raw);
      raw['messages'] = [message, ...jsonList(raw['messages'])];
      await widget.onMutate('/api/messages', {
        'target_type': selected.targetType,
        'target_id': selected.targetId,
        'body': text,
        'game_id': state.game.id,
      }, state.copyWithRaw(raw));
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _attachImage() async {
    final state = widget.state;
    final selected = _selected;
    if (state == null || selected == null || _sending || _attaching) return;
    setState(() => _attaching = true);
    try {
      final picker = ImagePicker();
      final file = await picker.pickImage(source: ImageSource.gallery, imageQuality: 72, maxWidth: 1600);
      if (file == null) return;
      final bytes = await file.readAsBytes();
      final mime = file.mimeType ?? 'image/jpeg';
      final data = 'data:$mime;base64,${base64Encode(bytes)}';
      final name = file.name.isEmpty ? 'zdjecie.jpg' : file.name;
      final message = {
        'id': -DateTime.now().millisecondsSinceEpoch,
        'sender_id': widget.session.user.id,
        'sender_name': widget.session.user.name,
        'target_type': selected.targetType,
        'target_id': selected.targetId == 0 ? null : selected.targetId,
        'body': '',
        'attachment_name': name,
        'attachment_mime': mime,
        'attachment_data': data,
        'created_at': DateTime.now().toIso8601String(),
      };
      final raw = Map<String, dynamic>.from(state.raw);
      raw['messages'] = [message, ...jsonList(raw['messages'])];
      await widget.onMutate('/api/messages', {
        'target_type': selected.targetType,
        'target_id': selected.targetId,
        'body': '',
        'attachment_name': name,
        'attachment_mime': mime,
        'attachment_data': data,
        'game_id': state.game.id,
      }, state.copyWithRaw(raw));
    } finally {
      if (mounted) setState(() => _attaching = false);
    }
  }

  void _showConversationDetails(_Conversation conversation, List<Map<String, dynamic>> messages) {
    final members = _conversationMembers(conversation, widget.state!, widget.session.user);
    final firstDate = messages.isEmpty ? 'Brak wiadomości' : _shortDate(jsonString(messages.first['created_at']));
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 6, 20, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(children: [
                Expanded(child: Text('Szczegóły rozmowy', style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w900))),
                IconButton(onPressed: () => Navigator.of(context).pop(), icon: const Icon(Icons.close)),
              ]),
              const SizedBox(height: 8),
              _DetailRow(label: 'Rozmowa', value: conversation.title),
              _DetailRow(label: 'Pierwsza wiadomość', value: firstDate),
              const SizedBox(height: 12),
              Text('Członkowie', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w900)),
              const SizedBox(height: 8),
              for (final member in members)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: HufcListCard(
                    leading: _Initials(text: member.name),
                    title: member.name,
                    subtitle: member.subtitle,
                  ),
                ),
              const SizedBox(height: 8),
              OutlinedButton.icon(onPressed: () => _detailsToast(context, 'Tworzenie grupy rozmowy będzie zsynchronizowane z panelem web.'), icon: const Icon(Icons.group_add), label: const Text('Utwórz grupę z rozmowy')),
              const SizedBox(height: 8),
              OutlinedButton.icon(onPressed: () => _detailsToast(context, 'Rozmowa zostanie ukryta lokalnie po dodaniu archiwizacji na serwerze.'), icon: const Icon(Icons.delete_outline), label: const Text('Usuń rozmowę')),
            ],
          ),
        ),
      ),
    );
  }

  void _detailsToast(BuildContext context, String text) {
    Navigator.of(context).pop();
    ScaffoldMessenger.of(this.context).showSnackBar(SnackBar(content: Text(text)));
  }

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    if (state == null) return const EmptyNotice(text: 'Brak wiadomości w telefonie.');
    final conversations = _buildConversations(state, widget.session.user);
    final selected = _selected == null || !conversations.any((item) => item.key == _selected!.key)
        ? (conversations.isEmpty ? null : conversations.first)
        : conversations.firstWhere((item) => item.key == _selected!.key);

    if (selected == null) {
      return const EmptyNotice(text: 'Nie ma jeszcze rozmów.');
    }

    if (_selected == null) {
      return HufcPage(
        title: 'Wiadomości',
        subtitle: 'Wybierz rozmowę. Wiadomości zapisują się lokalnie i zsynchronizują po odzyskaniu internetu.',
        children: [
          for (final conversation in conversations)
            HufcListCard(
              onTap: () => _openConversation(conversation),
              leading: _Initials(text: conversation.title),
              title: conversation.title,
              subtitle: conversation.lastText,
              trailing: const Icon(Icons.chevron_right),
            ),
        ],
      );
    }

    final messages = jsonList(state.raw['messages']).where((message) => selected.matches(message, widget.session.user.id)).toList().reversed.toList();
    return Column(
      children: [
        Material(
          color: Theme.of(context).scaffoldBackgroundColor,
          child: SafeArea(
            bottom: false,
            child: ListTile(
              leading: IconButton(icon: const Icon(Icons.arrow_back), onPressed: _closeConversation),
              title: Text(selected.title, style: const TextStyle(fontWeight: FontWeight.w900)),
              subtitle: Text(selected.subtitle),
              trailing: IconButton(icon: const Icon(Icons.more_horiz), onPressed: () => _showConversationDetails(selected, messages)),
            ),
          ),
        ),
        Expanded(
          child: messages.isEmpty
              ? const Center(child: EmptyNotice(text: 'Nie ma jeszcze wiadomości w tej rozmowie.'))
              : ListView.builder(
                  padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                  itemCount: messages.length,
                  itemBuilder: (context, index) {
                    final message = messages[index];
                    final mine = jsonInt(message['sender_id']) == widget.session.user.id;
                    return Align(
                      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
                      child: Container(
                        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.78),
                        margin: const EdgeInsets.only(bottom: 8),
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: mine ? Theme.of(context).colorScheme.primary : Theme.of(context).colorScheme.surfaceContainerHighest,
                          borderRadius: BorderRadius.circular(18),
                        ),
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text(jsonString(message['sender_name'], fallback: mine ? 'Ty' : selected.title), style: TextStyle(fontSize: 12, color: mine ? Colors.white70 : Theme.of(context).colorScheme.onSurfaceVariant)),
                          const SizedBox(height: 4),
                          if (jsonString(message['body']).isNotEmpty)
                            Text(jsonString(message['body']), style: TextStyle(color: mine ? Colors.white : null, fontWeight: FontWeight.w700)),
                          _MessageAttachment(message: message, token: widget.session.token, apiBaseUrl: widget.apiBaseUrl, mine: mine),
                        ]),
                      ),
                    );
                  },
                ),
        ),
        SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
            child: Row(children: [
              IconButton.filledTonal(
                onPressed: _attaching ? null : _attachImage,
                icon: _attaching ? const HufcLoader(size: 18) : const Icon(Icons.attach_file),
              ),
              const SizedBox(width: 6),
              Expanded(
                child: TextField(
                  controller: _controller,
                  minLines: 1,
                  maxLines: 4,
                  decoration: InputDecoration(hintText: 'Napisz do: ${selected.title}', filled: true, fillColor: Theme.of(context).colorScheme.surfaceContainerHighest, border: OutlineInputBorder(borderRadius: BorderRadius.circular(22))),
                ),
              ),
              const SizedBox(width: 8),
              FilledButton(
                onPressed: _sending ? null : _send,
                style: FilledButton.styleFrom(shape: const CircleBorder(), padding: const EdgeInsets.all(14)),
                child: _sending ? const HufcLoader(size: 20, color: Colors.white) : const Icon(Icons.arrow_forward),
              ),
            ]),
          ),
        ),
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
    final selectedTeamId = _teamId;
    Team? selectedTeam;
    for (final team in teams) {
      if (team.id == selectedTeamId) selectedTeam = team;
    }
    final finishedStationIds = state.scores.where((score) => score.teamId == selectedTeamId && score.finished).map((score) => score.stationId).toSet();
    final stationsTitle = selectedTeam == null ? 'Stacje' : 'Stacje · ${selectedTeam.name}';
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text('Gry terenowe', style: Theme.of(context).textTheme.labelLarge),
        Text(game.name, style: Theme.of(context).textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w900)),
        Text('${stations.length} stacji · ${teams.length} drużyn · ${finishedStationIds.length}/${stations.length} ukończonych dla wybranej drużyny'),
        const SizedBox(height: 12),
        CardPanel(
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text(game.timerRunning ? 'Gra trwa' : 'Timer gotowy', style: const TextStyle(fontWeight: FontWeight.w800)),
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
          title: stationsTitle,
          child: Column(
            children: stations.map((station) {
              final done = finishedStationIds.contains(station.id);
              return Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: InkWell(
                  borderRadius: BorderRadius.circular(16),
                  onTap: () => setState(() => _stationId = station.id),
                  child: Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: done ? const Color(0xFF1F5C36) : Theme.of(context).colorScheme.surface,
                      border: Border.all(color: _stationId == station.id ? const Color(0xFF1F5C36) : Theme.of(context).dividerColor),
                      borderRadius: BorderRadius.circular(16),
                    ),
                    child: Row(children: [
                      Expanded(child: Text(station.title, style: TextStyle(fontWeight: FontWeight.w900, color: done ? Colors.white : null))),
                      Text(done ? 'ukończona' : 'nieodwiedzona', style: TextStyle(color: done ? Colors.white70 : Theme.of(context).colorScheme.onSurfaceVariant)),
                      const SizedBox(width: 10),
                      if (done) const CircleAvatar(radius: 14, backgroundColor: Colors.white, child: Icon(Icons.check, size: 18, color: Color(0xFF1F5C36))),
                    ]),
                  ),
                ),
              );
            }).toList(),
          ),
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
  const CompetitionPage({super.key, required this.state, required this.onMutate, required this.onDelete});

  final AppState? state;
  final Future<void> Function(String url, Map<String, dynamic> body, AppState optimistic) onMutate;
  final Future<void> Function(String url, AppState optimistic) onDelete;

  @override
  State<CompetitionPage> createState() => _CompetitionPageState();
}

class _CompetitionPageState extends State<CompetitionPage> {
  int? _tentId;
  String _category = 'Porządek';
  int _points = 1;
  final _reason = TextEditingController();
  final _tentName = TextEditingController();

  @override
  void dispose() {
    _reason.dispose();
    _tentName.dispose();
    super.dispose();
  }

  List<Map<String, dynamic>> _wards(AppState state) => jsonList(state.raw['wards']);

  Set<int> _memberIdsForTent(AppState state, int tentId) {
    return state.members.where((member) => member.tentId == tentId).map((member) => member.wardId).toSet();
  }

  int? _assignedTentId(AppState state, int wardId) {
    for (final member in state.members) {
      if (member.wardId == wardId) return member.tentId;
    }
    return null;
  }

  String _memberNames(AppState state, int tentId) {
    final names = state.members.where((member) => member.tentId == tentId).map((member) => member.name).toList();
    return names.isEmpty ? 'Brak podopiecznych w namiocie' : names.join(', ');
  }

  List<Map<String, dynamic>> _availableWards(AppState state, int tentId) {
    return _wards(state).where((ward) {
      final wardId = jsonInt(ward['id']);
      final assigned = _assignedTentId(state, wardId);
      return assigned == null || assigned == tentId;
    }).toList();
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
    await widget.onMutate('/api/competition/points', {'game_id': state.game.id, 'tent_id': tentId, 'category': _category, 'points': _points, 'reason': _reason.text.trim()}, AppState.fromJson(raw));
    _reason.clear();
  }

  Future<void> _createTent() async {
    final state = widget.state;
    final name = _tentName.text.trim();
    if (state == null || name.isEmpty) return;
    final raw = _clone(state.raw);
    final tents = jsonList(raw['competition_tents']);
    final id = -DateTime.now().millisecondsSinceEpoch;
    final colors = ['#E7B928', '#D83B8C', '#2E7D5A', '#315A86', '#8A5A2B'];
    final color = colors[tents.length % colors.length];
    tents.add({'id': id, 'name': name, 'color': color, 'total_points': 0, 'member_count': 0});
    raw['competition_tents'] = tents;
    await widget.onMutate('/api/competition/tents', {'game_id': state.game.id, 'name': name, 'color': color}, AppState.fromJson(raw));
    _tentName.clear();
    if (mounted) setState(() => _tentId = id);
  }

  Future<void> _deleteTent(Tent tent) async {
    final state = widget.state;
    if (state == null) return;
    final raw = _clone(state.raw);
    final tents = jsonList(raw['competition_tents'])..removeWhere((item) => jsonInt(item['id']) == tent.id);
    final members = jsonList(raw['competition_members'])..removeWhere((item) => jsonInt(item['tent_id']) == tent.id);
    final points = jsonList(raw['competition_points'])..removeWhere((item) => jsonInt(item['tent_id']) == tent.id);
    raw['competition_tents'] = tents;
    raw['competition_members'] = members;
    raw['competition_points'] = points;
    await widget.onDelete('/api/competition/tents/${tent.id}?gameId=${state.game.id}', AppState.fromJson(raw));
    if (mounted) setState(() => _tentId = tents.isNotEmpty ? jsonInt(tents.first['id']) : null);
  }

  Future<void> _saveMembers(Tent tent, Set<int> selectedWardIds) async {
    final state = widget.state;
    if (state == null) return;
    final raw = _clone(state.raw);
    final members = jsonList(raw['competition_members']);
    members.removeWhere((item) {
      final wardId = jsonInt(item['ward_id']);
      return jsonInt(item['tent_id']) == tent.id || selectedWardIds.contains(wardId);
    });
    final wards = _wards(state);
    for (final wardId in selectedWardIds) {
      final ward = wards.firstWhere((item) => jsonInt(item['id']) == wardId, orElse: () => <String, dynamic>{});
      members.add({
        'tent_id': tent.id,
        'ward_id': wardId,
        'ward_name': jsonString(ward['name'], fallback: 'Podopieczny'),
        'tent_name': tent.name,
      });
    }
    final tents = jsonList(raw['competition_tents']);
    for (final item in tents) {
      final id = jsonInt(item['id']);
      item['member_count'] = members.where((member) => jsonInt(member['tent_id']) == id).length;
    }
    raw['competition_members'] = members;
    raw['competition_tents'] = tents;
    await widget.onMutate('/api/competition/tents/${tent.id}/members', {'game_id': state.game.id, 'ward_ids': selectedWardIds.toList()}, AppState.fromJson(raw));
  }

  Future<void> _showPointsModal() async {
    final state = widget.state;
    if (state == null || state.tents.isEmpty) return;
    if (_tentId == null || !state.tents.any((tent) => tent.id == _tentId)) {
      _tentId = state.tents.first.id;
    }
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (context) => StatefulBuilder(
        builder: (context, modalSetState) {
          final bottom = MediaQuery.of(context).viewInsets.bottom;
          return Padding(
            padding: EdgeInsets.fromLTRB(18, 18, 18, bottom + 18),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(children: [
                  const Expanded(child: Text('Dodaj punkty', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w900))),
                  IconButton(onPressed: () => Navigator.of(context).pop(), icon: const Icon(Icons.close)),
                ]),
                const SizedBox(height: 10),
                DropdownButtonFormField<int>(
                  initialValue: _tentId,
                  items: state.tents.map((tent) => DropdownMenuItem(value: tent.id, child: Text(tent.name))).toList(),
                  onChanged: (value) => modalSetState(() => _tentId = value),
                  decoration: const InputDecoration(labelText: 'Namiot'),
                ),
                const SizedBox(height: 10),
                DropdownButtonFormField<String>(
                  initialValue: _category,
                  items: ['Porządek', 'Zachowanie', 'Aktywność', 'Punkty dodatkowe'].map((value) => DropdownMenuItem(value: value, child: Text(value))).toList(),
                  onChanged: (value) => modalSetState(() => _category = value ?? 'Porządek'),
                  decoration: const InputDecoration(labelText: 'Kategoria'),
                ),
                const SizedBox(height: 14),
                Row(children: [
                  IconButton.filledTonal(onPressed: () => modalSetState(() => _points = (_points - 1).clamp(-50, 50).toInt()), icon: const Icon(Icons.remove)),
                  Expanded(child: Center(child: Text('$_points pkt', style: const TextStyle(fontSize: 30, fontWeight: FontWeight.w900)))),
                  IconButton.filledTonal(onPressed: () => modalSetState(() => _points = (_points + 1).clamp(-50, 50).toInt()), icon: const Icon(Icons.add)),
                ]),
                const SizedBox(height: 10),
                TextField(controller: _reason, minLines: 2, maxLines: 4, decoration: const InputDecoration(labelText: 'Powód / komentarz', hintText: 'np. Wzorowy porządek po ciszy nocnej')),
                const SizedBox(height: 14),
                FilledButton(
                  onPressed: () async {
                    if (_reason.text.trim().isEmpty) return;
                    await _addPoints();
                    if (context.mounted) Navigator.of(context).pop();
                  },
                  child: const Text('Dodaj wpis'),
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  Future<void> _showTentsModal() async {
    final state = widget.state;
    if (state == null) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (context) => Padding(
        padding: EdgeInsets.fromLTRB(18, 18, 18, MediaQuery.of(context).viewInsets.bottom + 18),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(children: [
              const Expanded(child: Text('Zarządzaj namiotami', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w900))),
              IconButton(onPressed: () => Navigator.of(context).pop(), icon: const Icon(Icons.close)),
            ]),
            const SizedBox(height: 10),
            Row(children: [
              Expanded(child: TextField(controller: _tentName, decoration: const InputDecoration(labelText: 'Nazwa namiotu', hintText: 'np. Namiot 3 / Wilki'))),
              const SizedBox(width: 10),
              FilledButton(
                onPressed: () async {
                  await _createTent();
                  if (context.mounted) Navigator.of(context).pop();
                },
                child: const Text('Dodaj'),
              ),
            ]),
            const SizedBox(height: 14),
            ...state.tents.map((tent) => _TentAdminRow(tent: tent, onDelete: () async {
                  await _deleteTent(tent);
                  if (context.mounted) Navigator.of(context).pop();
                })),
          ],
        ),
      ),
    );
  }

  Future<void> _showMembersModal(Tent tent) async {
    final state = widget.state;
    if (state == null) return;
    final selected = _memberIdsForTent(state, tent.id);
    final available = _availableWards(state, tent.id);
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (context) => StatefulBuilder(
        builder: (context, modalSetState) => Padding(
          padding: EdgeInsets.fromLTRB(18, 18, 18, MediaQuery.of(context).viewInsets.bottom + 18),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(children: [
                Expanded(child: Text('Skład: ${tent.name}', style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w900))),
                IconButton(onPressed: () => Navigator.of(context).pop(), icon: const Icon(Icons.close)),
              ]),
              const SizedBox(height: 8),
              Text('Pokazujemy tylko osoby wolne oraz osoby przypisane do tego namiotu. Dzięki temu ten sam podopieczny nie trafi do dwóch namiotów.', style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)),
              const SizedBox(height: 12),
              ConstrainedBox(
                constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.52),
                child: ListView(
                  shrinkWrap: true,
                  children: available.map((ward) {
                    final wardId = jsonInt(ward['id']);
                    final checked = selected.contains(wardId);
                    return _WardCheckRow(
                      ward: ward,
                      checked: checked,
                      onChanged: (value) => modalSetState(() {
                        if (value) {
                          selected.add(wardId);
                        } else {
                          selected.remove(wardId);
                        }
                      }),
                    );
                  }).toList(),
                ),
              ),
              const SizedBox(height: 14),
              FilledButton(
                onPressed: () async {
                  await _saveMembers(tent, selected);
                  if (context.mounted) Navigator.of(context).pop();
                },
                child: const Text('Zapisz skład'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    if (state == null) return const EmptyNotice(text: 'Brak danych współzawodnictwa w telefonie.');
    final tents = [...state.tents]..sort((a, b) => b.totalPoints.compareTo(a.totalPoints));
    if (tents.isEmpty) {
      _tentId = null;
    } else if (_tentId == null || !tents.any((tent) => tent.id == _tentId)) {
      _tentId = tents.first.id;
    }
    return HufcPage(
      title: 'Współzawodnictwo',
      subtitle: 'Rywalizacja namiotów: porządek, zachowanie, aktywność i punkty dodatkowe z obowiązkowym powodem.',
      actions: [
        OutlinedButton.icon(onPressed: _showTentsModal, icon: const Icon(Icons.add), label: const Text('Namioty')),
        FilledButton.icon(onPressed: tents.isEmpty ? null : _showPointsModal, icon: const Icon(Icons.add), label: const Text('Dodaj punkty')),
      ],
      children: [
        CardPanel(
          title: 'Ranking namiotów',
          trailing: const Text('na żywo'),
          child: tents.isEmpty
              ? const EmptyNotice(text: 'Dodaj pierwszy namiot, żeby rozpocząć współzawodnictwo.')
              : Column(
                  children: [
                    for (var index = 0; index < tents.length; index++)
                      _CompetitionRankRow(
                        tent: tents[index],
                        rank: index + 1,
                        selected: _tentId == tents[index].id,
                        onTap: () => setState(() => _tentId = tents[index].id),
                      ),
                  ],
                ),
        ),
        CardPanel(
          title: 'Skład namiotów',
          child: tents.isEmpty
              ? const EmptyNotice(text: 'Nie ma jeszcze żadnego namiotu.')
              : Column(
                  children: tents
                      .map((tent) => _TentMembersRow(
                            tent: tent,
                            members: _memberNames(state, tent.id),
                            onEdit: () => _showMembersModal(tent),
                          ))
                      .toList(),
                ),
        ),
        CardPanel(
          title: 'Historia punktów',
          child: state.points.isEmpty
              ? const EmptyNotice(text: 'Brak punktów. Każdy wpis będzie widoczny tutaj z powodem i autorem.')
              : Column(children: state.points.map((point) => _PointHistoryRow(point: point)).toList()),
        ),
      ],
    );
  }
}

class _CompetitionRankRow extends StatelessWidget {
  const _CompetitionRankRow({required this.tent, required this.rank, required this.selected, required this.onTap});

  final Tent tent;
  final int rank;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final color = _colorFromHex(tent.color);
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(18),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: selected ? scheme.primaryContainer.withValues(alpha: 0.32) : scheme.surfaceContainerHighest.withValues(alpha: 0.55),
            border: Border.all(color: selected ? scheme.primary : scheme.outlineVariant),
            borderRadius: BorderRadius.circular(18),
          ),
          child: Row(children: [
            CircleAvatar(backgroundColor: color, foregroundColor: Colors.white, child: Text('$rank', style: const TextStyle(fontWeight: FontWeight.w900))),
            const SizedBox(width: 14),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(tent.name, style: const TextStyle(fontWeight: FontWeight.w900)),
                Text('${tent.memberCount} osób w namiocie', style: TextStyle(color: scheme.onSurfaceVariant)),
              ]),
            ),
            Text('${tent.totalPoints} pkt', style: const TextStyle(fontWeight: FontWeight.w900)),
          ]),
        ),
      ),
    );
  }
}

class _TentMembersRow extends StatelessWidget {
  const _TentMembersRow({required this.tent, required this.members, required this.onEdit});

  final Tent tent;
  final String members;
  final VoidCallback onEdit;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
        borderRadius: BorderRadius.circular(18),
      ),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(tent.name, style: const TextStyle(fontWeight: FontWeight.w900)),
            const SizedBox(height: 6),
            Text(members, maxLines: 3, overflow: TextOverflow.ellipsis, style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)),
          ]),
        ),
        OutlinedButton(onPressed: onEdit, child: const Text('Edytuj skład')),
      ]),
    );
  }
}

class _TentAdminRow extends StatelessWidget {
  const _TentAdminRow({required this.tent, required this.onDelete});

  final Tent tent;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Row(children: [
        Container(width: 16, height: 16, decoration: BoxDecoration(color: _colorFromHex(tent.color), borderRadius: BorderRadius.circular(5))),
        const SizedBox(width: 12),
        Expanded(child: Text(tent.name, style: const TextStyle(fontWeight: FontWeight.w900))),
        OutlinedButton(onPressed: onDelete, child: const Text('Usuń')),
      ]),
    );
  }
}

class _WardCheckRow extends StatelessWidget {
  const _WardCheckRow({required this.ward, required this.checked, required this.onChanged});

  final Map<String, dynamic> ward;
  final bool checked;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    final name = jsonString(ward['name'], fallback: 'Podopieczny');
    final subtitle = '${jsonInt(ward['age'])} lat · ${jsonString(ward['cohort_name'], fallback: 'bez grupy')}';
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(
        border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
        borderRadius: BorderRadius.circular(16),
      ),
      child: CheckboxListTile(
        value: checked,
        onChanged: (value) => onChanged(value == true),
        secondary: _Initials(text: name),
        title: Text(name, style: const TextStyle(fontWeight: FontWeight.w900)),
        subtitle: Text(subtitle),
        controlAffinity: ListTileControlAffinity.leading,
      ),
    );
  }
}

class _PointHistoryRow extends StatelessWidget {
  const _PointHistoryRow({required this.point});

  final CompetitionPoint point;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
        borderRadius: BorderRadius.circular(18),
      ),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${point.tentName} · ${point.category}', style: const TextStyle(fontWeight: FontWeight.w900)),
            const SizedBox(height: 4),
            Text(point.reason, style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)),
          ]),
        ),
        Text('${point.points > 0 ? '+' : ''}${point.points} pkt', style: const TextStyle(fontWeight: FontWeight.w900)),
      ]),
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
            FilledButton(onPressed: syncing ? null : () => onSync(), child: syncing ? const HufcLoader(size: 24, color: Colors.white) : const Text('Synchronizuj teraz')),
          ]),
        ),
        OutlinedButton(onPressed: onLogout, child: const Text('Wyloguj z telefonu')),
      ],
    );
  }
}


class HufcPage extends StatelessWidget {
  const HufcPage({super.key, required this.title, required this.subtitle, required this.children, this.actions = const []});

  final String title;
  final String subtitle;
  final List<Widget> children;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 18, 16, 24),
      children: [
        Text(title, style: Theme.of(context).textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w900)),
        const SizedBox(height: 6),
        Text(subtitle, style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)),
        if (actions.isNotEmpty) const SizedBox(height: 14),
        if (actions.isNotEmpty) Wrap(spacing: 10, runSpacing: 10, children: actions),
        const SizedBox(height: 14),
        ...children,
      ],
    );
  }
}

class HufcListCard extends StatelessWidget {
  const HufcListCard({super.key, required this.leading, required this.title, required this.subtitle, this.trailing, this.onTap});

  final Widget leading;
  final String title;
  final String subtitle;
  final Widget? trailing;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Card(
      elevation: 0,
      margin: const EdgeInsets.only(bottom: 10),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
      child: ListTile(
        onTap: onTap,
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        leading: leading,
        title: Text(title, style: const TextStyle(fontWeight: FontWeight.w900)),
        subtitle: Text(subtitle, maxLines: 2, overflow: TextOverflow.ellipsis),
        trailing: trailing,
      ),
    );
  }
}

class _Initials extends StatelessWidget {
  const _Initials({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    final parts = text.trim().split(RegExp(r'\s+')).where((part) => part.isNotEmpty).toList();
    final initials = parts.take(2).map((part) => part.substring(0, 1).toUpperCase()).join();
    return CircleAvatar(
      backgroundColor: const Color(0xFFE0F2E7),
      foregroundColor: const Color(0xFF1F5C36),
      child: Text(initials.isEmpty ? 'H' : initials, style: const TextStyle(fontWeight: FontWeight.w900)),
    );
  }
}

class _BrandLogoMark extends StatelessWidget {
  const _BrandLogoMark({this.size = 40});

  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      padding: EdgeInsets.all(size * 0.13),
      decoration: BoxDecoration(
        color: const Color(0xFFF7F3EC),
        borderRadius: BorderRadius.circular(size * 0.32),
        boxShadow: const [BoxShadow(color: Colors.black26, blurRadius: 16, offset: Offset(0, 8))],
      ),
      child: Image.asset('assets/brand/moj-hufiec-logo.png', fit: BoxFit.contain),
    );
  }
}

class _DetailRow extends StatelessWidget {
  const _DetailRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(width: 118, child: Text(label, style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant))),
          Expanded(child: Text(value.isEmpty ? 'Brak danych' : value, style: const TextStyle(fontWeight: FontWeight.w800))),
        ],
      ),
    );
  }
}

class _AlbumTile extends StatelessWidget {
  const _AlbumTile({
    required this.title,
    required this.subtitle,
    required this.onTap,
    this.photo,
    this.token = '',
    this.apiBaseUrl = '',
    this.icon,
  });

  final String title;
  final String subtitle;
  final VoidCallback onTap;
  final Map<String, dynamic>? photo;
  final String token;
  final String apiBaseUrl;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final hasPhoto = photo != null && photo!.isNotEmpty;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(18),
      child: Card(
        elevation: 0,
        margin: EdgeInsets.zero,
        clipBehavior: Clip.antiAlias,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: hasPhoto
                  ? _PhotoImage(photo: photo!, token: token, apiBaseUrl: apiBaseUrl)
                  : DecoratedBox(
                      decoration: const BoxDecoration(color: Color(0xFFEAF4EC)),
                      child: Center(child: Icon(icon ?? Icons.folder_copy_outlined, size: 32, color: const Color(0xFF1F5C36))),
                    ),
            ),
            Padding(
              padding: const EdgeInsets.all(12),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w900)),
                Text(subtitle, style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)),
              ]),
            ),
          ],
        ),
      ),
    );
  }
}

class _Conversation {
  const _Conversation({
    required this.targetType,
    required this.targetId,
    required this.title,
    required this.subtitle,
    required this.lastText,
    required this.lastAt,
  });

  final String targetType;
  final int targetId;
  final String title;
  final String subtitle;
  final String lastText;
  final DateTime lastAt;

  String get key => '$targetType:$targetId';

  _Conversation copyWith({String? lastText, DateTime? lastAt}) => _Conversation(
        targetType: targetType,
        targetId: targetId,
        title: title,
        subtitle: subtitle,
        lastText: lastText ?? this.lastText,
        lastAt: lastAt ?? this.lastAt,
      );

  bool matches(Map<String, dynamic> message, int userId) {
    final type = jsonString(message['target_type']);
    final target = jsonInt(message['target_id']);
    final sender = jsonInt(message['sender_id']);
    if (targetType == 'user') {
      return type == 'user' && ((target == userId && sender == targetId) || (target == targetId && sender == userId));
    }
    return type == targetType && target == targetId;
  }
}

List<_Conversation> _buildConversations(AppState state, AppUser user) {
  final fallbackAt = DateTime.fromMillisecondsSinceEpoch(0);
  final conversations = <String, _Conversation>{};

  void upsert(_Conversation conversation) {
    conversations[conversation.key] = conversation;
  }

  upsert(_Conversation(targetType: 'hufiec', targetId: 0, title: 'Cały hufiec', subtitle: 'wszyscy wychowawcy i administrator', lastText: 'Brak wiadomości', lastAt: fallbackAt));
  upsert(_Conversation(targetType: 'staff', targetId: 0, title: 'Wychowawcy', subtitle: 'rozmowa kadry', lastText: 'Brak wiadomości', lastAt: fallbackAt));
  upsert(_Conversation(targetType: 'parents', targetId: 0, title: 'Rodzice', subtitle: 'komunikaty i pytania rodziców', lastText: 'Brak wiadomości', lastAt: fallbackAt));

  for (final cohort in jsonList(state.raw['cohorts'])) {
    final id = jsonInt(cohort['id']);
    if (id > 0) {
      upsert(_Conversation(
        targetType: 'cohort',
        targetId: id,
        title: jsonString(cohort['name'], fallback: 'Grupa'),
        subtitle: jsonString(cohort['caretaker_name'], fallback: 'grupa'),
        lastText: 'Brak wiadomości',
        lastAt: fallbackAt,
      ));
    }
  }

  for (final team in state.teams) {
    upsert(_Conversation(targetType: 'team', targetId: team.id, title: team.name, subtitle: 'drużyna gry terenowej', lastText: 'Brak wiadomości', lastAt: fallbackAt));
  }

  for (final caregiver in jsonList(state.raw['caregivers'])) {
    final id = jsonInt(caregiver['id']);
    if (id > 0 && id != user.id) {
      upsert(_Conversation(
        targetType: 'user',
        targetId: id,
        title: jsonString(caregiver['name'], fallback: 'Użytkownik'),
        subtitle: jsonString(caregiver['role'], fallback: 'konto'),
        lastText: 'Brak wiadomości',
        lastAt: fallbackAt,
      ));
    }
  }

  for (final message in jsonList(state.raw['messages'])) {
    final key = _conversationKeyForMessage(message, user.id);
    if (key == null) continue;
    final existing = conversations[key] ?? _conversationForUnknown(message, user);
    if (existing == null) continue;
    final createdAt = DateTime.tryParse(jsonString(message['created_at'])) ?? fallbackAt;
    final senderId = jsonInt(message['sender_id']);
    final body = jsonString(message['body'], fallback: jsonString(message['attachment_name'], fallback: 'Załącznik'));
    final author = senderId == user.id ? 'Ty' : jsonString(message['sender_name'], fallback: existing.title);
    if (createdAt.isAfter(existing.lastAt) || existing.lastAt == fallbackAt) {
      conversations[key] = existing.copyWith(lastText: '$author: $body', lastAt: createdAt);
    }
  }

  final sorted = conversations.values.toList();
  sorted.sort((a, b) => b.lastAt.compareTo(a.lastAt));
  return sorted;
}

String? _conversationKeyForMessage(Map<String, dynamic> message, int userId) {
  final type = jsonString(message['target_type']);
  final target = jsonInt(message['target_id']);
  final sender = jsonInt(message['sender_id']);
  if (type == 'user') {
    final other = target == userId ? sender : target;
    if (other <= 0) return null;
    return 'user:$other';
  }
  return '$type:$target';
}

_Conversation? _conversationForUnknown(Map<String, dynamic> message, AppUser user) {
  final key = _conversationKeyForMessage(message, user.id);
  if (key == null) return null;
  final parts = key.split(':');
  final type = parts.first;
  final targetId = int.tryParse(parts.last) ?? 0;
  final title = type == 'user' ? jsonString(message['sender_name'], fallback: 'Rozmowa') : 'Rozmowa';
  return _Conversation(targetType: type, targetId: targetId, title: title, subtitle: type, lastText: 'Brak wiadomości', lastAt: DateTime.fromMillisecondsSinceEpoch(0));
}

class _ConversationMember {
  const _ConversationMember(this.name, this.subtitle);

  final String name;
  final String subtitle;
}

List<_ConversationMember> _conversationMembers(_Conversation conversation, AppState state, AppUser user) {
  final members = <_ConversationMember>[];

  void add(String name, String subtitle) {
    final clean = name.trim();
    if (clean.isEmpty || members.any((member) => member.name == clean)) return;
    members.add(_ConversationMember(clean, subtitle.trim().isEmpty ? 'konto' : subtitle.trim()));
  }

  add(user.name, user.role);
  final caregivers = jsonList(state.raw['caregivers']);
  Map<String, dynamic>? findById(List<Map<String, dynamic>> items, int id) {
    for (final item in items) {
      if (jsonInt(item['id']) == id) return item;
    }
    return null;
  }

  if (conversation.targetType == 'user') {
    final other = findById(caregivers, conversation.targetId);
    add(jsonString(other?['name'], fallback: conversation.title), jsonString(other?['role'], fallback: conversation.subtitle));
  } else if (conversation.targetType == 'staff') {
    for (final caregiver in caregivers) {
      add(jsonString(caregiver['name']), jsonString(caregiver['role'], fallback: 'konto'));
    }
  } else if (conversation.targetType == 'hufiec' || conversation.targetType == 'parents') {
    for (final caregiver in caregivers) {
      add(jsonString(caregiver['name']), jsonString(caregiver['role'], fallback: 'konto'));
    }
  } else if (conversation.targetType == 'cohort') {
    final cohorts = jsonList(state.raw['cohorts']);
    final cohort = findById(cohorts, conversation.targetId);
    final caretakerId = jsonInt(cohort?['caretaker_user_id']);
    final caretaker = findById(caregivers, caretakerId);
    add(jsonString(caretaker?['name'], fallback: jsonString(cohort?['caretaker_name'], fallback: 'Opiekun grupy')), 'wychowawca');
    for (final ward in jsonList(state.raw['wards']).where((item) => jsonInt(item['cohort_id']) == conversation.targetId)) {
      add(jsonString(ward['name'], fallback: 'Podopieczny'), 'podopieczny');
    }
  } else if (conversation.targetType == 'team') {
    add(conversation.title, 'drużyna gry terenowej');
  }

  return members;
}

class _PhotoTile extends StatelessWidget {
  const _PhotoTile({required this.photo, required this.token, required this.apiBaseUrl, this.onTap});
  final Map<String, dynamic> photo;
  final String token;
  final String apiBaseUrl;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final title = jsonString(photo['title'], fallback: 'Zdjęcie');
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(18),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(18),
        child: Stack(
          fit: StackFit.expand,
          children: [
            _PhotoImage(photo: photo, token: token, apiBaseUrl: apiBaseUrl),
            const DecoratedBox(decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Colors.transparent, Colors.black54]))),
            Positioned(left: 10, right: 10, bottom: 10, child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w900))),
          ],
        ),
      ),
    );
  }
}

class _PhotoImage extends StatelessWidget {
  const _PhotoImage({required this.photo, required this.token, required this.apiBaseUrl, this.fit = BoxFit.cover});

  final Map<String, dynamic> photo;
  final String token;
  final String apiBaseUrl;
  final BoxFit fit;

  @override
  Widget build(BuildContext context) {
    final imageData = jsonString(photo['image_data']);
    final fallback = DecoratedBox(decoration: BoxDecoration(color: _colorFromString(jsonString(photo['color'], fallback: '#1F5C36'))));
    if (imageData.startsWith('data:image')) {
      final comma = imageData.indexOf(',');
      try {
        return Image.memory(base64Decode(imageData.substring(comma + 1)), fit: fit);
      } catch (_) {
        return fallback;
      }
    }
    final id = jsonInt(photo['id']);
    if (id > 0) {
      final base = apiBaseUrl.replaceAll(RegExp(r'/$'), '');
      return Image.network(
        '$base/api/mobile/photos/$id/image',
        headers: {'Authorization': 'Bearer $token', 'X-Hufc-Mobile': '1'},
        fit: fit,
        loadingBuilder: (context, child, progress) => progress == null ? child : const Center(child: HufcLoader(size: 24)),
        errorBuilder: (context, error, stackTrace) => fallback,
      );
    }
    return fallback;
  }
}

class _PhotoPreviewDialog extends StatelessWidget {
  const _PhotoPreviewDialog({required this.photo, required this.token, required this.apiBaseUrl});

  final Map<String, dynamic> photo;
  final String token;
  final String apiBaseUrl;

  @override
  Widget build(BuildContext context) {
    final title = jsonString(photo['title'], fallback: 'Zdjęcie');
    final date = _shortDate(jsonString(photo['created_at'], fallback: jsonString(photo['session_date'])));
    final location = jsonString(photo['session_location']);
    return Dialog(
      insetPadding: const EdgeInsets.all(14),
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(22)),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          AspectRatio(aspectRatio: 1, child: InteractiveViewer(minScale: 1, maxScale: 4, child: _PhotoImage(photo: photo, token: token, apiBaseUrl: apiBaseUrl, fit: BoxFit.contain))),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w900)),
              if (date.isNotEmpty) Text(date),
              if (location.isNotEmpty) Text(location),
              const SizedBox(height: 12),
              Align(alignment: Alignment.centerRight, child: FilledButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Zamknij'))),
            ]),
          ),
        ],
      ),
    );
  }
}

class _MessageAttachment extends StatelessWidget {
  const _MessageAttachment({required this.message, required this.token, required this.apiBaseUrl, required this.mine});

  final Map<String, dynamic> message;
  final String token;
  final String apiBaseUrl;
  final bool mine;

  @override
  Widget build(BuildContext context) {
    final photoId = jsonInt(message['photo_id']);
    final attachmentName = jsonString(message['attachment_name']);
    final attachmentMime = jsonString(message['attachment_mime']);
    final attachmentData = jsonString(message['attachment_data']);
    final hasPhoto = photoId > 0;
    final hasAttachment = attachmentName.isNotEmpty || attachmentData.isNotEmpty;
    if (!hasPhoto && !hasAttachment) return const SizedBox.shrink();

    final title = hasPhoto ? jsonString(message['photo_title'], fallback: 'Zdjęcie') : jsonString(message['attachment_name'], fallback: 'Załącznik');
    final mime = hasPhoto ? jsonString(message['photo_mime_type'], fallback: 'image/jpeg') : attachmentMime;
    final imageLike = hasPhoto || mime.startsWith('image/') || attachmentData.startsWith('data:image');
    final top = jsonString(message['body']).isEmpty ? 0.0 : 8.0;

    Widget preview;
    if (hasPhoto) {
      preview = _PhotoImage(
        photo: {'id': photoId, 'title': title, 'color': '#1F5C36'},
        token: token,
        apiBaseUrl: apiBaseUrl,
      );
    } else if (attachmentData.startsWith('data:image')) {
      final comma = attachmentData.indexOf(',');
      try {
        preview = Image.memory(base64Decode(attachmentData.substring(comma + 1)), fit: BoxFit.cover);
      } catch (_) {
        preview = const Icon(Icons.broken_image_outlined);
      }
    } else if (imageLike && jsonInt(message['id']) > 0) {
      final base = apiBaseUrl.replaceAll(RegExp(r'/$'), '');
      preview = Image.network(
        '$base/api/mobile/messages/${jsonInt(message['id'])}/attachment',
        headers: {'Authorization': 'Bearer $token', 'X-Hufc-Mobile': '1'},
        fit: BoxFit.cover,
        loadingBuilder: (context, child, progress) => progress == null ? child : const Center(child: HufcLoader(size: 20)),
        errorBuilder: (context, error, stackTrace) => const Icon(Icons.broken_image_outlined),
      );
    } else {
      preview = const Icon(Icons.attach_file);
    }

    final content = Container(
      margin: EdgeInsets.only(top: top),
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: mine ? Colors.white.withValues(alpha: 0.12) : const Color(0xFFF4F1EA),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: mine ? Colors.white24 : const Color(0xFFE5DED2)),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (imageLike)
          ClipRRect(borderRadius: BorderRadius.circular(10), child: AspectRatio(aspectRatio: 1.35, child: preview))
        else
          SizedBox(height: 44, child: Center(child: preview)),
        const SizedBox(height: 6),
        Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: mine ? Colors.white : null, fontWeight: FontWeight.w900)),
        if (mime.isNotEmpty) Text(mime, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12, color: mine ? Colors.white70 : Theme.of(context).colorScheme.onSurfaceVariant)),
      ]),
    );

    if (!imageLike) return content;
    return InkWell(
      onTap: () {
        showDialog(
          context: context,
          builder: (_) => Dialog(
            insetPadding: const EdgeInsets.all(14),
            clipBehavior: Clip.antiAlias,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(22)),
            child: AspectRatio(aspectRatio: 1, child: InteractiveViewer(minScale: 1, maxScale: 4, child: preview)),
          ),
        );
      },
      borderRadius: BorderRadius.circular(14),
      child: content,
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
  const CardPanel({super.key, this.title, this.trailing, required this.child});
  final String? title;
  final Widget? trailing;
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
          if (title != null)
            Row(children: [
              Expanded(child: Text(title!, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w900))),
              if (trailing != null) DefaultTextStyle(style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant), child: trailing!),
            ]),
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

class _MetricTile extends StatelessWidget {
  const _MetricTile({required this.label, required this.value, required this.icon});

  final String label;
  final String value;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      height: 104,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(22),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Icon(icon, color: scheme.primary, size: 22),
          Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: scheme.onSurfaceVariant, fontWeight: FontWeight.w800, fontSize: 12)),
            const SizedBox(height: 3),
            Text(value, style: TextStyle(color: scheme.onSurface, fontWeight: FontWeight.w900, fontSize: 22)),
          ]),
        ],
      ),
    );
  }
}

class _InfoBlock extends StatelessWidget {
  const _InfoBlock({required this.title, required this.value, required this.icon});

  final String title;
  final String value;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(24),
      ),
      child: Row(
        children: [
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(color: scheme.primaryContainer, borderRadius: BorderRadius.circular(15)),
            child: Icon(icon, color: scheme.onPrimaryContainer),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: TextStyle(color: scheme.onSurfaceVariant, fontWeight: FontWeight.w800)),
              const SizedBox(height: 4),
              Text(value, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: scheme.onSurface, fontWeight: FontWeight.w900, fontSize: 18)),
            ]),
          ),
        ],
      ),
    );
  }
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

String _shortDate(String value) {
  final parsed = DateTime.tryParse(value);
  if (parsed == null) return value;
  return '${parsed.day.toString().padLeft(2, '0')}.${parsed.month.toString().padLeft(2, '0')}.${parsed.year}';
}

String _dateInput(String value) {
  final parsed = DateTime.tryParse(value);
  if (parsed == null) return value;
  return '${parsed.year}-${parsed.month.toString().padLeft(2, '0')}-${parsed.day.toString().padLeft(2, '0')}';
}

int _sessionPresent(Map<String, dynamic> session) {
  return jsonInt(session['present_count'], fallback: jsonInt(session['attendance']));
}

int _sessionPlanned(Map<String, dynamic> session) {
  return jsonInt(session['planned_count'], fallback: jsonInt(session['total']));
}

double _attendanceRatio(Map<String, dynamic> session) {
  final planned = _sessionPlanned(session);
  if (planned <= 0) return 0;
  return (_sessionPresent(session) / planned).clamp(0, 1).toDouble();
}

Color _colorFromString(String value) {
  final normalized = value.replaceAll('#', '').trim();
  final parsed = int.tryParse(normalized.length == 6 ? 'FF$normalized' : normalized, radix: 16);
  return Color(parsed ?? 0xFF1F5C36);
}

Color _colorFromHex(String value) => _colorFromString(value);

ThemeMode _themeModeFromString(String? value) {
  return switch (value) {
    'light' => ThemeMode.light,
    'dark' => ThemeMode.dark,
    _ => ThemeMode.system,
  };
}

ThemeData _appTheme({required Brightness brightness, required Color accent}) {
  final dark = brightness == Brightness.dark;
  final scheme = ColorScheme.fromSeed(seedColor: accent, brightness: brightness);
  final background = dark ? const Color(0xFF06150D) : const Color(0xFFF7F3EC);
  final surface = dark ? const Color(0xFF0B1E14) : Colors.white;
  final surfaceHigh = dark ? const Color(0xFF10281A) : const Color(0xFFEFF6EE);

  return ThemeData(
    useMaterial3: true,
    brightness: brightness,
    colorScheme: scheme,
    scaffoldBackgroundColor: background,
    cardTheme: CardThemeData(
      color: surface,
      surfaceTintColor: Colors.transparent,
      shadowColor: dark ? Colors.black : const Color(0x22000000),
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: dark ? const Color(0xFF07180F) : const Color(0xFFF8FBF6),
      foregroundColor: dark ? Colors.white : const Color(0xFF1D241F),
      surfaceTintColor: Colors.transparent,
      elevation: 0,
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: dark ? const Color(0xFF0B1E14) : const Color(0xFFEFF6EE),
      indicatorColor: scheme.primaryContainer,
      labelTextStyle: WidgetStateProperty.resolveWith((states) {
        final selected = states.contains(WidgetState.selected);
        return TextStyle(
          color: dark ? Colors.white : const Color(0xFF1D241F),
          fontWeight: selected ? FontWeight.w900 : FontWeight.w700,
          fontSize: 12,
        );
      }),
      iconTheme: WidgetStateProperty.resolveWith((states) {
        final selected = states.contains(WidgetState.selected);
        return IconThemeData(color: selected ? scheme.primary : (dark ? Colors.white70 : const Color(0xFF3E4A42)));
      }),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: surfaceHigh,
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide(color: dark ? const Color(0xFF274733) : const Color(0xFFD8DED6))),
      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide(color: dark ? const Color(0xFF274733) : const Color(0xFFD8DED6))),
      focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide(color: scheme.primary, width: 2)),
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: scheme.primary,
      contentTextStyle: TextStyle(color: scheme.onPrimary, fontWeight: FontWeight.w800),
      behavior: SnackBarBehavior.floating,
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: scheme.primary,
        foregroundColor: scheme.onPrimary,
        textStyle: const TextStyle(fontWeight: FontWeight.w900),
      ),
    ),
    segmentedButtonTheme: SegmentedButtonThemeData(
      style: ButtonStyle(
        foregroundColor: WidgetStateProperty.resolveWith((states) => states.contains(WidgetState.selected) ? scheme.onPrimaryContainer : scheme.onSurface),
        backgroundColor: WidgetStateProperty.resolveWith((states) => states.contains(WidgetState.selected) ? scheme.primaryContainer : surfaceHigh),
      ),
    ),
  );
}
