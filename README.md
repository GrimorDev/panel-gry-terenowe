# Panel Wychowawcy - Gry Terenowe

Deployowalna aplikacja webowa dla wychowawcow i instruktorow do prowadzenia gier terenowych bez papierowych kart punktacji.

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
5. Deploy.

## Co dziala

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
