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
      if (operation.method == 'POST') {
        latest = await api.postState(session.token, operation.url, operation.body);
      } else if (operation.method == 'DELETE') {
        latest = await api.deleteState(session.token, operation.url);
      }
      await store.removeQueueItem(operation.id);
      if (latest != null) await store.saveState(latest);
    }
    latest = await api.state(session.token, gameId: gameId);
    await store.saveState(latest);
    return latest;
  }
}
