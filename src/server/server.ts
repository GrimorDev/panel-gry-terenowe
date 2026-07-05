import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response, type NextFunction } from "express";
import pg from "pg";

const { Pool } = pg;

const port = Number(process.env.PORT || 80);
const sessionSecret = process.env.SESSION_SECRET || "change-this-secret-in-portainer";
const adminEmail = process.env.ADMIN_EMAIL || "admin@hufc.local";
const adminPassword = process.env.ADMIN_PASSWORD || "hufc1234";

const pool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || "field_games",
  user: process.env.DB_USER || "field_games",
  password: process.env.DB_PASS || "field_games_password"
});

type User = { id: number; email: string; name: string; role: string };

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

function hashPassword(password: string, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string) {
  const [salt, original] = stored.split(":");
  if (!salt || !original) return false;
  const hash = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(original, "hex"), hash);
}

function sign(value: string) {
  return crypto.createHmac("sha256", sessionSecret).update(value).digest("hex");
}

function sessionCookie(user: User) {
  const payload = Buffer.from(JSON.stringify({ id: user.id, email: user.email, name: user.name, role: user.role })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function readCookies(req: Request) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(header.split(";").map((item) => item.trim().split("=")).filter(([key]) => key));
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = readCookies(req).hufc_session;
  if (!token) return res.status(401).json({ ok: false, error: "Brak logowania" });
  const [payload, signature] = token.split(".");
  if (!payload || signature !== sign(payload)) return res.status(401).json({ ok: false, error: "Sesja wygasła" });
  try {
    req.user = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: "Sesja wygasła" });
  }
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(180) UNIQUE NOT NULL,
      name VARCHAR(160) NOT NULL,
      role VARCHAR(40) NOT NULL DEFAULT 'wychowawca',
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS cohorts (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      caretaker VARCHAR(160) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS wards (
      id SERIAL PRIMARY KEY,
      name VARCHAR(160) NOT NULL,
      age INTEGER NOT NULL DEFAULT 12,
      parent_name VARCHAR(160) NOT NULL DEFAULT '',
      contact VARCHAR(80) NOT NULL DEFAULT '',
      cohort_id INTEGER REFERENCES cohorts(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      title VARCHAR(180) NOT NULL,
      session_date DATE NOT NULL,
      location VARCHAR(220) NOT NULL DEFAULT '',
      attendance INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      cohort_id INTEGER REFERENCES cohorts(id) ON DELETE SET NULL,
      scope VARCHAR(20) NOT NULL DEFAULT 'grupa',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS session_photos (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      title VARCHAR(160) NOT NULL,
      color VARCHAR(30) NOT NULL DEFAULT 'green',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS games (
      id SERIAL PRIMARY KEY,
      name VARCHAR(160) NOT NULL,
      template VARCHAR(60) NOT NULL DEFAULT 'Własna',
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
      color VARCHAR(20) NOT NULL DEFAULT '#1e5c46',
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
  `);

  const users = await pool.query("SELECT COUNT(*)::int AS count FROM users");
  if (users.rows[0].count === 0) {
    await pool.query(
      "INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4)",
      [adminEmail, "Administrator hufca", "administrator", hashPassword(adminPassword)]
    );
  }

  const games = await pool.query("SELECT COUNT(*)::int AS count FROM games");
  if (games.rows[0].count === 0) {
    await pool.query(
      "INSERT INTO games (name, template, duration_minutes, timer_remaining_seconds) VALUES ($1, $2, $3, $4)",
      ["Pierwsza gra terenowa", "Własna", 90, 5400]
    );
  }

  const cohorts = await pool.query("SELECT COUNT(*)::int AS count FROM cohorts");
  if (cohorts.rows[0].count === 0) {
    await pool.query(`
      INSERT INTO cohorts (id, name, caretaker) VALUES
        (1, 'Rocznik 2013', 'Anna Kowalska'),
        (2, 'Rocznik 2014', 'Anna Kowalska'),
        (3, 'Rocznik 2015', 'Tomasz Nowicki')
      ON CONFLICT DO NOTHING;

      INSERT INTO wards (name, age, parent_name, contact, cohort_id) VALUES
        ('Julia Nowak', 12, 'Anna Nowak', '600 111 222', 2),
        ('Kacper Wiśniewski', 13, 'Marek Wiśniewski', '601 222 333', 1),
        ('Zofia Kowalska', 11, 'Ewa Kowalska', '602 333 444', 3),
        ('Antoni Zieliński', 12, 'Piotr Zieliński', '603 444 555', 2),
        ('Maja Lewandowska', 13, 'Katarzyna Lewandowska', '604 555 666', 1);

      INSERT INTO sessions (title, session_date, location, attendance, total, cohort_id, scope) VALUES
        ('Zbiórka Wilków', CURRENT_DATE + INTERVAL '7 days', 'Harcówka, ul. Leśna 4', 9, 12, 2, 'grupa'),
        ('Zbiórka Lisów', CURRENT_DATE + INTERVAL '9 days', 'Harcówka, ul. Leśna 4', 11, 11, 1, 'grupa'),
        ('Rajd nad jezioro', CURRENT_DATE + INTERVAL '14 days', 'Jezioro Kaczor, plaża wschodnia', 22, 28, NULL, 'grupa'),
        ('Zbiórka Sów', CURRENT_DATE + INTERVAL '16 days', 'Harcówka, sala 2', 7, 10, 3, 'moja');

      INSERT INTO session_photos (session_id, title, color)
      SELECT id, title, CASE WHEN id % 3 = 0 THEN 'accent' WHEN id % 2 = 0 THEN 'sand' ELSE 'green' END
      FROM sessions
      LIMIT 4;

      SELECT setval('cohorts_id_seq', (SELECT MAX(id) FROM cohorts));
    `);
  }
}

function remaining(game: any) {
  let seconds = Number(game.timer_remaining_seconds || 0);
  if (game.timer_running) {
    const updated = new Date(game.timer_updated_at).getTime();
    seconds = Math.max(0, seconds - Math.floor((Date.now() - updated) / 1000));
  }
  return seconds;
}

async function gamesList() {
  const { rows } = await pool.query(`
    SELECT g.*,
      COALESCE((SELECT COUNT(*) FROM teams t WHERE t.game_id = g.id), 0)::int AS team_count,
      COALESCE((SELECT COUNT(*) FROM stations s WHERE s.game_id = g.id), 0)::int AS station_count
    FROM games g
    ORDER BY g.game_date DESC, g.id DESC
  `);
  return rows.map((game) => ({ ...game, remaining_seconds: remaining(game) }));
}

async function state(gameId?: number) {
  const selectedId = gameId || Number((await pool.query("SELECT id FROM games ORDER BY id DESC LIMIT 1")).rows[0]?.id);
  const gameResult = await pool.query("SELECT * FROM games WHERE id = $1", [selectedId]);
  const game = gameResult.rows[0];
  if (!game) throw new Error("Nie znaleziono gry");
  game.remaining_seconds = remaining(game);

  const [teams, stations, scores, materials, questions, games, cohorts, wards, sessions, photos] = await Promise.all([
    pool.query(`
      SELECT t.*,
        COALESCE(SUM(ts.points), 0)::int AS total_points,
        COALESCE(AVG(NULLIF(ts.cooperation, 0)), 0)::float AS avg_cooperation,
        COALESCE(SUM(CASE WHEN ts.correct THEN 1 ELSE 0 END), 0)::int AS correct_count,
        COALESCE(COUNT(CASE WHEN ts.finished_at IS NOT NULL THEN 1 END), 0)::int AS finished_count
      FROM teams t
      LEFT JOIN team_stations ts ON ts.team_id = t.id
      WHERE t.game_id = $1
      GROUP BY t.id
      ORDER BY total_points DESC, t.name ASC
    `, [game.id]),
    pool.query("SELECT * FROM stations WHERE game_id = $1 ORDER BY station_order ASC, id ASC", [game.id]),
    pool.query(`
      SELECT ts.*, s.title AS station_title, t.name AS team_name
      FROM team_stations ts
      JOIN stations s ON s.id = ts.station_id
      JOIN teams t ON t.id = ts.team_id
      WHERE t.game_id = $1
      ORDER BY COALESCE(ts.finished_at, ts.started_at) ASC
    `, [game.id]),
    pool.query(`
      SELECT m.*, s.title AS station_title
      FROM materials m JOIN stations s ON s.id = m.station_id
      WHERE s.game_id = $1 ORDER BY m.id DESC
    `, [game.id]),
    pool.query(`
      SELECT q.*, s.title AS station_title
      FROM questions q JOIN stations s ON s.id = q.station_id
      WHERE s.game_id = $1 ORDER BY q.id DESC
    `, [game.id]),
    gamesList(),
    pool.query(`
      SELECT c.*,
        COALESCE((SELECT COUNT(*) FROM wards w WHERE w.cohort_id = c.id), 0)::int AS ward_count
      FROM cohorts c
      ORDER BY c.name
    `),
    pool.query(`
      SELECT w.*, c.name AS cohort_name
      FROM wards w
      LEFT JOIN cohorts c ON c.id = w.cohort_id
      ORDER BY w.name
    `),
    pool.query(`
      SELECT s.*, c.name AS cohort_name
      FROM sessions s
      LEFT JOIN cohorts c ON c.id = s.cohort_id
      ORDER BY s.session_date ASC, s.id ASC
    `),
    pool.query(`
      SELECT p.*, s.title AS session_title, s.session_date
      FROM session_photos p
      JOIN sessions s ON s.id = p.session_id
      ORDER BY s.session_date DESC, p.id ASC
    `)
  ]);

  return {
    ok: true,
    game,
    games,
    teams: teams.rows,
    stations: stations.rows,
    scores: scores.rows,
    materials: materials.rows,
    questions: questions.rows,
    cohorts: cohorts.rows,
    wards: wards.rows,
    sessions: sessions.rows,
    photos: photos.rows
  };
}

function templateStations(template: string) {
  const data: Record<string, string[]> = {
    Polska: ["Start", "Wawel", "Mazury", "Tatry", "Gdańsk", "Meta"],
    Włochy: ["Start", "Koloseum", "Wieża w Pizie", "Pompeje", "Fontanna", "Meta"],
    Olimp: ["Start", "Zeus", "Atena", "Apollo", "Hermes", "Meta"],
    Własna: []
  };
  return data[template] || [];
}

const app = express();
app.use(express.json({ limit: "3mb" }));

app.post("/api/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const result = await pool.query("SELECT * FROM users WHERE lower(email) = $1", [email]);
  const user = result.rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ ok: false, error: "Nieprawidłowy e-mail albo hasło" });
  }
  const safeUser = { id: user.id, email: user.email, name: user.name, role: user.role };
  res.setHeader("Set-Cookie", `hufc_session=${sessionCookie(safeUser)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
  return res.json({ ok: true, user: safeUser });
});

app.post("/api/logout", (_req, res) => {
  res.setHeader("Set-Cookie", "hufc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => res.json({ ok: true, user: req.user }));

app.use("/api", requireAuth);

app.get("/api/state", async (req, res) => {
  try {
    res.json(await state(req.query.gameId ? Number(req.query.gameId) : undefined));
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Błąd serwera" });
  }
});

app.post("/api/games", async (req, res) => {
  const id = Number(req.body.id || 0);
  const name = String(req.body.name || "Nowa gra").trim();
  const template = String(req.body.template || "Własna");
  const duration = Math.max(5, Math.min(600, Number(req.body.duration_minutes || 90)));
  const gameDate = String(req.body.game_date || new Date().toISOString().slice(0, 10));
  const startTime = String(req.body.start_time || "12:00");

  if (id) {
    await pool.query(
      `UPDATE games SET name=$1, template=$2, game_date=$3, start_time=$4, duration_minutes=$5,
       timer_remaining_seconds = CASE WHEN timer_running THEN timer_remaining_seconds ELSE $6 END WHERE id=$7`,
      [name, template, gameDate, startTime, duration, duration * 60, id]
    );
    return res.json(await state(id));
  }

  const result = await pool.query(
    "INSERT INTO games (name, template, game_date, start_time, duration_minutes, timer_remaining_seconds) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
    [name, template, gameDate, startTime, duration, duration * 60]
  );
  const gameId = Number(result.rows[0].id);
  if (req.body.use_template) {
    const baseLat = Number(req.body.base_lat || 52.22977);
    const baseLng = Number(req.body.base_lng || 21.01178);
    for (const [index, title] of templateStations(template).entries()) {
      await pool.query(
        "INSERT INTO stations (game_id, title, station_order, lat, lng, qr_code) VALUES ($1,$2,$3,$4,$5,$6)",
        [gameId, title, index + 1, baseLat + ((index % 3) - 1) * 0.0014, baseLng + (Math.floor(index / 3) - 1) * 0.0014, `station-${gameId}-${crypto.randomBytes(4).toString("hex")}`]
      );
    }
  }
  return res.json(await state(gameId));
});

app.delete("/api/games/:id", async (req, res) => {
  await pool.query("DELETE FROM games WHERE id = $1", [Number(req.params.id)]);
  res.json(await state());
});

app.post("/api/teams", async (req, res) => {
  await pool.query("INSERT INTO teams (game_id, name, color) VALUES ($1,$2,$3)", [Number(req.body.game_id), String(req.body.name), String(req.body.color || "#1e5c46")]);
  res.json(await state(Number(req.body.game_id)));
});

app.delete("/api/teams/:id", async (req, res) => {
  const result = await pool.query("DELETE FROM teams WHERE id = $1 RETURNING game_id", [Number(req.params.id)]);
  res.json(await state(Number(result.rows[0]?.game_id || req.query.gameId)));
});

app.post("/api/wards", async (req, res) => {
  const id = Number(req.body.id || 0);
  const values = [String(req.body.name || ""), Number(req.body.age || 12), String(req.body.parent_name || ""), String(req.body.contact || ""), Number(req.body.cohort_id || 0) || null];
  if (!values[0]) return res.status(400).json({ ok: false, error: "Podaj imię i nazwisko" });
  if (id) {
    await pool.query("UPDATE wards SET name=$1, age=$2, parent_name=$3, contact=$4, cohort_id=$5 WHERE id=$6", [...values, id]);
  } else {
    await pool.query("INSERT INTO wards (name, age, parent_name, contact, cohort_id) VALUES ($1,$2,$3,$4,$5)", values);
  }
  res.json(await state(Number(req.body.game_id || 0) || undefined));
});

app.delete("/api/wards/:id", async (req, res) => {
  await pool.query("DELETE FROM wards WHERE id=$1", [Number(req.params.id)]);
  res.json(await state(req.query.gameId ? Number(req.query.gameId) : undefined));
});

app.post("/api/sessions", async (req, res) => {
  const id = Number(req.body.id || 0);
  const values = [
    String(req.body.title || ""),
    String(req.body.session_date || new Date().toISOString().slice(0, 10)),
    String(req.body.location || ""),
    Number(req.body.attendance || 0),
    Number(req.body.total || 0),
    Number(req.body.cohort_id || 0) || null,
    String(req.body.scope || "grupa")
  ];
  if (!values[0]) return res.status(400).json({ ok: false, error: "Podaj tytuł zbiórki" });
  if (id) {
    await pool.query("UPDATE sessions SET title=$1, session_date=$2, location=$3, attendance=$4, total=$5, cohort_id=$6, scope=$7 WHERE id=$8", [...values, id]);
  } else {
    await pool.query("INSERT INTO sessions (title, session_date, location, attendance, total, cohort_id, scope) VALUES ($1,$2,$3,$4,$5,$6,$7)", values);
  }
  res.json(await state(Number(req.body.game_id || 0) || undefined));
});

app.delete("/api/sessions/:id", async (req, res) => {
  await pool.query("DELETE FROM sessions WHERE id=$1", [Number(req.params.id)]);
  res.json(await state(req.query.gameId ? Number(req.query.gameId) : undefined));
});

app.post("/api/photos", async (req, res) => {
  await pool.query(
    "INSERT INTO session_photos (session_id, title, color) VALUES ($1,$2,$3)",
    [Number(req.body.session_id), String(req.body.title || "Zdjęcie"), String(req.body.color || "green")]
  );
  res.json(await state(Number(req.body.game_id || 0) || undefined));
});

app.post("/api/stations", async (req, res) => {
  const gameId = Number(req.body.game_id);
  const id = Number(req.body.id || 0);
  const title = String(req.body.title || "").trim();
  const order = Math.max(1, Number(req.body.station_order || 1));
  const lat = req.body.lat === "" || req.body.lat == null ? null : Number(req.body.lat);
  const lng = req.body.lng === "" || req.body.lng == null ? null : Number(req.body.lng);
  if (!title) return res.status(400).json({ ok: false, error: "Podaj nazwę stacji" });
  if (id) {
    await pool.query("UPDATE stations SET title=$1, station_order=$2, lat=$3, lng=$4 WHERE id=$5 AND game_id=$6", [title, order, lat, lng, id, gameId]);
  } else {
    await pool.query("INSERT INTO stations (game_id, title, station_order, lat, lng, qr_code) VALUES ($1,$2,$3,$4,$5,$6)", [gameId, title, order, lat, lng, `station-${gameId}-${crypto.randomBytes(5).toString("hex")}`]);
  }
  res.json(await state(gameId));
});

app.delete("/api/stations/:id", async (req, res) => {
  const result = await pool.query("DELETE FROM stations WHERE id = $1 RETURNING game_id", [Number(req.params.id)]);
  res.json(await state(Number(result.rows[0]?.game_id || req.query.gameId)));
});

app.post("/api/scores", async (req, res) => {
  const teamId = Number(req.body.team_id);
  const stationId = Number(req.body.station_id);
  await pool.query(`
    INSERT INTO team_stations (team_id, station_id, points, correct, cooperation, started_at, finished_at, comment)
    VALUES ($1,$2,$3,$4,$5,NOW(),NOW(),$6)
    ON CONFLICT (team_id, station_id)
    DO UPDATE SET points=$3, correct=$4, cooperation=$5, finished_at=NOW(), comment=$6
  `, [teamId, stationId, Number(req.body.points || 0), Boolean(req.body.correct), Number(req.body.cooperation || 0), String(req.body.comment || "")]);
  const gameId = Number((await pool.query("SELECT game_id FROM teams WHERE id=$1", [teamId])).rows[0].game_id);
  res.json(await state(gameId));
});

app.post("/api/timer", async (req, res) => {
  const gameId = Number(req.body.game_id);
  const game = (await pool.query("SELECT * FROM games WHERE id=$1", [gameId])).rows[0];
  const left = remaining(game);
  if (req.body.command === "start") {
    await pool.query("UPDATE games SET timer_running=TRUE, timer_remaining_seconds=$1, timer_updated_at=NOW(), status='running' WHERE id=$2", [left, gameId]);
  } else if (req.body.command === "pause") {
    await pool.query("UPDATE games SET timer_running=FALSE, timer_remaining_seconds=$1, timer_updated_at=NOW(), status='paused' WHERE id=$2", [left, gameId]);
  } else if (req.body.command === "reset") {
    await pool.query("UPDATE games SET timer_running=FALSE, timer_remaining_seconds=duration_minutes*60, timer_updated_at=NOW(), status='draft' WHERE id=$1", [gameId]);
  }
  res.json(await state(gameId));
});

app.post("/api/materials", async (req, res) => {
  const stationId = Number(req.body.station_id);
  await pool.query("INSERT INTO materials (station_id, title, url, notes) VALUES ($1,$2,$3,$4)", [stationId, String(req.body.title), String(req.body.url || ""), String(req.body.notes || "")]);
  const gameId = Number((await pool.query("SELECT game_id FROM stations WHERE id=$1", [stationId])).rows[0].game_id);
  res.json(await state(gameId));
});

app.post("/api/questions", async (req, res) => {
  const stationId = Number(req.body.station_id);
  await pool.query("INSERT INTO questions (station_id, question, answer, max_points) VALUES ($1,$2,$3,$4)", [stationId, String(req.body.question), String(req.body.answer || ""), Number(req.body.max_points || 10)]);
  const gameId = Number((await pool.query("SELECT game_id FROM stations WHERE id=$1", [stationId])).rows[0].game_id);
  res.json(await state(gameId));
});

app.get("/api/station-by-qr", async (req, res) => {
  const code = String(req.query.code || "");
  const result = await pool.query("SELECT id, game_id FROM stations WHERE qr_code=$1", [code]);
  if (!result.rows[0]) return res.status(404).json({ ok: false, error: "Nie znaleziono stacji" });
  res.json({ ok: true, station_id: result.rows[0].id, game_id: result.rows[0].game_id });
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(__dirname, "../client");
app.use(express.static(clientDir));
app.get("*", (_req, res) => res.sendFile(path.join(clientDir, "index.html")));

ensureSchema().then(() => {
  app.listen(port, () => console.log(`Hufc app listening on :${port}`));
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
