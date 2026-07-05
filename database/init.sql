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
  (2, 'Zdjęcie Koloseum', 'https://pl.wikipedia.org/wiki/Koloseum', 'Materiał pomocniczy dla wychowawcy'),
  (3, 'Krzywa Wieża', 'https://pl.wikipedia.org/wiki/Krzywa_Wie%C5%BCa_w_Pizie', 'Krótka ciekawostka do pytania')
ON CONFLICT DO NOTHING;

INSERT INTO questions (station_id, question, answer, max_points)
VALUES
  (2, 'W jakim mieście znajduje się Koloseum?', 'Rzym', 10),
  (3, 'Dlaczego Wieża w Pizie jest znana?', 'Jest przechylona', 10)
ON CONFLICT DO NOTHING;

SELECT setval('games_id_seq', COALESCE((SELECT MAX(id) FROM games), 1), true);
SELECT setval('teams_id_seq', COALESCE((SELECT MAX(id) FROM teams), 1), true);
SELECT setval('stations_id_seq', COALESCE((SELECT MAX(id) FROM stations), 1), true);
SELECT setval('team_stations_id_seq', COALESCE((SELECT MAX(id) FROM team_stations), 1), true);
SELECT setval('materials_id_seq', COALESCE((SELECT MAX(id) FROM materials), 1), true);
SELECT setval('questions_id_seq', COALESCE((SELECT MAX(id) FROM questions), 1), true);
