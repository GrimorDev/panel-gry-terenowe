<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $host = getenv('DB_HOST') ?: '127.0.0.1';
    $port = getenv('DB_PORT') ?: '5432';
    $name = getenv('DB_NAME') ?: 'field_games';
    $user = getenv('DB_USER') ?: 'field_games';
    $pass = getenv('DB_PASS') ?: 'field_games_password';
    $dsn = "pgsql:host={$host};port={$port};dbname={$name}";

    $pdo = new PDO($dsn, $user, $pass, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    ensure_schema($pdo);

    return $pdo;
}

function ensure_schema(PDO $pdo): void
{
    static $done = false;
    if ($done) {
        return;
    }

    $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS games (
  id SERIAL PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  template VARCHAR(60) NOT NULL DEFAULT 'Polska',
  game_date DATE NOT NULL DEFAULT CURRENT_DATE,
  start_time TIME NOT NULL DEFAULT '12:00',
  duration_minutes INTEGER NOT NULL DEFAULT 90,
  timer_remaining_seconds INTEGER NOT NULL DEFAULT 5400,
  timer_running BOOLEAN NOT NULL DEFAULT FALSE,
  timer_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  color VARCHAR(20) NOT NULL DEFAULT '#0f766e',
  avatar_path VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stations (
  id SERIAL PRIMARY KEY,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  title VARCHAR(160) NOT NULL,
  station_order INTEGER NOT NULL DEFAULT 1,
  lat NUMERIC(10,7),
  lng NUMERIC(10,7),
  qr_code VARCHAR(80) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS team_stations (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  points INTEGER NOT NULL DEFAULT 0,
  correct BOOLEAN NOT NULL DEFAULT FALSE,
  cooperation INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  comment TEXT,
  UNIQUE(team_id, station_id)
);

CREATE TABLE IF NOT EXISTS photos (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  image_path VARCHAR(255) NOT NULL,
  caption VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS materials (
  id SERIAL PRIMARY KEY,
  station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  title VARCHAR(160) NOT NULL,
  url VARCHAR(500),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS questions (
  id SERIAL PRIMARY KEY,
  station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT,
  max_points INTEGER NOT NULL DEFAULT 10,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
SQL);

    $exists = (int) $pdo->query('SELECT COUNT(*) FROM games')->fetchColumn();
    if ($exists === 0) {
        seed_database($pdo);
    }
    $done = true;
}

function seed_database(PDO $pdo): void
{
    $pdo->beginTransaction();
    $pdo->exec(<<<'SQL'
INSERT INTO games (id, name, template, game_date, start_time, duration_minutes, timer_remaining_seconds, status)
VALUES (1, 'Wycieczka po Polsce', 'Polska', CURRENT_DATE, '12:00', 90, 5400, 'draft')
ON CONFLICT (id) DO NOTHING;

INSERT INTO teams (id, game_id, name, color)
VALUES
  (1, 1, 'Wilki', '#2563eb'),
  (2, 1, 'Orly', '#dc2626'),
  (3, 1, 'Rysie', '#16a34a'),
  (4, 1, 'Lisy', '#eab308')
ON CONFLICT (id) DO NOTHING;

INSERT INTO stations (id, game_id, title, station_order, lat, lng, qr_code)
VALUES
  (1, 1, 'Start - boisko', 1, 52.2297700, 21.0117800, 'station-start-boisko'),
  (2, 1, 'Koloseum', 2, 52.2309600, 21.0103600, 'station-koloseum'),
  (3, 1, 'Wieza w Pizie', 3, 52.2319500, 21.0141200, 'station-piza'),
  (4, 1, 'Pompeje', 4, 52.2283200, 21.0151500, 'station-pompeje'),
  (5, 1, 'Fontanna', 5, 52.2275100, 21.0095000, 'station-fontanna'),
  (6, 1, 'Meta - swietlica', 6, 52.2290400, 21.0069800, 'station-meta')
ON CONFLICT (id) DO NOTHING;

INSERT INTO team_stations (team_id, station_id, points, correct, cooperation, started_at, finished_at, comment)
VALUES
  (1, 2, 10, TRUE, 5, NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '24 minutes', 'Bardzo szybka odpowiedz'),
  (1, 3, 9, TRUE, 5, NOW() - INTERVAL '22 minutes', NOW() - INTERVAL '18 minutes', ''),
  (2, 2, 8, TRUE, 4, NOW() - INTERVAL '28 minutes', NOW() - INTERVAL '20 minutes', ''),
  (3, 5, 9, TRUE, 5, NOW() - INTERVAL '19 minutes', NOW() - INTERVAL '12 minutes', ''),
  (4, 6, 7, FALSE, 3, NOW() - INTERVAL '15 minutes', NOW() - INTERVAL '8 minutes', '')
ON CONFLICT (team_id, station_id) DO NOTHING;

INSERT INTO materials (station_id, title, url, notes)
VALUES
  (2, 'Zdjecie Koloseum', 'https://pl.wikipedia.org/wiki/Koloseum', 'Material pomocniczy dla wychowawcy'),
  (3, 'Krzywa Wieza', 'https://pl.wikipedia.org/wiki/Krzywa_Wie%C5%BCa_w_Pizie', 'Krotka ciekawostka do pytania');

INSERT INTO questions (station_id, question, answer, max_points)
VALUES
  (2, 'W jakim miescie znajduje sie Koloseum?', 'Rzym', 10),
  (3, 'Dlaczego Wieza w Pizie jest znana?', 'Jest przechylona', 10);

SELECT setval('games_id_seq', COALESCE((SELECT MAX(id) FROM games), 1), true);
SELECT setval('teams_id_seq', COALESCE((SELECT MAX(id) FROM teams), 1), true);
SELECT setval('stations_id_seq', COALESCE((SELECT MAX(id) FROM stations), 1), true);
SELECT setval('team_stations_id_seq', COALESCE((SELECT MAX(id) FROM team_stations), 1), true);
SELECT setval('materials_id_seq', COALESCE((SELECT MAX(id) FROM materials), 1), true);
SELECT setval('questions_id_seq', COALESCE((SELECT MAX(id) FROM questions), 1), true);
SQL);
    $pdo->commit();
}

function json_body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') {
        return [];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function respond(array $data, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(string $message, int $status = 400): never
{
    respond(['ok' => false, 'error' => $message], $status);
}

function current_game_id(): int
{
    $id = isset($_GET['game_id']) ? (int) $_GET['game_id'] : 0;
    if ($id > 0) {
        return $id;
    }
    $row = db()->query('SELECT id FROM games ORDER BY id DESC LIMIT 1')->fetch();
    return $row ? (int) $row['id'] : 0;
}

function fetch_games(): array
{
    $rows = db()->query('
        SELECT g.*,
          COALESCE((SELECT COUNT(*) FROM teams t WHERE t.game_id = g.id), 0) AS team_count,
          COALESCE((SELECT COUNT(*) FROM stations s WHERE s.game_id = g.id), 0) AS station_count
        FROM games g
        ORDER BY g.game_date DESC, g.id DESC
    ')->fetchAll();

    foreach ($rows as &$row) {
        $row['remaining_seconds'] = computed_remaining($row);
        $row['timer_running'] = pg_bool($row['timer_running']);
    }

    return $rows;
}

function computed_remaining(array $game): int
{
    $remaining = (int) $game['timer_remaining_seconds'];
    if (pg_bool($game['timer_running'])) {
        $updated = strtotime((string) $game['timer_updated_at']);
        $elapsed = max(0, time() - $updated);
        $remaining = max(0, $remaining - $elapsed);
    }
    return $remaining;
}

function pg_bool(mixed $value): bool
{
    return $value === true || $value === 1 || $value === '1' || $value === 't' || $value === 'true';
}

function fetch_state(int $gameId): array
{
    $pdo = db();
    $stmt = $pdo->prepare('SELECT * FROM games WHERE id = ?');
    $stmt->execute([$gameId]);
    $game = $stmt->fetch();
    if (!$game) {
        fail('Nie znaleziono gry', 404);
    }
    $game['remaining_seconds'] = computed_remaining($game);
    $game['timer_running'] = pg_bool($game['timer_running']);
    if ($game['timer_running'] && $game['remaining_seconds'] === 0) {
        $pdo->prepare("UPDATE games SET timer_running = FALSE, status = 'finished', timer_remaining_seconds = 0, timer_updated_at = NOW() WHERE id = ?")->execute([$gameId]);
        $game['timer_running'] = false;
        $game['status'] = 'finished';
        $game['timer_remaining_seconds'] = 0;
    }

    $teams = $pdo->prepare('
        SELECT t.*,
          COALESCE(SUM(ts.points), 0) AS total_points,
          COALESCE(AVG(NULLIF(ts.cooperation, 0)), 0) AS avg_cooperation,
          COALESCE(SUM(CASE WHEN ts.correct THEN 1 ELSE 0 END), 0) AS correct_count,
          COALESCE(COUNT(ts.id), 0) AS visited_count,
          COALESCE(COUNT(CASE WHEN ts.finished_at IS NOT NULL THEN 1 END), 0) AS finished_count
        FROM teams t
        LEFT JOIN team_stations ts ON ts.team_id = t.id
        WHERE t.game_id = ?
        GROUP BY t.id
        ORDER BY total_points DESC, t.name ASC
    ');
    $teams->execute([$gameId]);

    $stations = $pdo->prepare('SELECT * FROM stations WHERE game_id = ? ORDER BY station_order ASC, id ASC');
    $stations->execute([$gameId]);

    $scores = $pdo->prepare('
        SELECT ts.*, s.title AS station_title, t.name AS team_name
        FROM team_stations ts
        JOIN stations s ON s.id = ts.station_id
        JOIN teams t ON t.id = ts.team_id
        WHERE t.game_id = ?
        ORDER BY COALESCE(ts.finished_at, ts.started_at) ASC
    ');
    $scores->execute([$gameId]);
    $scoreRows = $scores->fetchAll();
    foreach ($scoreRows as &$scoreRow) {
        $scoreRow['correct'] = pg_bool($scoreRow['correct']);
    }

    $materials = $pdo->prepare('
        SELECT m.*, s.title AS station_title
        FROM materials m
        JOIN stations s ON s.id = m.station_id
        WHERE s.game_id = ?
        ORDER BY m.id DESC
    ');
    $materials->execute([$gameId]);

    $questions = $pdo->prepare('
        SELECT q.*, s.title AS station_title
        FROM questions q
        JOIN stations s ON s.id = q.station_id
        WHERE s.game_id = ?
        ORDER BY q.id DESC
    ');
    $questions->execute([$gameId]);

    return [
        'ok' => true,
        'games' => fetch_games(),
        'game' => $game,
        'teams' => $teams->fetchAll(),
        'stations' => $stations->fetchAll(),
        'scores' => $scoreRows,
        'materials' => $materials->fetchAll(),
        'questions' => $questions->fetchAll(),
        'app_url' => getenv('APP_URL') ?: '',
    ];
}

function template_stations(string $template): array
{
    $sets = [
        'Polska' => ['Start - boisko', 'Wawel', 'Mazury', 'Tatry', 'Gdansk', 'Meta - swietlica'],
        'Wlochy' => ['Start', 'Koloseum', 'Wieza w Pizie', 'Pompeje', 'Fontanna', 'Meta'],
        'Włochy' => ['Start', 'Koloseum', 'Wieza w Pizie', 'Pompeje', 'Fontanna', 'Meta'],
        'Olimp' => ['Start', 'Zeus', 'Atena', 'Apollo', 'Hermes', 'Hera', 'Meta'],
        'Wlasna' => ['Start', 'Stacja 1', 'Meta'],
        'Własna' => ['Start', 'Stacja 1', 'Meta'],
    ];
    return $sets[$template] ?? $sets['Polska'];
}

function create_game(array $data): void
{
    $id = (int) ($data['id'] ?? 0);
    $name = trim((string) ($data['name'] ?? 'Nowa gra'));
    $template = trim((string) ($data['template'] ?? 'Polska'));
    $date = (string) ($data['game_date'] ?? date('Y-m-d'));
    $start = (string) ($data['start_time'] ?? '12:00');
    $duration = max(5, min(600, (int) ($data['duration_minutes'] ?? 90)));
    $useTemplate = !empty($data['use_template']);

    if ($id > 0) {
        $stmt = db()->prepare('
            UPDATE games
            SET name = ?, template = ?, game_date = ?, start_time = ?, duration_minutes = ?,
                timer_remaining_seconds = CASE WHEN timer_running THEN timer_remaining_seconds ELSE ? END
            WHERE id = ?
        ');
        $stmt->execute([$name, $template, $date, $start, $duration, $duration * 60, $id]);
        respond(fetch_state($id));
    }

    $pdo = db();
    $pdo->beginTransaction();
    $stmt = $pdo->prepare('
        INSERT INTO games (name, template, game_date, start_time, duration_minutes, timer_remaining_seconds)
        VALUES (?, ?, ?, ?, ?, ?)
        RETURNING id
    ');
    $stmt->execute([$name, $template, $date, $start, $duration, $duration * 60]);
    $gameId = (int) $stmt->fetchColumn();

    if ($useTemplate) {
        $lat = (float) ($data['base_lat'] ?? 52.22977);
        $lng = (float) ($data['base_lng'] ?? 21.01178);
        $stationStmt = $pdo->prepare('
            INSERT INTO stations (game_id, title, station_order, lat, lng, qr_code)
            VALUES (?, ?, ?, ?, ?, ?)
        ');
        foreach (template_stations($template) as $index => $title) {
            $stationStmt->execute([
                $gameId,
                $title,
                $index + 1,
                $lat + (($index % 3) - 1) * 0.0014,
                $lng + (floor($index / 3) - 1) * 0.0014,
                'station-' . $gameId . '-' . bin2hex(random_bytes(4)),
            ]);
        }
    }
    $pdo->commit();

    respond(fetch_state($gameId));
}

function delete_game(array $data): void
{
    $id = (int) ($data['id'] ?? 0);
    if ($id <= 0) {
        fail('Brakuje ID gry');
    }
    db()->prepare('DELETE FROM games WHERE id = ?')->execute([$id]);
    $nextId = current_game_id();
    if ($nextId <= 0) {
        create_game([
            'name' => 'Nowa gra',
            'template' => 'Własna',
            'game_date' => date('Y-m-d'),
            'start_time' => '12:00',
            'duration_minutes' => 90,
        ]);
    }
    respond(fetch_state($nextId));
}

function set_timer(array $data): void
{
    $gameId = (int) ($data['game_id'] ?? current_game_id());
    $command = (string) ($data['command'] ?? '');
    $pdo = db();

    $stmt = $pdo->prepare('SELECT * FROM games WHERE id = ? FOR UPDATE');
    $pdo->beginTransaction();
    $stmt->execute([$gameId]);
    $game = $stmt->fetch();
    if (!$game) {
        $pdo->rollBack();
        fail('Nie znaleziono gry', 404);
    }

    $remaining = computed_remaining($game);
    if ($command === 'start') {
        $pdo->prepare("UPDATE games SET timer_running = TRUE, timer_remaining_seconds = ?, timer_updated_at = NOW(), status = 'running' WHERE id = ?")->execute([$remaining, $gameId]);
    } elseif ($command === 'pause') {
        $pdo->prepare("UPDATE games SET timer_running = FALSE, timer_remaining_seconds = ?, timer_updated_at = NOW(), status = 'paused' WHERE id = ?")->execute([$remaining, $gameId]);
    } elseif ($command === 'reset') {
        $seconds = (int) $game['duration_minutes'] * 60;
        $pdo->prepare("UPDATE games SET timer_running = FALSE, timer_remaining_seconds = ?, timer_updated_at = NOW(), status = 'draft' WHERE id = ?")->execute([$seconds, $gameId]);
    } elseif ($command === 'duration') {
        $minutes = max(5, min(600, (int) ($data['duration_minutes'] ?? $game['duration_minutes'])));
        $pdo->prepare("UPDATE games SET duration_minutes = ?, timer_running = FALSE, timer_remaining_seconds = ?, timer_updated_at = NOW(), status = 'draft' WHERE id = ?")->execute([$minutes, $minutes * 60, $gameId]);
    } else {
        $pdo->rollBack();
        fail('Nieznana komenda timera');
    }
    $pdo->commit();
    respond(fetch_state($gameId));
}

function create_team(): void
{
    $gameId = (int) ($_POST['game_id'] ?? current_game_id());
    $name = trim((string) ($_POST['name'] ?? ''));
    $color = trim((string) ($_POST['color'] ?? '#0f766e'));
    if ($name === '') {
        fail('Podaj nazwe druzyny');
    }

    $avatarPath = null;
    if (isset($_FILES['avatar']) && is_uploaded_file($_FILES['avatar']['tmp_name'])) {
        $info = getimagesize($_FILES['avatar']['tmp_name']);
        if ($info === false) {
            fail('Plik avatara nie jest obrazem');
        }
        $ext = image_type_to_extension($info[2], false) ?: 'jpg';
        $file = 'uploads/avatars/team-' . time() . '-' . bin2hex(random_bytes(4)) . '.' . $ext;
        $target = __DIR__ . '/' . $file;
        if (!move_uploaded_file($_FILES['avatar']['tmp_name'], $target)) {
            fail('Nie udalo sie zapisac avatara', 500);
        }
        $avatarPath = $file;
    }

    $stmt = db()->prepare('INSERT INTO teams (game_id, name, color, avatar_path) VALUES (?, ?, ?, ?)');
    $stmt->execute([$gameId, $name, $color, $avatarPath]);
    respond(fetch_state($gameId));
}

function save_station(array $data): void
{
    $gameId = (int) ($data['game_id'] ?? current_game_id());
    $id = (int) ($data['id'] ?? 0);
    $title = trim((string) ($data['title'] ?? ''));
    if ($title === '') {
        fail('Podaj nazwe stacji');
    }
    $order = max(1, (int) ($data['station_order'] ?? 1));
    $latValue = $data['lat'] ?? null;
    $lngValue = $data['lng'] ?? null;
    $lat = $latValue === '' || $latValue === null ? null : (float) $latValue;
    $lng = $lngValue === '' || $lngValue === null ? null : (float) $lngValue;

    if ($id > 0) {
        $stmt = db()->prepare('UPDATE stations SET title = ?, station_order = ?, lat = ?, lng = ? WHERE id = ? AND game_id = ?');
        $stmt->execute([$title, $order, $lat, $lng, $id, $gameId]);
    } else {
        $stmt = db()->prepare('INSERT INTO stations (game_id, title, station_order, lat, lng, qr_code) VALUES (?, ?, ?, ?, ?, ?)');
        $stmt->execute([$gameId, $title, $order, $lat, $lng, 'station-' . $gameId . '-' . bin2hex(random_bytes(5))]);
    }
    respond(fetch_state($gameId));
}

function delete_station(array $data): void
{
    $gameId = (int) ($data['game_id'] ?? current_game_id());
    $id = (int) ($data['id'] ?? 0);
    db()->prepare('DELETE FROM stations WHERE id = ? AND game_id = ?')->execute([$id, $gameId]);
    respond(fetch_state($gameId));
}

function save_score(array $data): void
{
    $teamId = (int) ($data['team_id'] ?? 0);
    $stationId = (int) ($data['station_id'] ?? 0);
    $points = max(0, min(10, (int) ($data['points'] ?? 0)));
    $correct = !empty($data['correct']) ? 'true' : 'false';
    $cooperation = max(0, min(5, (int) ($data['cooperation'] ?? 0)));
    $comment = trim((string) ($data['comment'] ?? ''));
    if ($teamId <= 0 || $stationId <= 0) {
        fail('Brakuje druzyny albo stacji');
    }

    $pdo = db();
    $stmt = $pdo->prepare('
        INSERT INTO team_stations (team_id, station_id, points, correct, cooperation, started_at, finished_at, comment)
        VALUES (?, ?, ?, ?, ?, NOW(), NOW(), ?)
        ON CONFLICT (team_id, station_id)
        DO UPDATE SET points = EXCLUDED.points, correct = EXCLUDED.correct, cooperation = EXCLUDED.cooperation, finished_at = NOW(), comment = EXCLUDED.comment
    ');
    $stmt->execute([$teamId, $stationId, $points, $correct, $cooperation, $comment]);

    $gameIdStmt = $pdo->prepare('SELECT game_id FROM teams WHERE id = ?');
    $gameIdStmt->execute([$teamId]);
    $gameId = (int) $gameIdStmt->fetchColumn();
    respond(fetch_state($gameId));
}

function save_material(array $data): void
{
    $stationId = (int) ($data['station_id'] ?? 0);
    $title = trim((string) ($data['title'] ?? ''));
    if ($stationId <= 0 || $title === '') {
        fail('Wybierz stacje i podaj tytul materialu');
    }
    $url = trim((string) ($data['url'] ?? ''));
    $notes = trim((string) ($data['notes'] ?? ''));
    db()->prepare('INSERT INTO materials (station_id, title, url, notes) VALUES (?, ?, ?, ?)')->execute([$stationId, $title, $url, $notes]);
    $stmt = db()->prepare('SELECT game_id FROM stations WHERE id = ?');
    $stmt->execute([$stationId]);
    respond(fetch_state((int) $stmt->fetchColumn()));
}

function save_question(array $data): void
{
    $stationId = (int) ($data['station_id'] ?? 0);
    $question = trim((string) ($data['question'] ?? ''));
    if ($stationId <= 0 || $question === '') {
        fail('Wybierz stacje i wpisz pytanie');
    }
    $answer = trim((string) ($data['answer'] ?? ''));
    $maxPoints = max(1, min(100, (int) ($data['max_points'] ?? 10)));
    db()->prepare('INSERT INTO questions (station_id, question, answer, max_points) VALUES (?, ?, ?, ?)')->execute([$stationId, $question, $answer, $maxPoints]);
    $stmt = db()->prepare('SELECT game_id FROM stations WHERE id = ?');
    $stmt->execute([$stationId]);
    respond(fetch_state((int) $stmt->fetchColumn()));
}

function station_by_qr(string $code): void
{
    $stmt = db()->prepare('SELECT game_id, id FROM stations WHERE qr_code = ?');
    $stmt->execute([$code]);
    $row = $stmt->fetch();
    if (!$row) {
        fail('Nie znaleziono stacji dla tego kodu QR', 404);
    }
    respond(['ok' => true, 'game_id' => (int) $row['game_id'], 'station_id' => (int) $row['id']]);
}

try {
    $action = (string) ($_GET['action'] ?? 'state');
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    if ($method === 'GET' && $action === 'state') {
        respond(fetch_state(current_game_id()));
    }
    if ($method === 'GET' && $action === 'games') {
        respond(['ok' => true, 'games' => fetch_games()]);
    }
    if ($method === 'GET' && $action === 'stationByQr') {
        station_by_qr((string) ($_GET['code'] ?? ''));
    }

    $data = json_body();
    if ($method === 'POST' && $action === 'game') {
        create_game($data);
    } elseif ($method === 'POST' && $action === 'deleteGame') {
        delete_game($data);
    } elseif ($method === 'POST' && $action === 'timer') {
        set_timer($data);
    } elseif ($method === 'POST' && $action === 'team') {
        create_team();
    } elseif ($method === 'POST' && $action === 'station') {
        save_station($data);
    } elseif ($method === 'POST' && $action === 'deleteStation') {
        delete_station($data);
    } elseif ($method === 'POST' && $action === 'score') {
        save_score($data);
    } elseif ($method === 'POST' && $action === 'material') {
        save_material($data);
    } elseif ($method === 'POST' && $action === 'question') {
        save_question($data);
    } else {
        fail('Nieznany endpoint', 404);
    }
} catch (Throwable $e) {
    fail($e->getMessage(), 500);
}
