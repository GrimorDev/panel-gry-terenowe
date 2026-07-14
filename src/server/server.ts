import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response, type NextFunction } from "express";
import pg from "pg";
import { Redis } from "ioredis";

const { Pool } = pg;

const port = Number(process.env.PORT || 80);
const sessionSecret = process.env.SESSION_SECRET || "change-this-secret-in-portainer";
const adminEmail = process.env.ADMIN_EMAIL || "grimordev@gmail.com";
const adminPassword = process.env.ADMIN_PASSWORD || "PrywatnieNr7!";

const pool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || "field_games",
  user: process.env.DB_USER || "field_games",
  password: process.env.DB_PASS || "field_games_password"
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection (request failed, server keeps running):", reason);
});
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception (request failed, server keeps running):", error);
});

const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 })
  : null;

redis?.on("error", (error: Error) => {
  console.warn("Redis cache disabled temporarily:", error.message);
});

async function cacheGet<T>(key: string): Promise<T | null> {
  if (!redis) return null;
  try {
    const value = await redis.get(key);
    return value ? JSON.parse(value) as T : null;
  } catch {
    return null;
  }
}

async function cacheSet(key: string, value: unknown, ttlSeconds: number) {
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    // Cache is optional. Database remains the source of truth.
  }
}

async function cacheDelPrefix(prefix: string) {
  if (!redis) return;
  try {
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", "100");
      cursor = nextCursor;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== "0");
  } catch {
    // Cache invalidation failure should not block writes.
  }
}

function pulseCacheKey(gameId?: number, user?: User) {
  return `hufc:pulse:${Number(user?.id || 0)}:${gameId || "auto"}`;
}

async function invalidateMessageCache() {
  await cacheDelPrefix("hufc:pulse:");
}

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

