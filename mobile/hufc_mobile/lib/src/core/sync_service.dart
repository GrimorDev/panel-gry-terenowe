import 'api_client.dart';
import 'local_store.dart';
import 'models.dart';

class SyncService {
  SyncService({required this.store, required this.api});

  final LocalStore store;
  final ApiClient api;

  Future<AppState?> sync(AuthSession session, {int? gameId}) async {
    AppState? latest;
    final operations = await store.queue();
    for (final operation in operations) {
      try {
        if (operation.method == 'POST') {
          latest = await api.postState(session.token, operation.url, operation.body);
        } else if (operation.method == 'DELETE') {
          latest = await api.deleteState(session.token, operation.url);
        }
        await store.removeQueueItem(operation.id);
        if (latest != null) await store.saveState(latest);
      } catch (_) {
        // A queued change can permanently fail if whatever it targeted (a game,
        // a station...) was deleted by someone else in the meantime. Stop replaying
        // the queue for now instead of letting one stuck entry block every entry
        // after it forever — it stays queued for a later retry — but still fall
        // through to refresh live state below so the rest of the app recovers now.
        break;
      }
    }
    try {
      latest = await api.state(session.token, gameId: gameId);
    } catch (_) {
      if (gameId == null) rethrow;
      // The locally remembered game may no longer exist on the server (e.g. deleted
      // directly in the database, not through the app) — fall back to the server's
      // default game instead of retrying the same dead id forever.
      latest = await api.state(session.token);
    }
    await store.saveState(latest);
    return latest;
  }
}
