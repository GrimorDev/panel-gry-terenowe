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

  Future<void> saveState(AppState state) => put('state', state.encode());

  Future<AppState?> readState() async {
    final value = await get('state');
    if (value == null) return null;
    return AppState.fromJson(jsonDecode(value) as Map<String, dynamic>);
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
}