async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = String(req.headers.authorization || "");
  const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  const token = bearer || readCookies(req).hufc_session;
  if (!token) return res.status(401).json({ ok: false, error: "Brak logowania" });
  const [payload, signature] = token.split(".");
  if (!payload || signature !== sign(payload)) return res.status(401).json({ ok: false, error: "Sesja wygasła" });
  let tokenUser: User;
  try {
    tokenUser = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return res.status(401).json({ ok: false, error: "Sesja wygasła" });
  }
  // Tokens are self-signed and stateless, so a deleted or edited account would otherwise
  // stay "valid" forever. Re-check against the database on every request so a removed
  // account's cached token stops being usable immediately, instead of e.g. still being
  // able to reference itself as owner_user_id on new rows and violating foreign keys.
  try {
    const result = await pool.query("SELECT id, email, name, role FROM users WHERE id=$1", [tokenUser.id]);
    const current = result.rows[0];
    if (!current) return res.status(401).json({ ok: false, error: "Konto zostało usunięte" });
    req.user = { id: current.id, email: current.email, name: current.name, role: current.role };
    return next();
  } catch {
    return res.status(500).json({ ok: false, error: "Błąd serwera" });
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
      caretaker_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
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
      owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      scope VARCHAR(20) NOT NULL DEFAULT 'grupa',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS session_participants (
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (session_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS session_photos (
      id SERIAL PRIMARY KEY,
      session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
      title VARCHAR(160) NOT NULL,
      color VARCHAR(30) NOT NULL DEFAULT 'green',
      image_data TEXT,
      mime_type VARCHAR(80),
      share_token VARCHAR(80) UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS photo_albums (
      id SERIAL PRIMARY KEY,
      name VARCHAR(160) NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS photo_album_items (
      album_id INTEGER NOT NULL REFERENCES photo_albums(id) ON DELETE CASCADE,
      photo_id INTEGER NOT NULL REFERENCES session_photos(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (album_id, photo_id)
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
      owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
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

    CREATE TABLE IF NOT EXISTS internal_shares (
      id SERIAL PRIMARY KEY,
      photo_id INTEGER NOT NULL REFERENCES session_photos(id) ON DELETE CASCADE,
      target_type VARCHAR(30) NOT NULL DEFAULT 'hufiec',
      target_id INTEGER,
      note TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      target_type VARCHAR(30) NOT NULL DEFAULT 'hufiec',
      target_id INTEGER,
      body TEXT NOT NULL,
      photo_id INTEGER REFERENCES session_photos(id) ON DELETE SET NULL,
      reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      attachment_name VARCHAR(240),
      attachment_mime VARCHAR(120),
      attachment_data TEXT,
      edited_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS message_reads (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_type VARCHAR(30) NOT NULL,
      target_id INTEGER NOT NULL DEFAULT 0,
      last_read_message_id INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, target_type, target_id)
    );

    CREATE TABLE IF NOT EXISTS competition_tents (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      color VARCHAR(20) NOT NULL DEFAULT '#1e5c46',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS competition_tent_members (
      tent_id INTEGER NOT NULL REFERENCES competition_tents(id) ON DELETE CASCADE,
      ward_id INTEGER NOT NULL REFERENCES wards(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tent_id, ward_id)
    );

    CREATE TABLE IF NOT EXISTS competition_points (
      id SERIAL PRIMARY KEY,
      tent_id INTEGER NOT NULL REFERENCES competition_tents(id) ON DELETE CASCADE,
      category VARCHAR(60) NOT NULL,
      points INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query("ALTER TABLE session_photos ADD COLUMN IF NOT EXISTS image_data TEXT");
  await pool.query("ALTER TABLE session_photos ADD COLUMN IF NOT EXISTS mime_type VARCHAR(80)");
  await pool.query("ALTER TABLE session_photos ADD COLUMN IF NOT EXISTS share_token VARCHAR(80) UNIQUE");
  await pool.query("ALTER TABLE session_photos ADD COLUMN IF NOT EXISTS owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ");
  await pool.query("UPDATE users SET created_at = NOW() WHERE created_at IS NULL");
  await pool.query("ALTER TABLE users ALTER COLUMN created_at SET DEFAULT NOW()");
  await pool.query("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL");
  await pool.query("ALTER TABLE games ADD COLUMN IF NOT EXISTS owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL");
  await pool.query("ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS caretaker_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL");
  await pool.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(240)");
  await pool.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_mime VARCHAR(120)");
  await pool.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_data TEXT");
  await pool.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL");
  await pool.query("ALTER TABLE competition_points ADD COLUMN IF NOT EXISTS previous_points INTEGER");
  await pool.query("ALTER TABLE competition_points ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE session_photos ALTER COLUMN session_id DROP NOT NULL");
  await pool.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ");
  await pool.query(`
    DELETE FROM competition_tent_members m
    USING (
      SELECT ctid, ROW_NUMBER() OVER (PARTITION BY ward_id ORDER BY created_at DESC, tent_id DESC) AS rn
      FROM competition_tent_members
    ) duplicates
    WHERE m.ctid = duplicates.ctid AND duplicates.rn > 1
  `);
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS competition_tent_members_one_tent_per_ward ON competition_tent_members (ward_id)");
  await pool.query("UPDATE cohorts SET caretaker='Bez opiekuna' WHERE caretaker_user_id IS NULL AND caretaker <> 'Bez opiekuna'");

  await pool.query(
    `INSERT INTO users (email, name, role, password_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET role=$3`,
    [adminEmail, "Administrator hufca", "administrator", hashPassword(adminPassword)]
  );
  await pool.query("UPDATE games SET owner_user_id = (SELECT id FROM users WHERE lower(email)=lower($1) LIMIT 1) WHERE owner_user_id IS NULL", [adminEmail]);
  await pool.query("UPDATE sessions SET owner_user_id = (SELECT id FROM users WHERE lower(email)=lower($1) LIMIT 1) WHERE owner_user_id IS NULL", [adminEmail]);
}

function remaining(game: any) {
  let seconds = Number(game.timer_remaining_seconds || 0);
  if (game.timer_running) {
    const updated = new Date(game.timer_updated_at).getTime();
    seconds = Math.max(0, seconds - Math.floor((Date.now() - updated) / 1000));
  }
  return seconds;
}

function isAdmin(user?: User) {
  return user?.role === "administrator";
}

async function assertGameAccess(user: User | undefined, gameId: number, mode: "view" | "manage" = "view") {
  if (!gameId) throw new Error("Nie wybrano gry");
  const result = await pool.query("SELECT id, owner_user_id FROM games WHERE id=$1", [gameId]);
  const game = result.rows[0];
  if (!game) throw new Error("Nie znaleziono gry");
  if (isAdmin(user)) return game;
  if (Number(game.owner_user_id) === Number(user?.id)) return game;
  const message = mode === "manage" ? "Nie możesz edytować gry innego wychowawcy" : "Nie masz dostępu do tej gry";
  const error = new Error(message) as Error & { status?: number };
  error.status = 403;
  throw error;
}

async function assertSessionManage(user: User | undefined, sessionId: number) {
  if (!sessionId) return;
  const result = await pool.query("SELECT owner_user_id FROM sessions WHERE id=$1", [sessionId]);
  const session = result.rows[0];
  if (!session) throw new Error("Nie znaleziono zbiórki");
  if (isAdmin(user) || Number(session.owner_user_id) === Number(user?.id)) return;
  const error = new Error("Tylko twórca albo administrator może edytować tę zbiórkę") as Error & { status?: number };
  error.status = 403;
  throw error;
}

function forbidden(message: string) {
  const error = new Error(message) as Error & { status?: number };
  error.status = 403;
  return error;
}

async function assertCohortManage(user: User | undefined, cohortId: number | null) {
  if (isAdmin(user)) return;
  if (!cohortId) throw forbidden("Tylko administrator moze przypisac podopiecznego bez grupy");
  const result = await pool.query("SELECT caretaker_user_id FROM cohorts WHERE id=$1", [cohortId]);
  const cohort = result.rows[0];
  if (cohort && Number(cohort.caretaker_user_id) === Number(user?.id)) return;
  throw forbidden("Mozesz zarzadzac tylko podopiecznymi swojej grupy");
}

async function assertWardManage(user: User | undefined, wardId: number) {
  if (isAdmin(user)) return;
  const result = await pool.query(`
    SELECT w.id, c.caretaker_user_id
    FROM wards w
    LEFT JOIN cohorts c ON c.id = w.cohort_id
    WHERE w.id=$1
  `, [wardId]);
  const ward = result.rows[0];
  if (!ward) throw new Error("Nie znaleziono podopiecznego");
  if (Number(ward.caretaker_user_id) === Number(user?.id)) return;
  throw forbidden("Mozesz edytowac tylko podopiecznych swojej grupy");
}

async function gamesList(user?: User) {
  const { rows } = await pool.query(`
    SELECT g.*, u.name AS owner_name,
      COALESCE((SELECT COUNT(*) FROM teams t WHERE t.game_id = g.id), 0)::int AS team_count,
      COALESCE((SELECT COUNT(*) FROM stations s WHERE s.game_id = g.id), 0)::int AS station_count
    FROM games g
    LEFT JOIN users u ON u.id = g.owner_user_id
    WHERE ($1::boolean OR g.owner_user_id = $2)
    ORDER BY g.game_date DESC, g.id DESC
  `, [isAdmin(user), user?.id || 0]);
  return rows.map((game) => ({ ...game, remaining_seconds: remaining(game) }));
}

async function availableGamesFor(user?: User) {
  let list = await gamesList(user);
  if (!list.length && user?.id) {
    await pool.query(
      `INSERT INTO games (name, template, game_date, start_time, duration_minutes, timer_remaining_seconds, owner_user_id)
       VALUES ($1,$2,CURRENT_DATE,$3,$4,$5,$6)`,
      ["Moja gra terenowa", "Własna", "12:00", 90, 90 * 60, user.id]
    );
    list = await gamesList(user);
  }
  return list;
}

async function state(gameId?: number, user?: User) {
  const availableGames = await availableGamesFor(user);
  const selectedId = gameId || Number(availableGames[0]?.id);
  if (!selectedId) throw new Error("Nie masz jeszcze dostępnej gry");
  await assertGameAccess(user, selectedId, "view");
  const gameResult = await pool.query("SELECT g.*, u.name AS owner_name FROM games g LEFT JOIN users u ON u.id = g.owner_user_id WHERE g.id = $1", [selectedId]);
  const game = gameResult.rows[0];
  if (!game) throw new Error("Nie znaleziono gry");
  game.remaining_seconds = remaining(game);

  const [teams, stations, scores, materials, questions, games, cohorts, wards, sessions, photos, photoAlbums, photoAlbumItems, shares, messages, messageUnreads, caregivers, competitionTents, competitionMembers, competitionPoints] = await Promise.all([
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
    Promise.resolve(availableGames),
    pool.query(`
      SELECT c.*, u.name AS caretaker_user_name, u.email AS caretaker_email,
        COALESCE((SELECT COUNT(*) FROM wards w WHERE w.cohort_id = c.id), 0)::int AS ward_count
      FROM cohorts c
      LEFT JOIN users u ON u.id = c.caretaker_user_id
      ORDER BY c.name
    `),
    pool.query(`
      SELECT w.*, c.name AS cohort_name
      FROM wards w
      LEFT JOIN cohorts c ON c.id = w.cohort_id
      ORDER BY w.name
    `),
    pool.query(`
      SELECT s.*, c.name AS cohort_name, u.name AS owner_name,
        COALESCE((SELECT json_agg(sp.user_id ORDER BY sp.user_id) FROM session_participants sp WHERE sp.session_id=s.id), '[]'::json) AS participant_user_ids,
        COALESCE((SELECT string_agg(u2.name, ', ' ORDER BY u2.name) FROM session_participants sp JOIN users u2 ON u2.id=sp.user_id WHERE sp.session_id=s.id), '') AS participant_names
      FROM sessions s
      LEFT JOIN cohorts c ON c.id = s.cohort_id
      LEFT JOIN users u ON u.id = s.owner_user_id
      WHERE ($1::boolean OR s.scope='grupa' OR s.owner_user_id=$2 OR EXISTS (SELECT 1 FROM session_participants sp WHERE sp.session_id=s.id AND sp.user_id=$2))
      ORDER BY s.session_date ASC, s.id ASC
    `, [isAdmin(user), user?.id || 0]),
    pool.query(`
      SELECT p.*, s.title AS session_title, s.session_date, s.location AS session_location
      FROM session_photos p
      LEFT JOIN sessions s ON s.id = p.session_id
      WHERE $1::boolean
        OR p.owner_user_id = $2
        OR EXISTS (
          SELECT 1 FROM internal_shares ish
          WHERE ish.photo_id = p.id
            AND (
              ish.target_type IN ('hufiec', 'staff', 'parents')
              OR (ish.target_type = 'user' AND ish.target_id = $2)
              OR (ish.target_type = 'cohort' AND ($3 = 'administrator' OR EXISTS (SELECT 1 FROM cohorts gc WHERE gc.id = ish.target_id AND gc.caretaker_user_id = $2)))
            )
        )
      ORDER BY COALESCE(p.created_at, s.session_date::timestamptz) DESC, p.id DESC
    `, [isAdmin(user), user?.id || 0, user?.role || 'wychowawca']),
    pool.query(`
      SELECT a.*, COALESCE(COUNT(i.photo_id), 0)::int AS photo_count
      FROM photo_albums a
      LEFT JOIN photo_album_items i ON i.album_id = a.id
      GROUP BY a.id
      ORDER BY a.created_at DESC, a.id DESC
    `),
    pool.query(`
      SELECT *
      FROM photo_album_items
      ORDER BY created_at DESC
    `),
    pool.query(`
      SELECT sh.*, p.title AS photo_title, c.name AS cohort_name, u.name AS created_by_name
      FROM internal_shares sh
      JOIN session_photos p ON p.id = sh.photo_id
      LEFT JOIN cohorts c ON c.id = sh.target_id AND sh.target_type='cohort'
      LEFT JOIN users u ON u.id = sh.created_by
      ORDER BY sh.created_at DESC
    `),
    pool.query(`
      SELECT m.*, u.name AS sender_name,
        p.title AS photo_title,
        p.image_data AS photo_image_data,
        p.mime_type AS photo_mime_type,
        p.share_token AS photo_share_token,
        c.name AS cohort_name,
        rm.body AS reply_body,
        ru.name AS reply_sender_name,
        rp.title AS reply_photo_title,
        rm.attachment_name AS reply_attachment_name
      FROM messages m
      LEFT JOIN users u ON u.id = m.sender_id
      LEFT JOIN session_photos p ON p.id = m.photo_id
      LEFT JOIN cohorts c ON c.id = m.target_id AND m.target_type='cohort'
      LEFT JOIN messages rm ON rm.id = m.reply_to_id
      LEFT JOIN users ru ON ru.id = rm.sender_id
      LEFT JOIN session_photos rp ON rp.id = rm.photo_id
      WHERE m.target_type IN ('hufiec', 'staff', 'parents')
        OR (m.target_type='user' AND (m.sender_id=$1 OR m.target_id=$1))
        OR (m.target_type='cohort' AND ($2='administrator' OR EXISTS (SELECT 1 FROM cohorts gc WHERE gc.id=m.target_id AND gc.caretaker_user_id=$1)))
      ORDER BY m.created_at DESC
      LIMIT 80
    `, [user?.id || 0, user?.role || 'wychowawca']),
    user?.id ? pool.query(`
      SELECT m.target_type,
        CASE
          WHEN m.target_type='user' AND m.target_id=$1 THEN COALESCE(m.sender_id, 0)
          ELSE COALESCE(m.target_id, 0)
        END::int AS target_id,
        COUNT(*)::int AS unread_count
      FROM messages m
      JOIN users account_user ON account_user.id = $1
      LEFT JOIN message_reads r
        ON r.user_id = $1
       AND r.target_type = m.target_type
       AND r.target_id = CASE
         WHEN m.target_type='user' AND m.target_id=$1 THEN COALESCE(m.sender_id, 0)
         ELSE COALESCE(m.target_id, 0)
       END
      WHERE COALESCE(m.sender_id, 0) <> $1
        AND m.created_at >= account_user.created_at
        AND (
          m.target_type IN ('hufiec', 'staff', 'parents')
          OR (m.target_type='user' AND m.target_id = $1)
          OR (m.target_type='cohort' AND (
            $2 = 'administrator'
            OR EXISTS (SELECT 1 FROM cohorts c WHERE c.id = m.target_id AND c.caretaker_user_id = $1)
          ))
        )
        AND m.id > COALESCE(r.last_read_message_id, 0)
      GROUP BY m.target_type, CASE
        WHEN m.target_type='user' AND m.target_id=$1 THEN COALESCE(m.sender_id, 0)
        ELSE COALESCE(m.target_id, 0)
      END
    `, [user.id, user.role]) : Promise.resolve({ rows: [] }),
    pool.query(`
      SELECT u.id, u.email, u.name, u.role, u.created_at,
        COALESCE((SELECT COUNT(*) FROM cohorts c WHERE c.caretaker_user_id = u.id), 0)::int AS group_count
      FROM users u
      ORDER BY CASE WHEN u.role='administrator' THEN 0 ELSE 1 END, u.name
    `),
    pool.query(`
      SELECT t.*,
        COALESCE(SUM(p.points), 0)::int AS total_points,
        COALESCE((SELECT COUNT(*) FROM competition_tent_members m WHERE m.tent_id = t.id), 0)::int AS member_count
      FROM competition_tents t
      LEFT JOIN competition_points p ON p.tent_id = t.id
      GROUP BY t.id
      ORDER BY total_points DESC, t.name ASC
    `),
    pool.query(`
      SELECT m.*, w.name AS ward_name, w.age, c.name AS cohort_name, t.name AS tent_name
      FROM competition_tent_members m
      JOIN wards w ON w.id = m.ward_id
      JOIN competition_tents t ON t.id = m.tent_id
      LEFT JOIN cohorts c ON c.id = w.cohort_id
      ORDER BY w.name
    `),
    pool.query(`
      SELECT p.*, t.name AS tent_name, u.name AS created_by_name
      FROM competition_points p
      JOIN competition_tents t ON t.id = p.tent_id
      LEFT JOIN users u ON u.id = p.created_by
      ORDER BY COALESCE(p.edited_at, p.created_at) DESC, p.id DESC
      LIMIT 120
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
    photos: photos.rows,
    photo_albums: photoAlbums.rows,
    photo_album_items: photoAlbumItems.rows,
    shares: shares.rows,
    messages: messages.rows,
    message_unreads: messageUnreads.rows,
    caregivers: caregivers.rows,
    competition_tents: competitionTents.rows,
    competition_members: competitionMembers.rows,
    competition_points: competitionPoints.rows
  };
}

function wantsMobileState(req: Request) {
  return req.query.mobile === "1" || req.header("X-Hufc-Mobile") === "1";
}

function stripHeavyMedia(row: Record<string, unknown>) {
  const next = { ...row };
  for (const key of Object.keys(next)) {
    if (key.includes("image_data") || key.includes("attachment_data")) {
      next[key] = null;
    }
  }
  return next;
}

function mobileStatePayload(payload: Awaited<ReturnType<typeof state>>) {
  return {
    ...payload,
    photos: payload.photos.slice(0, 80).map(stripHeavyMedia),
    messages: payload.messages.slice(0, 80).map(stripHeavyMedia),
    shares: payload.shares.slice(0, 80).map(stripHeavyMedia),
    materials: payload.materials.slice(0, 80),
    questions: payload.questions.slice(0, 80),
    competition_points: payload.competition_points.slice(0, 80)
  };
}

async function stateFor(req: Request, gameId?: number) {
  const payload = await state(gameId, req.user);
  return wantsMobileState(req) ? mobileStatePayload(payload) : payload;
}

async function gameState(gameId?: number, user?: User) {
  const availableGames = await availableGamesFor(user);
  const selectedId = gameId || Number(availableGames[0]?.id);
  if (!selectedId) throw new Error("Nie masz jeszcze dostępnej gry");
  await assertGameAccess(user, selectedId, "view");
  const gameResult = await pool.query("SELECT g.*, u.name AS owner_name FROM games g LEFT JOIN users u ON u.id = g.owner_user_id WHERE g.id = $1", [selectedId]);
  const game = gameResult.rows[0];
  if (!game) throw new Error("Nie znaleziono gry");
  game.remaining_seconds = remaining(game);

  const [teams, stations, scores, materials, questions, games] = await Promise.all([
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
    Promise.resolve(availableGames)
  ]);

  return {
    ok: true,
    game,
    games,
    teams: teams.rows,
    stations: stations.rows,
    scores: scores.rows,
    materials: materials.rows,
    questions: questions.rows
  };
}

async function pulseState(gameId?: number, user?: User) {
  const cacheKey = pulseCacheKey(gameId, user);
  const cached = await cacheGet<Record<string, unknown>>(cacheKey);
  if (cached) return cached;

  const userId = Number(user?.id || 0) || undefined;
  const [game, messages, messageUnreads] = await Promise.all([
    gameState(gameId, user),
    pool.query(`
      SELECT m.*, u.name AS sender_name,
        p.title AS photo_title,
        NULL::text AS photo_image_data,
        p.mime_type AS photo_mime_type,
        p.share_token AS photo_share_token,
        c.name AS cohort_name,
        rm.body AS reply_body,
        ru.name AS reply_sender_name,
        rp.title AS reply_photo_title,
        rm.attachment_name AS reply_attachment_name,
        NULL::text AS attachment_data
      FROM messages m
      LEFT JOIN users u ON u.id = m.sender_id
      LEFT JOIN session_photos p ON p.id = m.photo_id
      LEFT JOIN cohorts c ON c.id = m.target_id AND m.target_type='cohort'
      LEFT JOIN messages rm ON rm.id = m.reply_to_id
      LEFT JOIN users ru ON ru.id = rm.sender_id
      LEFT JOIN session_photos rp ON rp.id = rm.photo_id
      WHERE m.target_type IN ('hufiec', 'staff', 'parents')
        OR (m.target_type='user' AND (m.sender_id=$1 OR m.target_id=$1))
        OR (m.target_type='cohort' AND ($2='administrator' OR EXISTS (SELECT 1 FROM cohorts gc WHERE gc.id=m.target_id AND gc.caretaker_user_id=$1)))
      ORDER BY m.created_at DESC
      LIMIT 80
    `, [userId || 0, user?.role || 'wychowawca']),
    userId ? pool.query(`
      SELECT m.target_type,
        CASE
          WHEN m.target_type='user' AND m.target_id=$1 THEN COALESCE(m.sender_id, 0)
          ELSE COALESCE(m.target_id, 0)
        END::int AS target_id,
        COUNT(*)::int AS unread_count
      FROM messages m
      JOIN users account_user ON account_user.id = $1
      LEFT JOIN message_reads r
        ON r.user_id = $1
       AND r.target_type = m.target_type
       AND r.target_id = CASE
         WHEN m.target_type='user' AND m.target_id=$1 THEN COALESCE(m.sender_id, 0)
         ELSE COALESCE(m.target_id, 0)
       END
      WHERE COALESCE(m.sender_id, 0) <> $1
        AND m.created_at >= account_user.created_at
        AND (
          m.target_type IN ('hufiec', 'staff', 'parents')
          OR (m.target_type='user' AND m.target_id = $1)
          OR (m.target_type='cohort' AND (
            $2 = 'administrator'
            OR EXISTS (SELECT 1 FROM cohorts c WHERE c.id = m.target_id AND c.caretaker_user_id = $1)
          ))
        )
        AND m.id > COALESCE(r.last_read_message_id, 0)
      GROUP BY m.target_type, CASE
        WHEN m.target_type='user' AND m.target_id=$1 THEN COALESCE(m.sender_id, 0)
        ELSE COALESCE(m.target_id, 0)
      END
    `, [userId, user?.role || "wychowawca"]) : Promise.resolve({ rows: [] })
  ]);

  const next = {
    ...game,
    messages: messages.rows,
    message_unreads: messageUnreads.rows
  };
  await cacheSet(cacheKey, next, 1);
  return next;
}

async function markConversationRead(userId: number, targetType: string, targetId: number) {
  const result = targetType === "user"
    ? await pool.query(
      "SELECT COALESCE(MAX(id), 0)::int AS last_id FROM messages WHERE target_type='user' AND ((target_id=$1 AND sender_id=$2) OR (target_id=$2 AND sender_id=$1))",
      [userId, targetId]
    )
    : await pool.query(
      "SELECT COALESCE(MAX(id), 0)::int AS last_id FROM messages WHERE target_type=$1 AND COALESCE(target_id, 0)=$2",
      [targetType, targetId]
    );
  const lastId = Number(result.rows[0]?.last_id || 0);

  await pool.query(`
    INSERT INTO message_reads (user_id, target_type, target_id, last_read_message_id, updated_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (user_id, target_type, target_id)
    DO UPDATE SET
      last_read_message_id = GREATEST(message_reads.last_read_message_id, EXCLUDED.last_read_message_id),
      updated_at = NOW()
  `, [userId, targetType, targetId, lastId]);
}

async function markAllMessagesRead(userId: number) {
  await pool.query(`
    INSERT INTO message_reads (user_id, target_type, target_id, last_read_message_id, updated_at)
    SELECT $1, target_type, target_id, MAX(id)::int, NOW()
    FROM (
      SELECT id,
        target_type,
        CASE
          WHEN target_type='user' AND target_id=$1 THEN COALESCE(sender_id, 0)
          WHEN target_type='user' AND sender_id=$1 THEN COALESCE(target_id, 0)
          ELSE COALESCE(target_id, 0)
        END::int AS target_id
      FROM messages
      WHERE target_type <> 'user' OR target_id=$1 OR sender_id=$1
    ) visible_messages
    GROUP BY target_type, target_id
    ON CONFLICT (user_id, target_type, target_id)
    DO UPDATE SET
      last_read_message_id = GREATEST(message_reads.last_read_message_id, EXCLUDED.last_read_message_id),
      updated_at = NOW()
  `, [userId]);
}

function templateStations(template: string) {
  const data: Record<string, string[]> = {
    Polska: ["Start", "Wawel", "Mazury", "Tatry", "Gdańsk", "Meta"],
    "Włochy": ["Start", "Koloseum", "Wieża w Pizie", "Pompeje", "Fontanna", "Meta"],
    Olimp: ["Start", "Zeus", "Atena", "Apollo", "Hermes", "Meta"],
    "Własna": []
  };
  return data[template] || [];
}

const app = express();
app.use(express.json({ limit: "25mb" }));

app.post("/api/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const result = await pool.query("SELECT * FROM users WHERE lower(email) = $1", [email]);
  const user = result.rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ ok: false, error: "Nieprawidłowy e-mail albo hasło" });
  }
  const safeUser = { id: user.id, email: user.email, name: user.name, role: user.role };
  const token = sessionCookie(safeUser);
  res.setHeader("Set-Cookie", `hufc_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
  return res.json({ ok: true, user: safeUser, token });
});

app.post("/api/logout", (_req, res) => {
  res.setHeader("Set-Cookie", "hufc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => res.json({ ok: true, user: req.user }));

app.use("/api", requireAuth);

app.post("/api/profile", async (req, res) => {
  const id = Number(req.user?.id);
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!name || !email) return res.status(400).json({ ok: false, error: "Podaj imię i e-mail" });
  const result = await pool.query(
    "UPDATE users SET name=$1, email=$2 WHERE id=$3 RETURNING id, email, name, role",
    [name, email, id]
  );
  const user = result.rows[0];
  res.setHeader("Set-Cookie", `hufc_session=${sessionCookie(user)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
  res.json({ ok: true, user });
});

app.get("/api/state", async (req, res) => {
  try {
    res.json(await stateFor(req, req.query.gameId ? Number(req.query.gameId) : undefined));
  } catch (error) {
    const status = (error as Error & { status?: number })?.status || 500;
    res.status(status).json({ ok: false, error: error instanceof Error ? error.message : "Błąd serwera" });
  }
});

app.get("/api/game-state", async (req, res) => {
  try {
    res.json(await gameState(req.query.gameId ? Number(req.query.gameId) : undefined, req.user));
  } catch (error) {
    const status = (error as Error & { status?: number })?.status || 500;
    res.status(status).json({ ok: false, error: error instanceof Error ? error.message : "Błąd serwera" });
  }
});

app.get("/api/pulse", async (req, res) => {
  try {
    res.json(await pulseState(req.query.gameId ? Number(req.query.gameId) : undefined, req.user));
  } catch (error) {
    const status = (error as Error & { status?: number })?.status || 500;
    res.status(status).json({ ok: false, error: error instanceof Error ? error.message : "Błąd serwera" });
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
    await assertGameAccess(req.user, id, "manage");
    await pool.query(
      `UPDATE games SET name=$1, template=$2, game_date=$3, start_time=$4, duration_minutes=$5,
       timer_remaining_seconds = CASE WHEN timer_running THEN timer_remaining_seconds ELSE $6 END WHERE id=$7`,
      [name, template, gameDate, startTime, duration, duration * 60, id]
    );
    return res.json(await stateFor(req, id));
  }

  const result = await pool.query(
    "INSERT INTO games (name, template, game_date, start_time, duration_minutes, timer_remaining_seconds, owner_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
    [name, template, gameDate, startTime, duration, duration * 60, req.user?.id || null]
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
  return res.json(await stateFor(req, gameId));
});

app.delete("/api/games/:id", async (req, res) => {
  await assertGameAccess(req.user, Number(req.params.id), "manage");
  await pool.query("DELETE FROM games WHERE id = $1", [Number(req.params.id)]);
  res.json(await stateFor(req));
});

app.post("/api/teams", async (req, res) => {
  await assertGameAccess(req.user, Number(req.body.game_id), "manage");
  const id = Number(req.body.id || 0);
  const name = String(req.body.name || "").trim();
  const color = String(req.body.color || "#1e5c46");
  if (!name) return res.status(400).json({ ok: false, error: "Podaj nazwę drużyny" });
  if (id) {
    await pool.query("UPDATE teams SET name=$1, color=$2 WHERE id=$3 AND game_id=$4", [name, color, id, Number(req.body.game_id)]);
  } else {
    await pool.query("INSERT INTO teams (game_id, name, color) VALUES ($1,$2,$3)", [Number(req.body.game_id), name, color]);
  }
  res.json(await stateFor(req, Number(req.body.game_id)));
});

app.delete("/api/teams/:id", async (req, res) => {
  const lookup = await pool.query("SELECT game_id FROM teams WHERE id=$1", [Number(req.params.id)]);
  await assertGameAccess(req.user, Number(lookup.rows[0]?.game_id || req.query.gameId), "manage");
  const result = await pool.query("DELETE FROM teams WHERE id = $1 RETURNING game_id", [Number(req.params.id)]);
  res.json(await stateFor(req, Number(result.rows[0]?.game_id || req.query.gameId)));
});

app.post("/api/wards", async (req, res) => {
  try {
    const id = Number(req.body.id || 0);
    const cohortId = Number(req.body.cohort_id || 0) || null;
    const values = [String(req.body.name || ""), Number(req.body.age || 12), String(req.body.parent_name || ""), String(req.body.contact || ""), cohortId];
    if (!values[0]) return res.status(400).json({ ok: false, error: "Podaj imię i nazwisko" });
    if (id) {
      await assertWardManage(req.user, id);
      await assertCohortManage(req.user, cohortId);
      await pool.query("UPDATE wards SET name=$1, age=$2, parent_name=$3, contact=$4, cohort_id=$5 WHERE id=$6", [...values, id]);
    } else {
      await assertCohortManage(req.user, cohortId);
      await pool.query("INSERT INTO wards (name, age, parent_name, contact, cohort_id) VALUES ($1,$2,$3,$4,$5)", values);
    }
    res.json(await stateFor(req, Number(req.body.game_id || 0) || undefined));
  } catch (error) {
    const status = (error as Error & { status?: number })?.status || 500;
    res.status(status).json({ ok: false, error: error instanceof Error ? error.message : "Błąd serwera" });
  }
});

app.delete("/api/wards/:id", async (req, res) => {
  try {
    await assertWardManage(req.user, Number(req.params.id));
    await pool.query("DELETE FROM wards WHERE id=$1", [Number(req.params.id)]);
    res.json(await stateFor(req, req.query.gameId ? Number(req.query.gameId) : undefined));
  } catch (error) {
    const status = (error as Error & { status?: number })?.status || 500;
    res.status(status).json({ ok: false, error: error instanceof Error ? error.message : "Błąd serwera" });
  }
});

app.post("/api/caregivers", async (req, res) => {
  if (req.user?.role !== "administrator") return res.status(403).json({ ok: false, error: "Tylko administrator może zarządzać kontami" });
  const id = Number(req.body.id || 0);
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const role = String(req.body.role || "wychowawca");
  const password = String(req.body.password || "");
  const cohortId = Number(req.body.cohort_id || 0) || null;
  if (!name || !email) return res.status(400).json({ ok: false, error: "Podaj imię, nazwisko i e-mail" });

  let userId = id;
  if (id) {
    if (password) {
      await pool.query("UPDATE users SET name=$1, email=$2, role=$3, password_hash=$4 WHERE id=$5", [name, email, role, hashPassword(password), id]);
    } else {
      await pool.query("UPDATE users SET name=$1, email=$2, role=$3 WHERE id=$4", [name, email, role, id]);
    }
  } else {
    const result = await pool.query(
      "INSERT INTO users (email, name, role, password_hash) VALUES ($1,$2,$3,$4) RETURNING id",
      [email, name, role, hashPassword(password || crypto.randomBytes(8).toString("hex"))]
    );
    userId = Number(result.rows[0].id);
  }

  if (cohortId) {
    await pool.query("UPDATE cohorts SET caretaker_user_id=$1, caretaker=$2 WHERE id=$3", [userId, name, cohortId]);
  }
  res.json(await stateFor(req, Number(req.body.game_id || 0) || undefined));
});

app.post("/api/cohorts", async (req, res) => {
  if (req.user?.role !== "administrator") return res.status(403).json({ ok: false, error: "Tylko administrator może zarządzać grupami" });
  const id = Number(req.body.id || 0);
  const name = String(req.body.name || "").trim();
  const caretakerUserId = Number(req.body.caretaker_user_id || 0) || null;
  const caretaker = caretakerUserId
    ? String((await pool.query("SELECT name FROM users WHERE id=$1", [caretakerUserId])).rows[0]?.name || "")
    : String(req.body.caretaker || "").trim();
  if (!name) return res.status(400).json({ ok: false, error: "Podaj nazwę grupy" });
  if (id) {
    await pool.query("UPDATE cohorts SET name=$1, caretaker=$2, caretaker_user_id=$3 WHERE id=$4", [name, caretaker || "Bez opiekuna", caretakerUserId, id]);
  } else {
    await pool.query("INSERT INTO cohorts (name, caretaker, caretaker_user_id) VALUES ($1,$2,$3)", [name, caretaker || "Bez opiekuna", caretakerUserId]);
  }
  res.json(await stateFor(req, Number(req.body.game_id || 0) || undefined));
});

app.delete("/api/cohorts/:id", async (req, res) => {
  if (req.user?.role !== "administrator") return res.status(403).json({ ok: false, error: "Tylko administrator może usuwać grupy" });
  await pool.query("DELETE FROM cohorts WHERE id=$1", [Number(req.params.id)]);
  res.json(await stateFor(req, req.query.gameId ? Number(req.query.gameId) : undefined));
});

app.post("/api/competition/tents", async (req, res) => {
  const id = Number(req.body.id || 0);
  const name = String(req.body.name || "").trim();
  const color = String(req.body.color || "#1e5c46").trim();
  if (!name) return res.status(400).json({ ok: false, error: "Podaj nazwę namiotu" });
  if (id) {
    await pool.query("UPDATE competition_tents SET name=$1, color=$2 WHERE id=$3", [name, color, id]);
  } else {
    await pool.query("INSERT INTO competition_tents (name, color) VALUES ($1,$2)", [name, color]);
  }
  res.json(await stateFor(req, Number(req.body.game_id || 0) || undefined));
});

app.delete("/api/competition/tents/:id", async (req, res) => {
  await pool.query("DELETE FROM competition_tents WHERE id=$1", [Number(req.params.id)]);
  res.json(await stateFor(req, req.query.gameId ? Number(req.query.gameId) : undefined));
});

app.post("/api/competition/tents/:id/members", async (req, res) => {
  const tentId = Number(req.params.id);
  const wardIds = Array.isArray(req.body.ward_ids) ? req.body.ward_ids.map(Number).filter(Boolean) : [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM competition_tent_members WHERE tent_id=$1", [tentId]);
    if (wardIds.length) {
      await client.query("DELETE FROM competition_tent_members WHERE ward_id = ANY($1::int[])", [wardIds]);
    }
    for (const wardId of wardIds) {
      await client.query(
        "INSERT INTO competition_tent_members (tent_id, ward_id) VALUES ($1,$2) ON CONFLICT (ward_id) DO UPDATE SET tent_id=EXCLUDED.tent_id, created_at=NOW()",
        [tentId, wardId]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  res.json(await stateFor(req, Number(req.body.game_id || 0) || undefined));
});

app.post("/api/competition/points", async (req, res) => {
  const id = Number(req.body.id || 0);
  const tentId = Number(req.body.tent_id);
  const category = String(req.body.category || "").trim();
  const points = Number(req.body.points || 0);
  const reason = String(req.body.reason || "").trim();
  if (!tentId) return res.status(400).json({ ok: false, error: "Wybierz namiot" });
  if (!category) return res.status(400).json({ ok: false, error: "Wybierz kategorię punktów" });
  if (!reason) return res.status(400).json({ ok: false, error: "Podaj powód przyznania punktów" });
  if (id) {
    if (req.user?.role !== "administrator") {
      return res.status(403).json({ ok: false, error: "Tylko administrator może edytować wpisy historii punktów" });
    }
    const existing = await pool.query("SELECT points FROM competition_points WHERE id=$1", [id]);
    if (!existing.rows[0]) return res.status(404).json({ ok: false, error: "Nie znaleziono wpisu" });
    await pool.query(
      "UPDATE competition_points SET tent_id=$1, category=$2, points=$3, reason=$4, previous_points=$5, edited_at=NOW() WHERE id=$6",
      [tentId, category, points, reason, Number(existing.rows[0].points), id]
    );
  } else {
    await pool.query(
      "INSERT INTO competition_points (tent_id, category, points, reason, created_by) VALUES ($1,$2,$3,$4,$5)",
      [tentId, category, points, reason, req.user?.id || null]
    );
  }
  res.json(await stateFor(req, Number(req.body.game_id || 0) || undefined));
});

app.delete("/api/competition/points/:id", async (req, res) => {
  if (req.user?.role !== "administrator") {
    return res.status(403).json({ ok: false, error: "Tylko administrator może usuwać wpisy historii punktów" });
  }
  await pool.query("DELETE FROM competition_points WHERE id=$1", [Number(req.params.id)]);
  res.json(await stateFor(req, req.query.gameId ? Number(req.query.gameId) : undefined));
});
app.post("/api/sessions", async (req, res) => {
  const id = Number(req.body.id || 0);
  const participantIds = Array.isArray(req.body.participant_user_ids)
    ? req.body.participant_user_ids.map(Number).filter(Boolean)
    : [req.body.participant_user_ids].map(Number).filter(Boolean);
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
  let sessionId = id;
  if (id) {
    await assertSessionManage(req.user, id);
    await pool.query("UPDATE sessions SET title=$1, session_date=$2, location=$3, attendance=$4, total=$5, cohort_id=$6, scope=$7 WHERE id=$8", [...values, id]);
  } else {
    const result = await pool.query("INSERT INTO sessions (title, session_date, location, attendance, total, cohort_id, scope, owner_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id", [...values, req.user?.id || null]);
    sessionId = Number(result.rows[0].id);
  }
  if (sessionId) {
    await pool.query("DELETE FROM session_participants WHERE session_id=$1", [sessionId]);
    for (const userId of participantIds) {
      if (userId !== Number(req.user?.id || 0)) {
        await pool.query("INSERT INTO session_participants (session_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [sessionId, userId]);
      }
    }
  }
  res.json(await stateFor(req, Number(req.body.game_id || 0) || undefined));
});

app.delete("/api/sessions/:id", async (req, res) => {
  await assertSessionManage(req.user, Number(req.params.id));
  await pool.query("DELETE FROM sessions WHERE id=$1", [Number(req.params.id)]);
  res.json(await stateFor(req, req.query.gameId ? Number(req.query.gameId) : undefined));
});

app.post("/api/photos", async (req, res) => {
  const id = Number(req.body.id || 0);
  const title = String(req.body.title || "Zdjęcie").trim();
  const sessionId = Number(req.body.session_id || 0) || null;
  const imageData = String(req.body.image_data || "");
  const mimeType = String(req.body.mime_type || "");
  if (id) {
    await pool.query("UPDATE session_photos SET title=$1 WHERE id=$2", [title, id]);
  } else {
    await pool.query(
      "INSERT INTO session_photos (session_id, title, color, image_data, mime_type, share_token, owner_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [sessionId, title, String(req.body.color || "green"), imageData || null, mimeType || null, crypto.randomBytes(18).toString("hex"), req.user?.id || null]
    );
  }
  res.json(await stateFor(req, Number(req.body.game_id || 0) || undefined));
});

app.delete("/api/photos/:id", async (req, res) => {
  await pool.query("DELETE FROM session_photos WHERE id=$1", [Number(req.params.id)]);
  res.json(await stateFor(req, req.query.gameId ? Number(req.query.gameId) : undefined));
});

app.get("/api/mobile/photos/:id/image", async (req, res) => {
  const result = await pool.query("SELECT image_data, mime_type FROM session_photos WHERE id=$1", [Number(req.params.id)]);
  const imageData = String(result.rows[0]?.image_data || "");
  if (!imageData) return res.status(404).json({ ok: false, error: "Zdjęcie nie ma pliku obrazu" });

  const match = imageData.match(/^data:([^;]+);base64,(.*)$/);
  if (!match) return res.status(404).json({ ok: false, error: "Nieprawidłowy format zdjęcia" });

  const mimeType = String(result.rows[0]?.mime_type || match[1] || "image/jpeg");
  res.type(mimeType).send(Buffer.from(match[2], "base64"));
});

app.get("/api/mobile/messages/:id/attachment", async (req, res) => {
  const result = await pool.query("SELECT attachment_data, attachment_mime FROM messages WHERE id=$1", [Number(req.params.id)]);
  const attachmentData = String(result.rows[0]?.attachment_data || "");
  if (!attachmentData) return res.status(404).json({ ok: false, error: "Wiadomość nie ma załącznika" });

  const match = attachmentData.match(/^data:([^;]+);base64,(.*)$/);
  if (!match) return res.status(404).json({ ok: false, error: "Nieprawidłowy format załącznika" });

  const mimeType = String(result.rows[0]?.attachment_mime || match[1] || "application/octet-stream");
  res.type(mimeType).send(Buffer.from(match[2], "base64"));
});

app.post("/api/photos/bulk-delete", async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map((id: unknown) => Number(id)).filter(Boolean) : [];
  if (ids.length) {
    await pool.query("DELETE FROM session_photos WHERE id = ANY($1::int[])", [ids]);
  }
  res.json(await stateFor(req, Number(req.body.game_id || 0) || undefined));
});

app.post("/api/photo-albums", async (req, res) => {
  const photoIds = Array.isArray(req.body.photo_ids) ? req.body.photo_ids.map((id: unknown) => Number(id)).filter(Boolean) : [];
  let albumId = Number(req.body.album_id || 0);
  const name = String(req.body.name || "").trim();
  if (!albumId) {
    if (!name) return res.status(400).json({ ok: false, error: "Podaj nazwę albumu" });
    const created = await pool.query("INSERT INTO photo_albums (name, created_by) VALUES ($1,$2) RETURNING id", [name, req.user?.id || null]);
    albumId = Number(created.rows[0].id);
  }
  for (const photoId of photoIds) {
    await pool.query("INSERT INTO photo_album_items (album_id, photo_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [albumId, photoId]);
  }
  res.json(await stateFor(req, Number(req.body.game_id || 0) || undefined));
});

app.delete("/api/photo-albums/:id", async (req, res) => {
  await pool.query("DELETE FROM photo_albums WHERE id=$1", [Number(req.params.id)]);
  res.json(await stateFor(req, req.query.gameId ? Number(req.query.gameId) : undefined));
});

app.post("/api/internal-shares", async (req, res) => {
  const photoId = Number(req.body.photo_id);
  const targetType = String(req.body.target_type || "hufiec");
  const targetId = Number(req.body.target_id || 0) || null;
  const note = String(req.body.note || "");
  if (!["hufiec", "staff", "parents", "cohort", "user"].includes(targetType)) {
    return res.status(400).json({ ok: false, error: "Nieznany odbiorca udostępnienia" });
  }
  const photo = await pool.query("SELECT owner_user_id FROM session_photos WHERE id=$1", [photoId]);
  if (!photo.rows[0]) return res.status(404).json({ ok: false, error: "Nie znaleziono zdjęcia" });
  const ownerId = Number(photo.rows[0].owner_user_id || 0);
  if (req.user?.role !== "administrator" && ownerId !== Number(req.user?.id || 0)) {
    return res.status(403).json({ ok: false, error: "Udostępnić zdjęcie może tylko jego autor" });
  }
  await pool.query(
    "INSERT INTO internal_shares (photo_id, target_type, target_id, note, created_by) VALUES ($1,$2,$3,$4,$5)",
    [photoId, targetType, targetId, note, req.user?.id || null]
  );
  res.json(await stateFor(req, Number(req.body.game_id || 0) || undefined));
});

app.post("/api/messages", async (req, res) => {
  const body = String(req.body.body || "").trim();
  const attachmentName = String(req.body.attachment_name || "").trim();
  const attachmentMime = String(req.body.attachment_mime || "").trim();
  const attachmentData = String(req.body.attachment_data || "");
  const replyToId = Number(req.body.reply_to_id || 0) || null;
  const targetType = String(req.body.target_type || "hufiec");
  const targetId = Number(req.body.target_id || 0) || null;
  const photoId = Number(req.body.photo_id || 0) || null;
  if (!body && !attachmentData && !photoId) return res.status(400).json({ ok: false, error: "Wpisz wiadomość albo dodaj załącznik" });
  if (!["hufiec", "staff", "parents", "user", "cohort"].includes(targetType)) {
    return res.status(400).json({ ok: false, error: "Nieznany odbiorca wiadomości" });
  }
  if (targetType === "cohort" && req.user?.role !== "administrator") {
    const owns = targetId
      ? await pool.query("SELECT 1 FROM cohorts WHERE id=$1 AND caretaker_user_id=$2", [targetId, req.user?.id || 0])
      : { rowCount: 0 };
    if (!owns.rowCount) return res.status(403).json({ ok: false, error: "Nie jesteś wychowawcą tej grupy" });
  }
  await pool.query(
    "INSERT INTO messages (sender_id, target_type, target_id, body, photo_id, reply_to_id, attachment_name, attachment_mime, attachment_data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [req.user?.id || null, targetType, targetId, body, photoId, replyToId, attachmentName || null, attachmentMime || null, attachmentData || null]
  );
  if (req.user?.id) await markConversationRead(Number(req.user.id), targetType, targetId || 0);
  await invalidateMessageCache();
  res.json(await stateFor(req, Number(req.body.game_id || 0) || undefined));
});

app.post("/api/messages/read-all", async (req, res) => {
  const userId = Number(req.user?.id || 0);
  if (!userId) return res.status(401).json({ ok: false, error: "Brak sesji" });
  await markAllMessagesRead(userId);
  await invalidateMessageCache();
  res.json(await stateFor(req, Number(req.body.game_id || 0) || undefined));
});

app.post("/api/messages/read", async (req, res) => {
  const userId = Number(req.user?.id || 0);
  if (!userId) return res.status(401).json({ ok: false, error: "Brak sesji" });

  const targetType = String(req.body.target_type || "hufiec");
  const targetId = Number(req.body.target_id || 0) || 0;
  await markConversationRead(userId, targetType, targetId);
  await invalidateMessageCache();

  res.json(await stateFor(req, Number(req.body.game_id || 0) || undefined));
});

app.post("/api/messages/:id", async (req, res) => {
  const id = Number(req.params.id);
  const body = String(req.body.body || "").trim();
  if (!id || !body) return res.status(400).json({ ok: false, error: "Wpisz treść wiadomości" });
  const result = await pool.query(
    "UPDATE messages SET body=$1, edited_at=NOW() WHERE id=$2 AND sender_id=$3 RETURNING id",
    [body, id, req.user?.id || 0]
  );
  if (!result.rowCount) return res.status(403).json({ ok: false, error: "Możesz edytować tylko własne wiadomości" });
  await invalidateMessageCache();
  res.json(await stateFor(req, Number(req.body.game_id || 0) || undefined));
});

app.post("/api/stations", async (req, res) => {
  const gameId = Number(req.body.game_id);
  await assertGameAccess(req.user, gameId, "manage");
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
  res.json(await stateFor(req, gameId));
});

app.delete("/api/stations/:id", async (req, res) => {
  const lookup = await pool.query("SELECT game_id FROM stations WHERE id=$1", [Number(req.params.id)]);
  await assertGameAccess(req.user, Number(lookup.rows[0]?.game_id || req.query.gameId), "manage");
  const result = await pool.query("DELETE FROM stations WHERE id = $1 RETURNING game_id", [Number(req.params.id)]);
  res.json(await stateFor(req, Number(result.rows[0]?.game_id || req.query.gameId)));
});

app.post("/api/scores", async (req, res) => {
  const teamId = Number(req.body.team_id);
  const stationId = Number(req.body.station_id);
  const gameId = Number((await pool.query("SELECT game_id FROM teams WHERE id=$1", [teamId])).rows[0]?.game_id || 0);
  await assertGameAccess(req.user, gameId, "manage");
  await pool.query(`
    INSERT INTO team_stations (team_id, station_id, points, correct, cooperation, started_at, finished_at, comment)
    VALUES ($1,$2,$3,$4,$5,NOW(),NOW(),$6)
    ON CONFLICT (team_id, station_id)
    DO UPDATE SET points=$3, correct=$4, cooperation=$5, finished_at=NOW(), comment=$6
  `, [teamId, stationId, Number(req.body.points || 0), Boolean(req.body.correct), Number(req.body.cooperation || 0), String(req.body.comment || "")]);
  res.json(await stateFor(req, gameId));
});

app.post("/api/timer", async (req, res) => {
  const gameId = Number(req.body.game_id);
  await assertGameAccess(req.user, gameId, "manage");
  const game = (await pool.query("SELECT * FROM games WHERE id=$1", [gameId])).rows[0];
  const left = remaining(game);
  if (req.body.command === "start") {
    await pool.query("UPDATE games SET timer_running=TRUE, timer_remaining_seconds=$1, timer_updated_at=NOW(), status='running' WHERE id=$2", [left, gameId]);
  } else if (req.body.command === "pause") {
    await pool.query("UPDATE games SET timer_running=FALSE, timer_remaining_seconds=$1, timer_updated_at=NOW(), status='paused' WHERE id=$2", [left, gameId]);
  } else if (req.body.command === "reset") {
    await pool.query("UPDATE games SET timer_running=FALSE, timer_remaining_seconds=duration_minutes*60, timer_updated_at=NOW(), status='draft' WHERE id=$1", [gameId]);
  }
  res.json(await stateFor(req, gameId));
});

app.post("/api/materials", async (req, res) => {
  const stationId = Number(req.body.station_id);
  const gameId = Number((await pool.query("SELECT game_id FROM stations WHERE id=$1", [stationId])).rows[0].game_id);
  await assertGameAccess(req.user, gameId, "manage");
  await pool.query("INSERT INTO materials (station_id, title, url, notes) VALUES ($1,$2,$3,$4)", [stationId, String(req.body.title), String(req.body.url || ""), String(req.body.notes || "")]);
  res.json(await stateFor(req, gameId));
});

app.post("/api/questions", async (req, res) => {
  const stationId = Number(req.body.station_id);
  const gameId = Number((await pool.query("SELECT game_id FROM stations WHERE id=$1", [stationId])).rows[0].game_id);
  await assertGameAccess(req.user, gameId, "manage");
  await pool.query("INSERT INTO questions (station_id, question, answer, max_points) VALUES ($1,$2,$3,$4)", [stationId, String(req.body.question), String(req.body.answer || ""), Number(req.body.max_points || 10)]);
  res.json(await stateFor(req, gameId));
});

app.get("/api/station-by-qr", async (req, res) => {
  const code = String(req.query.code || "");
  const result = await pool.query("SELECT id, game_id FROM stations WHERE qr_code=$1", [code]);
  if (!result.rows[0]) return res.status(404).json({ ok: false, error: "Nie znaleziono stacji" });
  res.json({ ok: true, station_id: result.rows[0].id, game_id: result.rows[0].game_id });
});

app.get("/share/photo/:token", async (req, res) => {
  const result = await pool.query(`
    SELECT p.title, p.image_data, p.created_at, s.title AS session_title
    FROM session_photos p
    LEFT JOIN sessions s ON s.id = p.session_id
    WHERE p.share_token=$1
  `, [req.params.token]);
  const photo = result.rows[0];
  if (!photo) return res.status(404).send("Nie znaleziono zdjęcia");
  const caption = [photo.session_title, new Date(photo.created_at).toLocaleDateString("pl-PL")].filter(Boolean).join(" · ");
  res.type("html").send(`<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${photo.title}</title><style>body{margin:0;font-family:system-ui,sans-serif;background:#f8f5ef;color:#171717}.wrap{max-width:1100px;margin:0 auto;padding:24px}img{width:100%;border-radius:16px;box-shadow:0 16px 40px #0002}p{color:#666}</style></head><body><main class="wrap"><h1>${photo.title}</h1><p>${caption}</p>${photo.image_data ? `<img src="${photo.image_data}" alt="${photo.title}">` : "<p>Zdjęcie nie ma jeszcze pliku obrazu.</p>"}</main></body></html>`);
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


