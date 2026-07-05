# Panel Wychowawcy - Gry Terenowe

Deployowalna aplikacja webowa dla wychowawcow i instruktorow do prowadzenia gier terenowych bez papierowych kart punktacji.

Stack: Node.js, TypeScript, React, PostgreSQL.

## Start lokalny

```bash
docker compose up -d --build
```

Panel: http://localhost:8080

## Portainer

1. Wrzuc repozytorium na GitHub.
2. W Portainerze wybierz **Stacks -> Add stack -> Repository**.
3. Wskaz repozytorium i plik `docker-compose.yml`.
4. Ustaw opcjonalnie zmienne:
   - `APP_PORT=8080`
   - `APP_URL=https://twoja-domena.pl`
   - `PROXY_NETWORK=proxy` lub nazwa sieci Dockera, w ktorej jest Nginx Proxy Manager
   - `SESSION_SECRET=dlugi-losowy-sekret`
   - `ADMIN_EMAIL=admin@twoja-domena.pl`
   - `ADMIN_PASSWORD=ustaw-silne-haslo`
5. Deploy.

## Nginx Proxy Manager

Po deployu ustaw proxy host na:

- Scheme: `http`
- Forward Hostname/IP: `hufc-app`
- Forward Port: `80`

Jesli masz inna siec proxy niz `proxy`, ustaw w Portainerze zmienna `PROXY_NETWORK` na dokladna nazwe tej sieci. Nazwe znajdziesz w Portainerze w **Networks** albo przy dzialajacym kontenerze Nginx Proxy Manager.

## Co dziala

- logowanie i sesja w ciasteczku,
- automatyczna migracja tabel w PostgreSQL,
- tworzenie gry z szablonu,
- timer start/pauza/reset i zmiana czasu gry,
- dodawanie druzyn ze zdjeciem,
- dodawanie stacji z realnymi wspolrzednymi,
- mapa OpenStreetMap/Leaflet,
- QR dla kazdej stacji oraz skanowanie kamera,
- zapisywanie oceny stacji w PostgreSQL,
- ranking live, statusy, historia i podstawowe odznaki,
- panel admina do dopisywania stacji i gier.

## Stack

- PHP 8.3 + Apache
- PostgreSQL 16
- Vanilla JS
- Leaflet + OpenStreetMap
