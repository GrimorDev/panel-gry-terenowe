# Moj Hufiec Mobile

Natywna aplikacja Flutter offline-first. To nie jest PWA ani WebView.

## Co dziala lokalnie

- Ostatnio pobrany stan jest trzymany w SQLite.
- Po pierwszym zalogowaniu online aplikacja moze wystartowac offline.
- Timer gry reaguje od razu lokalnie.
- Punkty stacji i punkty wspolzawodnictwa zapisuja sie od razu lokalnie.
- Zmiany bez internetu trafiaja do kolejki i wysylaja sie po odzyskaniu sieci.

## Uruchomienie

Na komputerze z Flutter SDK:

```bash
cd mobile/hufc_mobile
flutter create --platforms=android,ios .
flutter pub get
flutter run --dart-define=API_URL=https://twoja-domena.pl
```

Build Android:

```bash
flutter build apk --release --dart-define=API_URL=https://twoja-domena.pl
```

Build iOS wymaga macOS + Xcode:

```bash
flutter build ipa --release --dart-define=API_URL=https://twoja-domena.pl
```

## Pliki

- `lib/main.dart` - ekrany aplikacji.
- `lib/src/core/api_client.dart` - komunikacja z backendem przez Bearer token.
- `lib/src/core/local_store.dart` - SQLite, konto i kolejka offline.
- `lib/src/core/sync_service.dart` - synchronizacja kolejki.
- `lib/src/core/models.dart` - modele danych.
