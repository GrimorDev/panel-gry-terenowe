# Moj Hufiec

System dla hufca: panel webowy na serwerze oraz natywna aplikacja mobilna Flutter offline-first.

## Co deployujesz w Portainerze

Portainer uruchamia backend, panel webowy, PostgreSQL i Redis z pliku `docker-compose.yml`.

1. Wejdz w Portainer.
2. Wybierz **Stacks -> Add stack -> Repository**.
3. Wskaz repozytorium:
   `https://github.com/GrimorDev/panel-gry-terenowe`
4. Compose path:
   `docker-compose.yml`
5. Ustaw zmienne:
   - `APP_URL=https://twoja-domena.pl`
   - `PROXY_NETWORK=proxy`
   - `SESSION_SECRET=dlugi-losowy-sekret`
   - `ADMIN_EMAIL=grimordev@gmail.com`
   - `ADMIN_PASSWORD=ustaw-silne-haslo`
6. Kliknij **Deploy the stack**.

W Nginx Proxy Manager ustaw:

- Scheme: `http`
- Forward Hostname/IP: `hufc-app`
- Forward Port: `80`

## Aplikacja na telefon

Flutter nie jest uruchamiany jako stack w Portainerze. Z repo buduje sie plik APK dla Androida lub IPA dla iOS.

### APK z GitHub Actions

1. Wejdz w GitHub repo.
2. Otworz **Actions**.
3. Wybierz **Build Android APK**.
4. Kliknij **Run workflow**.
5. Wpisz `api_url`, np. `https://vipile.com`.
6. Po zakonczeniu pobierz artifact `moj-hufiec-android-apk`.

### Lokalnie z Flutter SDK

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

## Offline-first

Aplikacja mobilna trzyma dane lokalnie w SQLite. Timer, punkty gier i punkty wspolzawodnictwa dzialaja od razu lokalnie. Gdy nie ma internetu, zmiany trafiaja do kolejki. Po odzyskaniu internetu aplikacja synchronizuje kolejke z backendem.

## Stack serwera

- Node.js
- TypeScript
- React
- PostgreSQL
- Redis
- Docker / Portainer
