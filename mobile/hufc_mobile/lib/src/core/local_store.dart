import 'dart:convert';

import 'package:path/path.dart' as path;
import 'package:sqflite/sqflite.dart';

import 'models.dart';

class QueuedOperation {
  const QueuedOperation({required this.id, required this.url, required this.method, required this.body, required this.createdAt});

  final int id;
  final String url;
  final String method;
  final Map<String, dynamic> body;
  final DateTime createdAt;
}

class LocalStore {
  static const int _maxCachedStateChars = 2500000;

  Database? _db;

  Future<Database> get db async {
    if (_db != null) return _db!;
    final databasePath = await getDatabasesPath();
    _db = await openDatabase(
      path.join(databasePath, 'moj_hufiec.db'),
      version: 1,
      onCreate: (database, _) async {
        await database.execute('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
        await database.execute('CREATE TABLE queue (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, method TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)');
      },
    );
    return _db!;
  }

  Future<void> saveAuth(AuthSession session) => put('auth', jsonEncode(session.toJson()));

  Future<AuthSession?> readAuth() async {
    final value = await get('auth');
    if (value == null) return null;
    return AuthSession.fromJson(jsonDecode(value) as Map<String, dynamic>);
  }

  Future<void> clearAuth() => delete('auth');

  Future<void> saveState(AppState state) async {
    final safeRaw = _mobileSafeState(state.raw);
    var encoded = jsonEncode(safeRaw);
    if (encoded.length > _maxCachedStateChars) {
      final smaller = _mobileSafeState(safeRaw, compact: true);
      encoded = jsonEncode(smaller);
    }
    await put('state', encoded);
  }

  Future<AppState?> readState() async {
    final database = await db;
    final sizeRows = await database.rawQuery("SELECT length(value) AS size FROM kv WHERE key = 'state' LIMIT 1");
    final size = NumberParser.toInt(sizeRows.isEmpty ? null : sizeRows.first['size']);
    if (size > _maxCachedStateChars) {
      await delete('state');
      return null;
    }

    try {
      final value = await get('state');
      if (value == null) return null;
      return AppState.fromJson(jsonDecode(value) as Map<String, dynamic>);
    } catch (_) {
      await delete('state');
      return null;
    }
  }

  Future<void> enqueue(String url, String method, Map<String, dynamic> body) async {
    final database = await db;
    await database.insert('queue', {
      'url': url,
      'method': method,
      'body': jsonEncode(body),
      'created_at': DateTime.now().toIso8601String(),
    });
  }

  Future<List<QueuedOperation>> queue() async {
    final database = await db;
    final rows = await database.query('queue', orderBy: 'id ASC');
    return rows.map((row) => QueuedOperation(
          id: row['id'] as int,
          url: row['url'] as String,
          method: row['method'] as String,
          body: jsonDecode(row['body'] as String) as Map<String, dynamic>,
          createdAt: DateTime.parse(row['created_at'] as String),
        )).toList();
  }

  Future<void> removeQueueItem(int id) async {
    final database = await db;
    await database.delete('queue', where: 'id = ?', whereArgs: [id]);
  }

  Future<int> queueCount() async {
    final database = await db;
    final result = await database.rawQuery('SELECT COUNT(*) AS count FROM queue');
    return result.first['count'] as int;
  }

  Future<void> clearQueue() async {
    final database = await db;
    await database.delete('queue');
  }

  Future<String?> get(String key) async {
    final database = await db;
    final rows = await database.query('kv', where: 'key = ?', whereArgs: [key], limit: 1);
    if (rows.isEmpty) return null;
    return rows.first['value'] as String;
  }

  Future<void> put(String key, String value) async {
    final database = await db;
    await database.insert('kv', {'key': key, 'value': value}, conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<void> delete(String key) async {
    final database = await db;
    await database.delete('kv', where: 'key = ?', whereArgs: [key]);
  }

  Map<String, dynamic> _mobileSafeState(Map<String, dynamic> raw, {bool compact = false}) {
    final next = <String, dynamic>{};
    for (final entry in raw.entries) {
      final key = entry.key;
      final value = entry.value;
      if (value is List) {
        final limit = switch (key) {
          'messages' => compact ? 40 : 80,
          'photos' => compact ? 30 : 80,
          'shares' => compact ? 30 : 80,
          'materials' => compact ? 30 : 80,
          'questions' => compact ? 30 : 80,
          'competition_points' => compact ? 40 : 80,
          _ => compact ? 200 : 500,
        };
        final items = value.length > limit ? value.take(limit).toList() : value;
        next[key] = items.map((item) => _stripHeavyValue(item, key: key)).toList();
      } else {
        next[key] = _stripHeavyValue(value, key: key);
      }
    }
    return next;
  }

  Object? _stripHeavyValue(Object? value, {String key = ''}) {
    if (_isHeavyKey(key)) return null;
    if (value is String) {
      if (value.startsWith('data:image/') || value.startsWith('data:video/') || value.length > 120000) return null;
      return value;
    }
    if (value is Map) {
      return value.map((entryKey, entryValue) => MapEntry('$entryKey', _stripHeavyValue(entryValue, key: '$entryKey')));
    }
    if (value is List) {
      return value.map((item) => _stripHeavyValue(item)).toList();
    }
    return value;
  }

  bool _isHeavyKey(String key) {
    final normalized = key.toLowerCase();
    return normalized.contains('image_data') || normalized.contains('attachment_data');
  }
}

class NumberParser {
  const NumberParser._();

  static int toInt(Object? value) {
    if (value is int) return value;
    if (value is num) return value.toInt();
    return int.tryParse('$value') ?? 0;
  }
}
