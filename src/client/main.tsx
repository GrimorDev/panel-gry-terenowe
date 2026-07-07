import "leaflet/dist/leaflet.css";
import "./styles.css";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import L from "leaflet";
import { QRCodeSVG } from "qrcode.react";

type User = { id: number; email: string; name: string; role: string };
type Caregiver = { id: number; email: string; name: string; role: string; group_count: number; created_at: string };
type Cohort = { id: number; name: string; caretaker: string; caretaker_user_id: number | null; caretaker_user_name: string | null; caretaker_email: string | null; ward_count: number };
type Ward = { id: number; name: string; age: number; parent_name: string; contact: string; cohort_id: number | null; cohort_name: string | null };
type Session = { id: number; title: string; session_date: string; location: string; attendance: number; total: number; cohort_id: number | null; cohort_name: string | null; scope: string };
type Photo = { id: number; session_id: number; session_title: string; session_date: string; title: string; color: string; image_data: string | null; mime_type: string | null; share_token: string | null; created_at: string };
type Game = { id: number; name: string; template: string; game_date: string; start_time: string; duration_minutes: number; remaining_seconds: number; timer_running: boolean; status: string; team_count?: number; station_count?: number };
type Team = { id: number; game_id: number; name: string; color: string; total_points: number; avg_cooperation: number; correct_count: number; finished_count: number };
type Station = { id: number; game_id: number; title: string; station_order: number; lat: string | null; lng: string | null; qr_code: string };
type Score = { team_id: number; station_id: number; points: number; correct: boolean; cooperation: number; comment: string; finished_at: string | null };
type Material = { id: number; station_id: number; station_title: string; title: string; url: string; notes: string };
type Question = { id: number; station_id: number; station_title: string; question: string; answer: string; max_points: number };
type InternalShare = { id: number; photo_id: number; photo_title: string; target_type: string; target_id: number | null; cohort_name: string | null; note: string; created_by_name: string | null; created_at: string };
type Message = { id: number; sender_id: number | null; sender_name: string | null; target_type: string; target_id: number | null; cohort_name: string | null; body: string; photo_id: number | null; photo_title: string | null; photo_image_data: string | null; photo_mime_type: string | null; photo_share_token: string | null; attachment_name: string | null; attachment_mime: string | null; attachment_data: string | null; reply_to_id: number | null; reply_body: string | null; reply_sender_name: string | null; reply_photo_title: string | null; reply_attachment_name: string | null; edited_at: string | null; created_at: string };
type MessageUnread = { target_type: string; target_id: number; unread_count: number };
type AppState = { ok: true; game: Game; games: Game[]; teams: Team[]; stations: Station[]; scores: Score[]; materials: Material[]; questions: Question[]; cohorts: Cohort[]; wards: Ward[]; sessions: Session[]; photos: Photo[]; shares: InternalShare[]; messages: Message[]; message_unreads: MessageUnread[]; caregivers: Caregiver[] };
type GameState = Pick<AppState, "ok" | "game" | "games" | "teams" | "stations" | "scores" | "materials" | "questions">;
type PulseState = GameState & Pick<AppState, "messages" | "message_unreads">;
type NotificationItem = { id: string; title: string; detail: string; time: string; kind: "ward" | "session" | "message" | "today" };
type AppPrefs = { sidebar: "full" | "compact"; theme: "forest" | "terra" | "cream"; email: boolean; push: boolean };
type BusyRunner = <T>(label: string, task: () => Promise<T>) => Promise<T>;

const templates = ["Własna", "Polska", "Włochy", "Olimp"];
const navItems = [["dashboard", "Pulpit"], ["wards", "Podopieczni"], ["cohorts", "Grupy"], ["sessions", "Zbiórki"], ["gallery", "Galeria"], ["messages", "Wiadomości"], ["staff", "Wychowawcy i grupy"], ["games", "Gry terenowe"]] as const;
const gameTabs = [["prepare", "Przygotowanie"], ["run", "Gra"], ["score", "Ocena"], ["teams", "Drużyny"], ["resources", "QR i materiały"]] as const;
const viewLabels = Object.fromEntries(navItems) as Record<(typeof navItems)[number][0], string>;
const defaultPrefs: AppPrefs = { sidebar: "full", theme: "forest", email: true, push: false };

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { headers: options?.body instanceof FormData ? undefined : { "Content-Type": "application/json" }, ...options });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || "Błąd serwera");
  return data;
}

function dateLabel(value: string) {
  return new Date(value).toLocaleDateString("pl-PL", { day: "numeric", month: "long", year: "numeric" });
}

function secondsLabel(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds || 0));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function initials(name: string) {
  return name.split(" ").filter(Boolean).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

function loadPrefs(): AppPrefs {
  try {
    return { ...defaultPrefs, ...JSON.parse(localStorage.getItem("hufc-prefs") || "{}") };
  } catch {
    return defaultPrefs;
  }
}

function loadIdSet(key: string) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return new Set<string>(Array.isArray(value) ? value : []);
  } catch {
    return new Set<string>();
  }
}

function saveIdSet(key: string, ids: Set<string>) {
  localStorage.setItem(key, JSON.stringify([...ids]));
}

function buildNotifications(state: AppState, user: User): NotificationItem[] {
  const todayKey = new Date().toISOString().slice(0, 10);
  const ownedCohortIds = new Set(state.cohorts.filter((cohort) => user.role === "administrator" || cohort.caretaker_user_id === user.id).map((cohort) => cohort.id));
  const visibleWards = state.wards.filter((ward) => user.role === "administrator" || (ward.cohort_id != null && ownedCohortIds.has(ward.cohort_id)));
  const visibleSessions = state.sessions.filter((session) => user.role === "administrator" || !session.cohort_id || ownedCohortIds.has(session.cohort_id));
  const notifications: NotificationItem[] = [];

  for (const ward of visibleWards.slice(0, 6)) {
    if (!ward.cohort_name) continue;
    notifications.push({
      id: "ward-" + ward.id,
      title: `Do grupy: ${ward.cohort_name} przypisano podopiecznego: ${ward.name}`,
      detail: ward.parent_name ? `Rodzic/opiekun: ${ward.parent_name}` : "Nowy podopieczny w grupie",
      time: "dane z listy podopiecznych",
      kind: "ward"
    });
  }

  for (const session of visibleSessions.slice(0, 8)) {
    const key = String(session.session_date).slice(0, 10);
    notifications.push({
      id: "session-" + session.id,
      title: key === todayKey ? `Dziś odbędzie się zbiórka: ${session.title}` : `Nowa zbiórka dodana: ${session.title}`,
      detail: `${dateLabel(session.session_date)} · ${session.location || "bez lokalizacji"}`,
      time: key === todayKey ? "dzisiaj" : "zaplanowana",
      kind: key === todayKey ? "today" : "session"
    });
  }

  for (const message of state.messages.filter((item) => item.sender_id !== user.id).slice(0, 8)) {
    notifications.push({
      id: "message-" + message.id,
      title: `Nowa wiadomość od: ${message.sender_name || "System hufca"}`,
      detail: message.body || message.photo_title || message.attachment_name || "Wiadomość bez treści",
      time: dateLabel(message.created_at),
      kind: "message"
    });
  }

  return notifications.slice(0, 18);
}

function messageUnreadTotal(state: AppState) {
  return (state.message_unreads || []).reduce((total, item) => total + Number(item.unread_count || 0), 0);
}

function messageUnreadFor(state: AppState, targetType: string, targetId: number | null) {
  const normalizedTargetId = targetId == null ? 0 : Number(targetId);
  return Number((state.message_unreads || []).find((item) => item.target_type === targetType && Number(item.target_id) === normalizedTargetId)?.unread_count || 0);
}

function newestMessageId(messages: Message[]) {
  return messages.reduce((max, message) => Math.max(max, Number(message.id || 0)), 0);
}

function newestIncomingMessage(messages: Message[], userId: number, afterId: number) {
  return messages
    .filter((message) => Number(message.id) > afterId && message.sender_id !== userId)
    .sort((a, b) => Number(b.id) - Number(a.id))[0] || null;
}

async function imageFileToDataUrl(file: File) {
  const bitmap = await createImageBitmap(file);
  const max = 1600;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Nie udało się przygotować zdjęcia");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const mimeType = file.type === "image/png" ? "image/png" : "image/jpeg";
  return {
    image_data: canvas.toDataURL(mimeType, 0.86),
    mime_type: mimeType,
    title: file.name.replace(/\.[^.]+$/, "") || "Zdjęcie"
  };
}

function fileToAttachment(file: File) {
  return new Promise<{ attachment_name: string; attachment_mime: string; attachment_data: string }>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ attachment_name: file.name, attachment_mime: file.type || "application/octet-stream", attachment_data: String(reader.result || "") });
    reader.onerror = () => reject(new Error("Nie udało się przygotować załącznika"));
    reader.readAsDataURL(file);
  });
}

function Button({ children, variant = "secondary", className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" }) {
  return <button className={`btn btn-${variant} ${className}`.trim()} {...props}>{children}</button>;
}

function Panel({ title, kicker, action, children, className = "" }: { title: string; kicker?: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <section className={`panel ${className}`}>
    <div className="panel-head">
      <div>{kicker && <span className="kicker">{kicker}</span>}<h2>{title}</h2></div>
      {action && <div className="panel-action">{action}</div>}
    </div>
    {children}
  </section>;
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return <div className="modal" onClick={onClose}>
    <div className="dialog" onClick={(event) => event.stopPropagation()}>
      <div className="panel-head"><h2>{title}</h2><Button onClick={onClose}>Zamknij</Button></div>
      {children}
    </div>
  </div>;
}

function LoadingDots({ label = "Przetwarzanie..." }: { label?: string }) {
  return <div className="loading-dots-wrap" role="status" aria-live="polite">
    <div className="loading-dots" aria-hidden="true"><div /><div /><div /></div>
    <span>{label}</span>
  </div>;
}

function UiIcon({ name }: { name: string }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (name === "dashboard") return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="2" {...common} /><rect x="13" y="3" width="8" height="8" rx="2" {...common} /><rect x="3" y="13" width="8" height="8" rx="2" {...common} /><rect x="13" y="13" width="8" height="8" rx="2" {...common} /></svg>;
  if (name === "wards") return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4" {...common} /><path d="M4 20c0-4.2 3.6-7 8-7s8 2.8 8 7" {...common} /></svg>;
  if (name === "cohorts") return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="9" r="3.6" {...common} /><circle cx="17" cy="10.5" r="3" {...common} /><path d="M2.5 20c0-3.6 2.9-6.2 6.5-6.2s6.5 2.6 6.5 6.2" {...common} /><path d="M15 14.2c2.6.4 4.7 2.3 4.7 5.8" {...common} /></svg>;
  if (name === "sessions") return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2.5" {...common} /><path d="M3 10h18M8 3v4M16 3v4" {...common} /></svg>;
  if (name === "gallery") return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5" {...common} /><circle cx="9" cy="10" r="1.7" {...common} /><path d="M21 16.5l-5.3-5.5-4 4.3L9 13l-6 5" {...common} /></svg>;
  if (name === "messages") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16V16H8.5L4 20V5.5z" {...common} /></svg>;
  if (name === "staff") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3.2v5.6c0 4.6-3 8.3-7 9.2-4-.9-7-4.6-7-9.2V6.2L12 3z" {...common} /></svg>;
  if (name === "logout") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" {...common} /></svg>;
  if (name === "bell") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 17h12l-1.6-2.3V10a4.4 4.4 0 0 0-8.8 0v4.7L6 17zM10.2 19a1.9 1.9 0 0 0 3.6 0" {...common} /></svg>;
  if (name === "settings") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" {...common} /><path d="M19.4 15a1.8 1.8 0 0 0 .36 1.98l.06.06a2.1 2.1 0 1 1-2.98 2.98l-.06-.06A1.8 1.8 0 0 0 14.8 19.6a1.8 1.8 0 0 0-1.08 1.64v.18a2.1 2.1 0 1 1-4.2 0v-.1A1.8 1.8 0 0 0 8.4 19.6a1.8 1.8 0 0 0-1.98.36l-.06.06a2.1 2.1 0 1 1-2.98-2.98l.06-.06A1.8 1.8 0 0 0 3.8 15a1.8 1.8 0 0 0-1.64-1.08H2a2.1 2.1 0 1 1 0-4.2h.1A1.8 1.8 0 0 0 3.8 8.6a1.8 1.8 0 0 0-.36-1.98l-.06-.06a2.1 2.1 0 1 1 2.98-2.98l.06.06A1.8 1.8 0 0 0 8.4 4a1.8 1.8 0 0 0 1.08-1.64V2.2a2.1 2.1 0 1 1 4.2 0v.1A1.8 1.8 0 0 0 14.8 4a1.8 1.8 0 0 0 1.98-.36l.06-.06a2.1 2.1 0 1 1 2.98 2.98l-.06.06A1.8 1.8 0 0 0 19.4 8.6a1.8 1.8 0 0 0 1.64 1.08h.18a2.1 2.1 0 1 1 0 4.2h-.1A1.8 1.8 0 0 0 19.4 15Z" {...common} /></svg>;
  if (name === "edit") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9" {...common} /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4L16.5 3.5z" {...common} /></svg>;
  if (name === "attach") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.4 11.2 12 20.6a6 6 0 0 1-8.5-8.5l9.8-9.8a4 4 0 0 1 5.7 5.7l-9.8 9.8a2 2 0 0 1-2.8-2.8l8.9-8.9" {...common} /></svg>;
  if (name === "send") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" {...common} /></svg>;
  if (name === "more") return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5" fill="currentColor" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /><circle cx="19" cy="12" r="1.5" fill="currentColor" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V3M6 4.5c2.8-1.6 4.7 1.4 7.5-.1s4.5 1.3 4.5 1.3v8.1c-2.8 1.6-4.7-1.4-7.5.1S6 12.5 6 12.5v-8z" {...common} /></svg>;
}

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState("grimordev@gmail.com");
  const [password, setPassword] = useState("PrywatnieNr7!");
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const result = await api<{ ok: true; user: User }>("/api/login", { method: "POST", body: JSON.stringify({ email, password }) });
      onLogin(result.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nie udało się zalogować");
    }
  }
  return <main className="login">
    <section className="login-brand">
      <div className="brand-lock"><span className="brand-mark">H</span><strong>Hufc</strong></div>
      <h1>Panel wychowawcy - podopieczni, zbiórki i gry terenowe w jednym miejscu.</h1>
      <p>Narzędzie do prowadzenia pracy wychowawczej i gier terenowych bez papieru.</p>
      <small>© 2026 Hufc</small>
    </section>
    <section className="login-pane">
      <form className="login-card" onSubmit={submit}>
        <h2>Logowanie</h2>
        <p>Konto wychowawcy</p>
        <label>E-mail<input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required /></label>
        <label>Hasło<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" required /></label>
        {error && <div className="form-error">{error}</div>}
        <Button variant="primary" type="submit">Zaloguj się</Button>
        <small>Nie masz konta? Skontaktuj się z komendantem hufca.</small>
      </form>
    </section>
  </main>;
}

function App() {
  const [auth, setAuth] = useState<"checking" | "guest" | "ready">("checking");
  const [user, setUser] = useState<User | null>(null);
  const [state, setState] = useState<AppState | null>(null);
  const [view, setView] = useState<(typeof navItems)[number][0]>("dashboard");
  const [gameTab, setGameTab] = useState<(typeof gameTabs)[number][0]>("prepare");
  const [teamId, setTeamId] = useState<number | null>(null);
  const [stationId, setStationId] = useState<number | null>(null);
  const [toast, setToast] = useState("");
  const [busyLabel, setBusyLabel] = useState("");
  const [modal, setModal] = useState<null | "ward" | "session" | "team" | "photo" | "share" | "account" | "tv">(null);
  const [settingsTab, setSettingsTab] = useState<"profil" | "wyglad" | "powiadomienia" | "konto">("profil");
  const [notifOpen, setNotifOpen] = useState(false);
  const [readNotificationIds, setReadNotificationIds] = useState<Set<string>>(() => loadIdSet("hufc-read-notifications"));
  const [clearedNotificationIds, setClearedNotificationIds] = useState<Set<string>>(() => loadIdSet("hufc-cleared-notifications"));
  const [prefs, setPrefsState] = useState<AppPrefs>(() => loadPrefs());
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const navRef = useRef<HTMLElement | null>(null);
  const navItemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [navIndicator, setNavIndicator] = useState({ top: 0, left: 0, width: 0, height: 0, opacity: 0 });
  const [editingWard, setEditingWard] = useState<Ward | null>(null);
  const [editingSession, setEditingSession] = useState<Session | null>(null);
  const [editingPhoto, setEditingPhoto] = useState<Photo | null>(null);
  const [sharingPhoto, setSharingPhoto] = useState<Photo | null>(null);
  const mapEl = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const markers = useRef<L.LayerGroup | null>(null);
  const mapFittedGameRef = useRef<number | null>(null);
  const lastMessageIdRef = useRef(0);
  const readAllInFlightRef = useRef(false);

  const ranking = useMemo(() => [...(state?.teams || [])].sort((a, b) => b.total_points - a.total_points), [state]);
  const activeScore = state?.scores.find((score) => score.team_id === teamId && score.station_id === stationId) || null;
  const notifications = useMemo(() => state && user ? buildNotifications(state, user) : [], [state, user]);
  const visibleNotifications = useMemo(() => notifications.filter((item) => !clearedNotificationIds.has(item.id)), [notifications, clearedNotificationIds]);
  const unreadNotifications = useMemo(() => visibleNotifications.filter((item) => !readNotificationIds.has(item.id)), [visibleNotifications, readNotificationIds]);

  function setPrefs(next: AppPrefs) {
    setPrefsState(next);
    localStorage.setItem("hufc-prefs", JSON.stringify(next));
  }

  async function load(gameId?: number) {
    const data = gameId && state
      ? { ...state, ...(await api<GameState>(`/api/game-state?gameId=${gameId}`)) }
      : await api<AppState>(`/api/state${gameId ? `?gameId=${gameId}` : ""}`);
    if (gameId) mapFittedGameRef.current = null;
    setState(data);
    setTeamId((previous) => previous && data.teams.some((team) => team.id === previous) ? previous : data.teams[0]?.id || null);
    setStationId((previous) => previous && data.stations.some((station) => station.id === previous) ? previous : data.stations[0]?.id || null);
    return data;
  }

  function flash(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  }

  async function runBusy<T>(label: string, task: () => Promise<T>) {
    setBusyLabel(label);
    try {
      return await task();
    } finally {
      setBusyLabel("");
    }
  }

  function openAccount(tab: "profil" | "wyglad" | "powiadomienia" | "konto") {
    setSettingsTab(tab);
    setNotifOpen(false);
    setModal("account");
  }

  function setNotificationsOpen(open: boolean) {
    setNotifOpen(open);
    if (!open || visibleNotifications.length === 0) return;
    const next = new Set(readNotificationIds);
    visibleNotifications.forEach((item) => next.add(item.id));
    setReadNotificationIds(next);
    saveIdSet("hufc-read-notifications", next);
  }

  function clearNotification(id: string) {
    const nextCleared = new Set(clearedNotificationIds);
    nextCleared.add(id);
    setClearedNotificationIds(nextCleared);
    saveIdSet("hufc-cleared-notifications", nextCleared);

    const nextRead = new Set(readNotificationIds);
    nextRead.add(id);
    setReadNotificationIds(nextRead);
    saveIdSet("hufc-read-notifications", nextRead);
  }

  function clearAllNotifications() {
    const nextCleared = new Set(clearedNotificationIds);
    const nextRead = new Set(readNotificationIds);
    visibleNotifications.forEach((item) => {
      nextCleared.add(item.id);
      nextRead.add(item.id);
    });
    setClearedNotificationIds(nextCleared);
    setReadNotificationIds(nextRead);
    saveIdSet("hufc-cleared-notifications", nextCleared);
    saveIdSet("hufc-read-notifications", nextRead);
    setNotifOpen(false);
  }

  async function logout() {
    await runBusy("Wylogowywanie...", () => api("/api/logout", { method: "POST" }));
    setUser(null);
    setAuth("guest");
    setModal(null);
  }

  useEffect(() => {
    api<{ ok: true; user: User }>("/api/me")
      .then(async (result) => {
        setUser(result.user);
        const data = await load();
        lastMessageIdRef.current = newestMessageId(data.messages);
        setAuth("ready");
      })
      .catch(() => setAuth("guest"));
  }, []);

  useEffect(() => {
    if (auth !== "ready" || !state || !user) return;
    if (!lastMessageIdRef.current) lastMessageIdRef.current = newestMessageId(state.messages);
    const timer = window.setInterval(async () => {
      try {
        const previousMessageId = lastMessageIdRef.current;
        const fullMessages = view === "messages";
        const next = fullMessages
          ? await api<AppState>(`/api/state?gameId=${state.game.id}`)
          : await api<PulseState>(`/api/pulse?gameId=${state.game.id}`);
        const incoming = newestIncomingMessage(next.messages, user.id, previousMessageId);
        setState((current) => current ? { ...current, ...next, messages: fullMessages ? next.messages : current.messages } : next as AppState);
        lastMessageIdRef.current = newestMessageId(next.messages);
        if (!incoming || !prefs.push || !("Notification" in window) || Notification.permission !== "granted") return;
        const title = incoming.sender_name ? `Nowa wiadomość od ${incoming.sender_name}` : "Nowa wiadomość w Hufcu";
        const body = incoming.body || incoming.photo_title || incoming.attachment_name || "Nowa wiadomość";
        new Notification(title, { body, tag: `hufc-message-${incoming.id}` });
      } catch {
        // Ciche odświeżanie nie powinno przeszkadzać w pracy panelu.
      }
    }, 7000);
    return () => window.clearInterval(timer);
  }, [auth, state?.game.id, user?.id, prefs.push, view]);

  useEffect(() => {
    if (!state || view !== "messages" || messageUnreadTotal(state) === 0 || readAllInFlightRef.current) return;
    readAllInFlightRef.current = true;
    window.setTimeout(async () => {
      try {
        const next = await api<AppState>("/api/messages/read-all", {
          method: "POST",
          body: JSON.stringify({ game_id: state.game.id })
        });
        setState(next);
      } finally {
        readAllInFlightRef.current = false;
      }
    }, 350);
  }, [view, state?.game.id, state?.message_unreads]);

  useEffect(() => {
    if (!state?.game.timer_running) return;
    const timer = window.setInterval(() => {
      setState((current) => current ? { ...current, game: { ...current.game, remaining_seconds: Math.max(0, current.game.remaining_seconds - 1) } } : current);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [state?.game.timer_running]);

  useEffect(() => {
    const update = () => {
      const nav = navRef.current;
      const item = navItemRefs.current.get(view);
      if (!nav || !item) return;
      const navRect = nav.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      setNavIndicator({
        top: itemRect.top - navRect.top,
        left: itemRect.left - navRect.left,
        width: itemRect.width,
        height: itemRect.height,
        opacity: 1
      });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [view, user?.role, mobileMenuOpen]);

  useEffect(() => {
    if (!state || view !== "games" || gameTab !== "prepare" || !mapEl.current) return;
    if (!map.current) {
      map.current = L.map(mapEl.current);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map.current);
      markers.current = L.layerGroup().addTo(map.current);
      map.current.on("click", (event: L.LeafletMouseEvent) => {
        const form = document.querySelector<HTMLFormElement>("#stationForm");
        if (!form || !state) return;
        (form.elements.namedItem("id") as HTMLInputElement).value = "";
        (form.elements.namedItem("station_order") as HTMLInputElement).value = String(state.stations.length + 1);
        (form.elements.namedItem("lat") as HTMLInputElement).value = event.latlng.lat.toFixed(6);
        (form.elements.namedItem("lng") as HTMLInputElement).value = event.latlng.lng.toFixed(6);
        const title = form.elements.namedItem("title") as HTMLInputElement;
        if (window.matchMedia("(max-width: 680px)").matches) title.scrollIntoView({ block: "center", behavior: "smooth" });
        else title.focus();
      });
    }
    window.setTimeout(() => map.current?.invalidateSize(), 80);
    renderMarkers();
  }, [state, view, gameTab, teamId]);

  function renderMarkers() {
    if (!state || !map.current || !markers.current) return;
    markers.current.clearLayers();
    const points = state.stations.filter((station) => station.lat && station.lng);
    for (const station of points) {
      const done = state.scores.some((score) => score.team_id === teamId && score.station_id === station.id);
      const color = done ? "var(--color-success)" : "var(--color-idle-dot)";
      const icon = L.divIcon({ className: "station-pin", html: `<span style="background:${color}"></span><strong>${station.station_order}</strong>`, iconSize: [34, 34], iconAnchor: [17, 17] });
      const marker = L.marker([Number(station.lat), Number(station.lng)], { draggable: true, icon }).addTo(markers.current);
      marker.bindPopup(`<strong>${station.title}</strong>`);
      marker.on("dragend", async () => {
        const point = marker.getLatLng();
        await saveStation({ ...station, lat: point.lat.toFixed(6), lng: point.lng.toFixed(6) });
      });
    }
    if (mapFittedGameRef.current !== state.game.id) {
      if (points.length) map.current.fitBounds(L.featureGroup(markers.current.getLayers()).getBounds().pad(0.18));
      else map.current.setView([52.22977, 21.01178], 15);
      mapFittedGameRef.current = state.game.id;
    }
  }

  async function saveStation(payload: Partial<Station>) {
    if (!state) return;
    setState(await runBusy("Zapisywanie stacji...", () => api<AppState>("/api/stations", { method: "POST", body: JSON.stringify({ ...payload, game_id: state.game.id }) })));
    flash("Stacja zapisana");
  }

  async function saveGame(form: HTMLFormElement) {
    const data = Object.fromEntries(new FormData(form).entries());
    setState(await runBusy("Zapisywanie gry...", () => api<AppState>("/api/games", { method: "POST", body: JSON.stringify({ ...data, use_template: form.use_template.checked }) })));
    flash(data.id ? "Gra zapisana" : "Nowa gra utworzona");
  }

  async function deleteGame(id: number) {
    if (!state || state.games.length <= 1) {
      flash("Nie można usunąć ostatniej gry");
      return;
    }
    if (!window.confirm(`Usunąć grę "${state.game.name}" razem ze stacjami, drużynami i punktacją?`)) return;
    const next = await runBusy("Usuwanie gry...", () => api<AppState>(`/api/games/${id}`, { method: "DELETE" }));
    setState(next);
    setTeamId(next.teams[0]?.id || null);
    setStationId(next.stations[0]?.id || null);
    flash("Gra usunięta");
  }

  async function focusGameArea(query: string) {
    const phrase = query.trim();
    if (!phrase || !map.current) return;
    await runBusy("Szukam miejsca na mapie...", async () => {
      const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(phrase)}`);
      const results = await response.json();
      if (!Array.isArray(results) || !results[0]) throw new Error("Nie znaleziono miejsca");
      map.current?.setView([Number(results[0].lat), Number(results[0].lon)], 15);
      window.setTimeout(() => map.current?.invalidateSize(), 80);
    });
    flash("Mapa ustawiona");
  }

  function useCurrentLocation() {
    if (!navigator.geolocation || !map.current) {
      flash("Przeglądarka nie udostępnia lokalizacji");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        map.current?.setView([position.coords.latitude, position.coords.longitude], 16);
        window.setTimeout(() => map.current?.invalidateSize(), 80);
        flash("Mapa ustawiona na Twoją lokalizację");
      },
      () => flash("Nie udało się pobrać lokalizacji"),
      { enableHighAccuracy: true, timeout: 9000 }
    );
  }

  function focusNearestStation() {
    if (!state || !map.current) return;
    const points = state.stations.filter((station) => station.lat && station.lng);
    if (!points.length) {
      flash("Ta gra nie ma jeszcze stacji na mapie");
      return;
    }
    const center = map.current.getCenter();
    const nearest = points
      .map((station) => ({
        station,
        distance: map.current!.distance(center, L.latLng(Number(station.lat), Number(station.lng)))
      }))
      .sort((a, b) => a.distance - b.distance)[0].station;
    map.current.setView([Number(nearest.lat), Number(nearest.lng)], Math.max(map.current.getZoom(), 16), { animate: true });
    window.setTimeout(() => map.current?.invalidateSize(), 80);
    flash(`Mapa wróciła do stacji: ${nearest.title}`);
  }

  function useMapCenterForStation() {
    if (!state || !map.current) return;
    const center = map.current.getCenter();
    const form = document.querySelector<HTMLFormElement>("#stationForm");
    if (!form) return;
    (form.elements.namedItem("id") as HTMLInputElement).value = "";
    (form.elements.namedItem("station_order") as HTMLInputElement).value = String(state.stations.length + 1);
    (form.elements.namedItem("lat") as HTMLInputElement).value = center.lat.toFixed(6);
    (form.elements.namedItem("lng") as HTMLInputElement).value = center.lng.toFixed(6);
    const title = form.elements.namedItem("title") as HTMLInputElement;
    if (window.matchMedia("(max-width: 680px)").matches) {
      title.scrollIntoView({ block: "center", behavior: "smooth" });
    } else {
      title.focus();
    }
    flash(`Punkt ustawiony: ${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}`);
  }

  async function uploadPhotos(sessionId: number, files: File[]) {
    if (!state) return;
    const nextState = await runBusy(files.length === 1 ? "Wgrywanie zdjęcia..." : "Wgrywanie zdjęć...", async () => {
      let next = state;
      for (const file of files) {
        const image = await imageFileToDataUrl(file);
        next = await api<AppState>("/api/photos", {
          method: "POST",
          body: JSON.stringify({ session_id: sessionId, game_id: state.game.id, ...image })
        });
      }
      return next;
    });
    setState(nextState);
    flash(files.length === 1 ? "Zdjęcie zapisane w galerii" : "Zdjęcia zapisane w galerii");
  }

  if (auth === "checking") return <div className="loading"><LoadingDots label="Ładowanie panelu..." /></div>;
  if (auth === "guest" || !user) return <Login onLogin={async (next) => { setUser(next); await load(); setAuth("ready"); }} />;
  if (!state) return <div className="loading"><LoadingDots label="Ładowanie danych..." /></div>;

  const visibleNavItems = navItems.filter(([id]) => user.role === "administrator" || id !== "staff");
  const unreadMessagesCount = Math.min(99, messageUnreadTotal(state));

  return <div className={`app-shell theme-${prefs.theme} sidebar-${prefs.sidebar} ${mobileMenuOpen ? "menu-open" : ""}`}>
    <button className="mobile-menu-button" type="button" aria-label="Otwórz menu" onClick={() => setMobileMenuOpen(true)}><span /><span /><span /></button>
    {mobileMenuOpen && <button className="menu-backdrop" type="button" aria-label="Zamknij menu" onClick={() => setMobileMenuOpen(false)} />}
    <aside className="sidebar">
      <div className="brand-lock"><span className="brand-mark">H</span><span><strong>Hufc</strong><small>Panel wychowawcy</small></span></div>
      <nav className="side-nav" ref={navRef}>
        <span className="nav-indicator" style={{ transform: `translate(${navIndicator.left}px, ${navIndicator.top}px)`, width: navIndicator.width, height: navIndicator.height, opacity: navIndicator.opacity }} />
        {visibleNavItems.map(([id, label]) => <button key={id} ref={(node) => { if (node) navItemRefs.current.set(id, node); else navItemRefs.current.delete(id); }} className={`nav-item ${view === id ? "active" : ""}`} onClick={() => { setView(id); setMobileMenuOpen(false); setNotifOpen(false); }}>
          <UiIcon name={id} />
          <span>{label}</span>
          {id === "messages" && unreadMessagesCount > 0 && <em>{unreadMessagesCount}</em>}
        </button>)}
      </nav>
      <div className="sidebar-footer">
        <button className="user-chip" onClick={() => openAccount("profil")}>
          <span>{initials(user.name)}</span><strong>{user.name}</strong><small>{user.role}</small>
        </button>
        <button className="logout-button" onClick={logout}><UiIcon name="logout" /><span>Wyloguj się</span></button>
      </div>
    </aside>

    <main className="main full">
      <TopBar view={view} user={user} notifications={visibleNotifications} readNotificationIds={readNotificationIds} notifOpen={notifOpen} setNotifOpen={setNotificationsOpen} onClearNotification={clearNotification} onClearAllNotifications={clearAllNotifications} openAccount={openAccount} />
      <div className="main-content">
        <div className="view-stage" key={view}>
          {view === "dashboard" && <Dashboard state={state} user={user} setView={setView} />}
          {view === "wards" && <Wards state={state} onAdd={() => { setEditingWard(null); setModal("ward"); }} onEdit={(ward) => { setEditingWard(ward); setModal("ward"); }} />}
          {view === "cohorts" && <Cohorts state={state} />}
          {view === "sessions" && <Sessions state={state} onAdd={() => { setEditingSession(null); setModal("session"); }} onEdit={(session) => { setEditingSession(session); setModal("session"); }} onDelete={async (id) => setState(await runBusy("Usuwanie zbiórki...", () => api<AppState>(`/api/sessions/${id}?gameId=${state.game.id}`, { method: "DELETE" })))} />}
          {view === "gallery" && <Gallery state={state} onAddGallery={() => { setEditingSession(null); setModal("session"); }} onUploadPhotos={uploadPhotos} onEditPhoto={(photo) => { setEditingPhoto(photo); setModal("photo"); }} onShareInternal={(photo) => { setSharingPhoto(photo); setModal("share"); }} onDeletePhoto={async (id) => setState(await runBusy("Usuwanie zdjęcia...", () => api<AppState>(`/api/photos/${id}?gameId=${state.game.id}`, { method: "DELETE" })))} />}
          {view === "messages" && <MessagesView state={state} user={user} setState={setState} />}
          {view === "staff" && user.role === "administrator" && <StaffView state={state} setState={setState} />}
          {view === "games" && <GamesModule state={state} gameTab={gameTab} setGameTab={setGameTab} ranking={ranking} teamId={teamId} stationId={stationId} setTeamId={setTeamId} setStationId={setStationId} activeScore={activeScore} mapRef={mapEl} onSaveGame={saveGame} onDeleteGame={deleteGame} onFocusArea={focusGameArea} onUseCurrentLocation={useCurrentLocation} onUseMapCenter={useMapCenterForStation} onFocusNearestStation={focusNearestStation} onSaveStation={saveStation} onAddTeam={() => setModal("team")} onDeleteStation={async (id) => setState(await runBusy("Usuwanie stacji...", () => api<AppState>(`/api/stations/${id}?gameId=${state.game.id}`, { method: "DELETE" })))} onTimer={async (command) => setState(await runBusy("Aktualizowanie timera...", () => api<AppState>("/api/timer", { method: "POST", body: JSON.stringify({ game_id: state.game.id, command }) })))} onScore={async (payload) => { setState(await runBusy("Zapisywanie oceny...", () => api<AppState>("/api/scores", { method: "POST", body: JSON.stringify(payload) }))); flash("Ocena zapisana"); }} setState={setState} load={(gameId?: number) => runBusy("Przełączanie gry...", () => load(gameId))} openTv={() => setModal("tv")} />}
        </div>
      </div>
    </main>

    {modal === "ward" && <WardDialog state={state} ward={editingWard} onClose={() => setModal(null)} onSaved={(next) => { setState(next); setModal(null); }} onDelete={async (id) => { setState(await runBusy("Usuwanie podopiecznego...", () => api<AppState>(`/api/wards/${id}?gameId=${state.game.id}`, { method: "DELETE" }))); setModal(null); }} runBusy={runBusy} />}
    {modal === "session" && <SessionDialog state={state} session={editingSession} onClose={() => setModal(null)} onSaved={(next) => { setState(next); setModal(null); }} runBusy={runBusy} />}
    {modal === "photo" && editingPhoto && <PhotoDialog state={state} photo={editingPhoto} onClose={() => setModal(null)} onSaved={(next) => { setState(next); setModal(null); }} runBusy={runBusy} />}
    {modal === "share" && sharingPhoto && <ShareDialog state={state} photo={sharingPhoto} onClose={() => setModal(null)} onSaved={(next) => { setState(next); setModal(null); }} runBusy={runBusy} />}
    {modal === "account" && <AccountDialog user={user} initialTab={settingsTab} prefs={prefs} setPrefs={setPrefs} notifications={notifications} onClose={() => setModal(null)} onSaved={(next) => { setUser(next); setModal(null); }} onLogout={logout} />}
    {modal === "team" && <TeamDialog gameId={state.game.id} onClose={() => setModal(null)} onSaved={(next) => { setState(next); setModal(null); }} />}
    {modal === "tv" && <TvDialog state={state} ranking={ranking} onClose={() => setModal(null)} />}
    {busyLabel && <div className="busy-overlay"><LoadingDots label={busyLabel} /></div>}
    <nav className="mobile-bottom-nav" aria-label="Nawigacja mobilna">
      {(["dashboard", "sessions", "messages", "gallery"] as const).map((id) => <button key={id} className={view === id ? "active" : ""} type="button" onClick={() => { setView(id); setMobileMenuOpen(false); setNotifOpen(false); }}>
        <UiIcon name={id} />
        <span>{id === "dashboard" ? "Pulpit" : viewLabels[id]}</span>
        {id === "messages" && unreadMessagesCount > 0 && <em>{unreadMessagesCount}</em>}
      </button>)}
      <button type="button" onClick={() => setMobileMenuOpen(true)}>
        <UiIcon name="more" />
        <span>Więcej</span>
      </button>
    </nav>
    {toast && <div className="toast">{toast}</div>}
  </div>;
}

function TopBar({ view, user, notifications, readNotificationIds, notifOpen, setNotifOpen, onClearNotification, onClearAllNotifications, openAccount }: { view: (typeof navItems)[number][0]; user: User; notifications: NotificationItem[]; readNotificationIds: Set<string>; notifOpen: boolean; setNotifOpen: (open: boolean) => void; onClearNotification: (id: string) => void; onClearAllNotifications: () => void; openAccount: (tab: "profil" | "wyglad" | "powiadomienia" | "konto") => void }) {
  const firstName = user.name.split(" ")[0] || user.name;
  const unreadCount = notifications.filter((item) => !readNotificationIds.has(item.id)).length;
  return <header className="topbar">
    <div className="mobile-top-title"><span className="brand-mark">H</span><strong>{viewLabels[view]}</strong></div>
    <div className="breadcrumb">Panel wychowawcy · {viewLabels[view]}</div>
    <div className="top-actions">
      <div className="notification-wrap">
        <button className="icon-button" type="button" aria-label="Powiadomienia" onClick={() => setNotifOpen(!notifOpen)}>
          <UiIcon name="bell" />
          {unreadCount > 0 && <span className="notif-dot" />}
        </button>
        {notifOpen && <div className="notification-menu">
          <div className="notification-head"><strong>Powiadomienia</strong>{notifications.length > 0 && <button type="button" onClick={onClearAllNotifications}>Wyczyść</button>}</div>
          {notifications.length === 0 && <p className="notification-empty">Brak powiadomień.</p>}
          {notifications.slice(0, 10).map((item) => <div className={`notification-row ${item.kind} ${readNotificationIds.has(item.id) ? "read" : "unread"}`} key={item.id}>
            <span />
            <div><b>{item.title}</b><small>{item.detail}</small><small>{item.time}</small></div>
            <button className="notification-remove" type="button" aria-label="Usuń powiadomienie" onClick={(event) => { event.stopPropagation(); onClearNotification(item.id); }}>Usuń</button>
          </div>)}
        </div>}
      </div>
      <button className="icon-button" type="button" aria-label="Ustawienia" onClick={() => openAccount("wyglad")}><UiIcon name="settings" /></button>
      <button className="top-user-chip" type="button" onClick={() => openAccount("profil")}><span>{initials(user.name)}</span><strong>{firstName}</strong></button>
    </div>
  </header>;
}

function Dashboard({ state, user, setView }: { state: AppState; user: User; setView: (view: (typeof navItems)[number][0]) => void }) {
  const next = state.sessions[0];
  return <div>
    <section className="welcome-hero">
      <div className="hero-orb" />
      <span>Witaj,</span>
      <h1>{user.name}</h1>
      <p><i />Najbliższa zbiórka: <strong>{next ? next.title : "Brak zaplanowanej zbiórki"}</strong>{next ? " · " + dateLabel(next.session_date) : ""}</p>
    </section>
    <div className="stat-grid">
      <Panel title="Podopieczni"><strong className="stat-number">{state.wards.length}</strong></Panel>
      <Panel title="Grupy"><strong className="stat-number">{state.cohorts.length}</strong></Panel>
      <Panel title="Wiadomości"><strong className="stat-number accent">{messageUnreadTotal(state)}</strong></Panel>
    </div>
    <div className="dashboard-grid">
      <Panel title="Nadchodzące zbiórki" action={<Button onClick={() => setView("sessions")}>Wszystkie</Button>}>
        <div className="session-card-grid">{state.sessions.slice(0, 3).map((session) => <SessionCard key={session.id} session={session} />)}</div>
      </Panel>
      <Panel title="Z galerii" action={<Button onClick={() => setView("gallery")}>Galeria</Button>}>
        <div className="photo-preview-grid">{state.photos.slice(0, 4).map((photo) => <PhotoTile key={photo.id} photo={photo} />)}</div>
      </Panel>
    </div>
  </div>;
}

function Wards({ state, onAdd, onEdit }: { state: AppState; onAdd: () => void; onEdit: (ward: Ward) => void }) {
  const [query, setQuery] = useState("");
  const rows = state.wards.filter((ward) => ward.name.toLowerCase().includes(query.toLowerCase()));
  return <div>
    <div className="page-head"><h1>Podopieczni</h1><Button variant="primary" onClick={onAdd}>Dodaj podopiecznego</Button></div>
    <label className="search">Szukaj<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Imię i nazwisko" /></label>
    <div className="rows">{rows.map((ward) => <article className="person-row" key={ward.id}><span>{initials(ward.name)}</span><div><strong>{ward.name}</strong><small>{ward.age} lat · rodzic: {ward.parent_name} · {ward.contact}</small></div><em>{ward.cohort_name}</em><button className="row-icon-button" type="button" aria-label={`Edytuj ${ward.name}`} onClick={() => onEdit(ward)}><UiIcon name="edit" /></button></article>)}</div>
  </div>;
}

function Cohorts({ state }: { state: AppState }) {
  const [selectedId, setSelectedId] = useState(state.cohorts[0]?.id || 0);
  const selected = state.cohorts.find((cohort) => cohort.id === selectedId) || state.cohorts[0];
  const members = selected ? state.wards.filter((ward) => ward.cohort_id === selected.id) : [];
  return <div>
    <div className="page-head"><div><h1>Grupy</h1><p className="help">Kliknij grupę, żeby zobaczyć wychowawcę, członków i dane organizacyjne.</p></div></div>
    <div className="cohort-layout">
      <div className="cohort-grid">{state.cohorts.map((cohort) => <button key={cohort.id} className={"cohort-card " + (selected?.id === cohort.id ? "active" : "")} onClick={() => setSelectedId(cohort.id)}>
        <span>{cohort.ward_count} osób</span>
        <strong>{cohort.name}</strong>
        <small>Wychowawca: {cohort.caretaker_user_name || "Bez opiekuna"}</small>
      </button>)}</div>
      <Panel title={selected?.name || "Brak grup"} kicker="szczegóły grupy" className="cohort-details">
        {selected ? <>
          <div className="detail-lines">
            <p><span>Wychowawca</span><strong>{selected.caretaker_user_name || "Bez opiekuna"}</strong></p>
            <p><span>E-mail</span><strong>{selected.caretaker_email || "brak"}</strong></p>
            <p><span>Podopieczni</span><strong>{members.length}</strong></p>
          </div>
          <div className="member-list">{members.length ? members.map((ward) => <article key={ward.id} className="member-row"><span>{initials(ward.name)}</span><div><strong>{ward.name}</strong><small>{ward.age} lat · rodzic: {ward.parent_name || "brak danych"}</small></div></article>) : <p className="empty">Ta grupa nie ma jeszcze przypisanych podopiecznych.</p>}</div>
        </> : <p className="empty">Najpierw utwórz grupę w panelu administratora.</p>}
      </Panel>
    </div>
  </div>;
}


function Sessions({ state, onAdd, onEdit, onDelete }: { state: AppState; onAdd: () => void; onEdit: (session: Session) => void; onDelete: (id: number) => void }) {
  const [filter, setFilter] = useState<"all" | "grupa" | "moja">("all");
  const [mode, setMode] = useState<"cards" | "calendar">("cards");
  const [month, setMonth] = useState(() => {
    const first = state.sessions[0]?.session_date;
    const date = first ? new Date(first) : new Date();
    return new Date(date.getFullYear(), date.getMonth(), 1);
  });
  const rows = state.sessions.filter((session) => filter === "all" || session.scope === filter);
  return <div>
    <div className="page-head session-head"><h1>Zbiórki</h1><div className="button-row session-actions"><Button onClick={() => setMode(mode === "calendar" ? "cards" : "calendar")}>{mode === "calendar" ? "Lista" : "Kalendarz"}</Button><Button onClick={() => downloadSessionsIcs(rows)}>ICS</Button><Button variant="primary" onClick={onAdd}>Zaplanuj</Button></div></div>
    <label className="mobile-filter-select">Widok<select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="all">Wszystkie zbiórki</option><option value="grupa">Cała grupa hufcowa</option><option value="moja">Mój osobisty kalendarz</option></select></label>
    <div className="pill-row session-filter-pills"><button className={filter === "all" ? "pill active" : "pill"} onClick={() => setFilter("all")}>Wszystkie</button><button className={filter === "grupa" ? "pill active" : "pill"} onClick={() => setFilter("grupa")}>Cała grupa hufcowa</button><button className={filter === "moja" ? "pill active" : "pill"} onClick={() => setFilter("moja")}>Mój osobisty kalendarz</button></div>
    {mode === "calendar"
      ? <SessionCalendar sessions={rows} month={month} setMonth={setMonth} onEdit={onEdit} />
      : <div className="session-grid">{rows.map((session) => <SessionCard key={session.id} session={session} actions={<><Button onClick={() => onEdit(session)}>Edytuj</Button><Button variant="danger" onClick={() => onDelete(session.id)}>Usuń</Button></>} />)}</div>}
  </div>;
}

function SessionCalendar({ sessions, month, setMonth, onEdit }: { sessions: Session[]; month: Date; setMonth: (date: Date) => void; onEdit: (session: Session) => void }) {
  const start = new Date(month.getFullYear(), month.getMonth(), 1);
  const end = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const offset = (start.getDay() + 6) % 7;
  const cells = Array.from({ length: Math.ceil((offset + end.getDate()) / 7) * 7 }, (_, index) => {
    const day = new Date(start);
    day.setDate(index - offset + 1);
    return day;
  });
  const monthLabel = month.toLocaleDateString("pl-PL", { month: "long", year: "numeric" });

  return <section className="calendar-panel">
    <div className="calendar-toolbar">
      <Button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>Poprzedni</Button>
      <h2>{monthLabel}</h2>
      <div className="button-row"><Button onClick={() => setMonth(new Date())}>Dzisiaj</Button><Button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>Następny</Button></div>
    </div>
    <div className="calendar-weekdays">{["Pon", "Wt", "Śr", "Czw", "Pt", "Sob", "Nd"].map((day) => <strong key={day}>{day}</strong>)}</div>
    <div className="calendar-grid">
      {cells.map((day) => {
        const key = day.toISOString().slice(0, 10);
        const daySessions = sessions.filter((session) => String(session.session_date).slice(0, 10) === key);
        const outside = day.getMonth() !== month.getMonth();
        return <article className={"calendar-day " + (outside ? "outside" : "")} key={key}>
          <span>{day.getDate()}</span>
          {daySessions.map((session) => <button key={session.id} className="calendar-event" onClick={() => onEdit(session)}>
            <strong>{session.title}</strong>
            <small>{session.cohort_name || "Cały hufiec"} · {session.location || "bez lokalizacji"}</small>
          </button>)}
        </article>;
      })}
    </div>
  </section>;
}

function downloadSessionsIcs(sessions: Session[]) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Hufc//Panel wychowawcy//PL"];
  for (const session of sessions) {
    const date = String(session.session_date).slice(0, 10).replaceAll("-", "");
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    lines.push("BEGIN:VEVENT", "UID:session-" + session.id + "@hufc", "DTSTAMP:" + stamp, "DTSTART;VALUE=DATE:" + date, "SUMMARY:" + icsText(session.title), "DESCRIPTION:" + icsText((session.cohort_name || "Cały hufiec") + " | Obecność " + session.attendance + "/" + session.total), "LOCATION:" + icsText(session.location || ""), "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  const blob = new Blob([lines.join("\r\n")], { type: "text/calendar;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "zbiorki-hufca.ics";
  link.click();
  URL.revokeObjectURL(link.href);
}

function icsText(value: string) {
  return value.replace(/[\\;,]/g, "\\$&").replace(/\n/g, "\\n");
}

async function sharePhoto(photo: Photo) {
  const url = photo.share_token ? location.origin + "/share/photo/" + photo.share_token : location.href;
  if (navigator.share) {
    await navigator.share({ title: photo.title, url });
    return;
  }
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(url);
    return;
  }
  const field = document.createElement("textarea");
  field.value = url;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.focus();
  field.select();
  document.execCommand("copy");
  field.remove();
}

function Gallery({ state, onAddGallery, onUploadPhotos, onEditPhoto, onShareInternal, onDeletePhoto }: { state: AppState; onAddGallery: () => void; onUploadPhotos: (sessionId: number, files: File[]) => void; onEditPhoto: (photo: Photo) => void; onShareInternal: (photo: Photo) => void; onDeletePhoto: (id: number) => void }) {
  const [openId, setOpenId] = useState<number | null>(null);
  const photos = state.photos.filter((photo) => photo.image_data);
  const openIndex = openId ? photos.findIndex((photo) => photo.id === openId) : -1;
  const openPhoto = openIndex >= 0 ? photos[openIndex] : null;
  const showPhoto = (photo: Photo) => photo.image_data && setOpenId(photo.id);
  const move = (direction: number) => {
    if (!photos.length || openIndex < 0) return;
    const next = (openIndex + direction + photos.length) % photos.length;
    setOpenId(photos[next].id);
  };

  return <div>
    <div className="page-head">
      <div><h1>Galeria</h1><p className="help">Galerie tworzą się automatycznie dla zbiórek. Zdjęcia można robić aparatem, dodawać z telefonu lub komputera, powiększać i udostępniać.</p></div>
      <Button variant="primary" onClick={onAddGallery}>Nowa galeria</Button>
    </div>
    {state.sessions.map((session) => {
      const sessionPhotos = state.photos.filter((photo) => photo.session_id === session.id);
      return <section className="gallery-section" key={session.id}>
        <div className="gallery-head"><div><h2>{session.title}</h2><span>{dateLabel(session.session_date)} · {sessionPhotos.length} zdjęć</span></div></div>
        <div className="gallery-grid">
          {sessionPhotos.map((photo) => <PhotoTile key={photo.id} photo={photo} onOpen={showPhoto} onEdit={onEditPhoto} onShareInternal={onShareInternal} onDelete={onDeletePhoto} />)}
          <div className="photo-upload-card">
            <label className="upload-action primary-upload">
              <input type="file" accept="image/*" capture="environment" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) onUploadPhotos(session.id, [file]); event.currentTarget.value = ""; }} />
              <strong>Zrób zdjęcie</strong>
              <small>Otwiera aparat telefonu</small>
            </label>
            <label className="upload-action">
              <input type="file" accept="image/*" multiple onChange={(event) => { const files = Array.from(event.currentTarget.files || []); if (files.length) onUploadPhotos(session.id, files); event.currentTarget.value = ""; }} />
              <strong>Wgraj zdjęcia</strong>
              <small>Z galerii telefonu lub dysku</small>
            </label>
          </div>
        </div>
      </section>;
    })}
    {openPhoto && <GalleryLightbox photo={openPhoto} current={openIndex + 1} total={photos.length} onClose={() => setOpenId(null)} onPrev={() => move(-1)} onNext={() => move(1)} onShare={() => sharePhoto(openPhoto)} />}
  </div>;
}

function GalleryLightbox({ photo, current, total, onClose, onPrev, onNext, onShare }: { photo: Photo; current: number; total: number; onClose: () => void; onPrev: () => void; onNext: () => void; onShare: () => void }) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft") onPrev();
      if (event.key === "ArrowRight") onNext();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, onPrev, onNext]);

  return <div className="lightbox" role="dialog" aria-modal="true">
    <button className="lightbox-close" onClick={onClose}>Zamknij</button>
    <button className="lightbox-nav prev" aria-label="Poprzednie zdjęcie" onClick={onPrev}><span>Poprzednie</span></button>
    <figure>
      {photo.image_data && <img src={photo.image_data} alt={photo.title} />}
      <figcaption><strong>{photo.title}</strong><span>{current}/{total} · {dateLabel(photo.created_at || photo.session_date)}</span></figcaption>
    </figure>
    <button className="lightbox-nav next" aria-label="Następne zdjęcie" onClick={onNext}><span>Następne</span></button>
    <div className="lightbox-actions"><Button onClick={onShare}>Udostępnij</Button></div>
  </div>;
}

function GamesModule(props: { state: AppState; gameTab: string; setGameTab: (tab: any) => void; ranking: Team[]; teamId: number | null; stationId: number | null; setTeamId: (id: number) => void; setStationId: (id: number) => void; activeScore: Score | null; mapRef: React.RefObject<HTMLDivElement>; onSaveGame: (form: HTMLFormElement) => void; onDeleteGame: (id: number) => void; onFocusArea: (query: string) => void; onUseCurrentLocation: () => void; onUseMapCenter: () => void; onFocusNearestStation: () => void; onSaveStation: (payload: Partial<Station>) => void; onAddTeam: () => void; onDeleteStation: (id: number) => void; onTimer: (command: "start" | "pause" | "reset") => void; onScore: (payload: { team_id: number | null; station_id: number | null; points: number; correct: boolean; cooperation: number; comment: string }) => void; setState: (state: AppState) => void; load: (gameId?: number) => void; openTv: () => void }) {
  const { state } = props;
  const completedStations = state.scores.filter((score) => score.team_id === props.teamId && score.finished_at).length;
  return <div>
    <div className="page-head game-head">
      <div><span className="kicker">Gry terenowe</span><h1>{state.game.name}</h1><p className="help">{state.stations.length} stacji · {state.teams.length} drużyn · {completedStations}/{state.stations.length} ukończonych dla wybranej drużyny</p></div>
      <div className="button-row game-toolbar"><label className="game-select">Wybierz grę<select value={state.game.id} onChange={(event) => props.load(Number(event.target.value))}>{state.games.map((game) => <option key={game.id} value={game.id}>{game.name}</option>)}</select></label><Button onClick={props.openTv} variant="primary">Ekran TV</Button><Button variant="danger" onClick={() => props.onDeleteGame(state.game.id)} disabled={state.games.length <= 1}>Usuń grę</Button></div>
    </div>
    <div className="pill-row game-tabs">{gameTabs.map(([id, label]) => <button key={id} className={props.gameTab === id ? "pill active" : "pill"} onClick={() => props.setGameTab(id)}>{label}</button>)}</div>
    {props.gameTab === "prepare" && <GamePrepare {...props} />}
    {props.gameTab === "run" && <GameRun state={state} ranking={props.ranking} onTimer={props.onTimer} setGameTab={props.setGameTab} />}
    {props.gameTab === "score" && <ScoreView state={state} teamId={props.teamId} stationId={props.stationId} score={props.activeScore} setTeamId={props.setTeamId} setStationId={props.setStationId} onSave={props.onScore} />}
    {props.gameTab === "teams" && <TeamsView state={state} onAdd={props.onAddTeam} />}
    {props.gameTab === "resources" && <ResourcesView state={state} setState={props.setState} />}
  </div>;
}

function GamePrepare({ state, onSaveGame, onSaveStation, onAddTeam, onDeleteStation, mapRef, onFocusArea, onUseCurrentLocation, onUseMapCenter, onFocusNearestStation }: any) {
  return <div className="flow">
    <Panel kicker="Krok 1" title="Ustaw grę"><form id="gameForm" className="form-grid" onSubmit={(event) => { event.preventDefault(); onSaveGame(event.currentTarget); }}><input name="id" type="hidden" defaultValue={state.game.id} /><label>Nazwa gry<input name="name" defaultValue={state.game.name} required /></label><label>Typ<select name="template" defaultValue={state.game.template}>{templates.map((item) => <option key={item}>{item}</option>)}</select></label><label>Data<input name="game_date" type="date" defaultValue={String(state.game.game_date).slice(0, 10)} /></label><label>Start<input name="start_time" type="time" defaultValue={String(state.game.start_time).slice(0, 5)} /></label><label>Czas minut<input name="duration_minutes" type="number" min={5} max={600} defaultValue={state.game.duration_minutes} /></label><label className="check"><input name="use_template" type="checkbox" /> Dodaj przykładowe stacje</label><div className="form-actions"><Button variant="primary" type="submit">Zapisz grę</Button></div></form></Panel>
    <Panel kicker="Krok 2" title="Stacje na mapie" action={<span>Ustaw obszar, potem dodaj punkty</span>}><form className="map-search" onSubmit={(event) => { event.preventDefault(); const input = event.currentTarget.elements.namedItem("area") as HTMLInputElement; onFocusArea(input.value); }}><label>Obszar gry<input name="area" placeholder="np. Gdańsk, Park Oliwski" /></label><Button variant="primary">Pokaż obszar</Button><Button type="button" onClick={onUseCurrentLocation}>Moja lokalizacja</Button></form><div className="builder"><div className="map-panel"><div ref={mapRef} className="map" /><div className="map-tools"><div className="map-tool-buttons"><Button type="button" onClick={onUseMapCenter}>Ustaw punkt w środku mapy</Button>{state.stations.some((station: Station) => station.lat && station.lng) && <Button type="button" onClick={onFocusNearestStation}>Wróć do najbliższej stacji</Button>}</div><span>Na telefonie przesuń mapę i użyj przycisków pod mapą, bez celowania palcem w punkt.</span></div></div><div className="station-side"><form id="stationForm" className="stack" onSubmit={(event) => { event.preventDefault(); onSaveStation(Object.fromEntries(new FormData(event.currentTarget).entries())); event.currentTarget.reset(); }}><input name="id" type="hidden" /><label>Nazwa stacji<input name="title" placeholder="np. Most nad rzeką" required /></label><label>Kolejność<input name="station_order" type="number" min={1} defaultValue={state.stations.length + 1} /></label><div className="coord-grid"><label>Lat<input name="lat" type="number" step="0.000001" placeholder="kliknij mapę" /></label><label>Lng<input name="lng" type="number" step="0.000001" placeholder="kliknij mapę" /></label></div><Button variant="primary">Zapisz stację</Button></form><div className="station-list-admin">{state.stations.map((station: Station) => <article key={station.id} className="manage-row"><div><strong>{station.station_order}. {station.title}</strong><small>{station.lat ? `${Number(station.lat).toFixed(5)}, ${Number(station.lng).toFixed(5)}` : "bez punktu"}</small></div><Button onClick={() => fillStationForm(station)}>Edytuj</Button><Button variant="danger" onClick={() => onDeleteStation(station.id)}>Usuń</Button></article>)}</div></div></div></Panel>
    <Panel kicker="Krok 3" title="Drużyny" action={<Button variant="primary" onClick={onAddTeam}>Dodaj drużynę</Button>}><div className="mini-grid">{state.teams.map((team: Team) => <div key={team.id} className="mini-row"><span style={{ background: team.color }} /><strong>{team.name}</strong><small>{team.total_points} pkt</small></div>)}</div></Panel>
  </div>;
}

function fillStationForm(station: Station) {
  const form = document.querySelector<HTMLFormElement>("#stationForm");
  if (!form) return;
  (form.elements.namedItem("id") as HTMLInputElement).value = String(station.id);
  (form.elements.namedItem("title") as HTMLInputElement).value = station.title;
  (form.elements.namedItem("station_order") as HTMLInputElement).value = String(station.station_order);
  (form.elements.namedItem("lat") as HTMLInputElement).value = station.lat || "";
  (form.elements.namedItem("lng") as HTMLInputElement).value = station.lng || "";
}

function GameRun({ state, ranking, onTimer, setGameTab }: { state: AppState; ranking: Team[]; onTimer: (command: "start" | "pause" | "reset") => void; setGameTab: (tab: any) => void }) {
  const ratio = state.game.remaining_seconds / Math.max(1, state.game.duration_minutes * 60);
  return <div className="run-grid"><Panel kicker="Timer gry" title={state.game.timer_running ? "Odlicza" : "Gotowa"} action={<span>{state.game.duration_minutes} min</span>} className="timer-panel"><div className={`timer ${ratio < .15 ? "danger" : ratio < .35 ? "warning" : ""}`}>{secondsLabel(state.game.remaining_seconds)}</div><div className="progress"><span style={{ width: `${Math.max(0, Math.min(1, ratio)) * 100}%` }} /></div><div className="button-row"><Button variant="primary" onClick={() => onTimer("start")}>Start</Button><Button onClick={() => onTimer("pause")}>Pauza</Button><Button onClick={() => onTimer("reset")}>Reset</Button></div></Panel><Panel title="Ranking live" action={<span>{state.teams.length} drużyn</span>}><Ranking ranking={ranking} /></Panel><Panel title="Szybkie akcje"><div className="action-grid"><Button onClick={() => setGameTab("score")}>Oceń stację</Button><Button onClick={() => setGameTab("teams")}>Drużyny</Button><Button onClick={() => setGameTab("prepare")}>Stacje na mapie</Button><Button onClick={() => setGameTab("resources")}>QR i materiały</Button></div></Panel></div>;
}

function ScoreView({ state, teamId, stationId, score, setTeamId, setStationId, onSave }: any) {
  const [points, setPoints] = useState(score?.points || 7);
  useEffect(() => setPoints(score?.points || 7), [score?.points, teamId, stationId]);
  return <div className="score-grid"><Panel title="Drużyna">{state.teams.map((team: Team) => <button key={team.id} className={`choice ` + (team.id === teamId ? "active" : "")} onClick={() => setTeamId(team.id)}><strong>{team.name}</strong><small>{team.total_points} pkt</small></button>)}</Panel><Panel title="Stacja">{state.stations.map((station: Station) => {
    const done = state.scores.some((s: Score) => s.team_id === teamId && s.station_id === station.id && s.finished_at);
    return <button key={station.id} className={`choice station-choice ` + (station.id === stationId ? "active " : "") + (done ? "done" : "")} onClick={() => setStationId(station.id)}><span><strong>{station.title}</strong><small>{done ? "uko\u0144czona" : "nieodwiedzona"}</small></span>{done && <b>&#10003;</b>}</button>;
  })}</Panel><Panel title={state.stations.find((s: Station) => s.id === stationId)?.title || "Ocena"}><form className="stack" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; onSave({ team_id: teamId, station_id: stationId, points, correct: form.correct.checked, cooperation: Number(form.cooperation.value), comment: form.comment.value }); }}><label>Punkty<input type="range" min={0} max={10} value={points} onChange={(event) => setPoints(Number(event.target.value))} /></label><div className="stepper"><Button type="button" onClick={() => setPoints(Math.max(0, points - 1))}>-</Button><strong>{points}</strong><Button type="button" onClick={() => setPoints(Math.min(10, points + 1))}>+</Button></div><label className="check"><input name="correct" type="checkbox" defaultChecked={score?.correct} /> Poprawna odpowiedź</label><label>Współpraca<select name="cooperation" defaultValue={score?.cooperation || 5}><option value="5">5 - świetna</option><option value="4">4 - dobra</option><option value="3">3 - OK</option><option value="2">2 - słaba</option><option value="1">1 - problem</option></select></label><label>Komentarz<textarea name="comment" defaultValue={score?.comment || ""} /></label><Button variant="primary">Zapisz ocenę</Button></form></Panel></div>;
}

function TeamsView({ state, onAdd }: { state: AppState; onAdd: () => void }) {
  return <Panel title="Drużyny" action={<Button variant="primary" onClick={onAdd}>Dodaj drużynę</Button>}><div className="team-grid">{state.teams.map((team) => <article className="team-card" key={team.id}><span className="avatar" style={{ background: team.color }}>{initials(team.name)}</span><div><h3>{team.name}</h3><p>{team.total_points} pkt · {team.finished_count}/{state.stations.length} stacji</p></div></article>)}</div></Panel>;
}

function ResourcesView({ state, setState }: { state: AppState; setState: (state: AppState) => void }) {
  async function submit(path: string, form: HTMLFormElement) { setState(await api<AppState>(path, { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) })); form.reset(); }
  return <div className="resource-grid"><Panel title="Kody QR stacji" className="wide"><div className="qr-grid">{state.stations.map((station) => <article className="qr-card" key={station.id}><strong>{station.title}</strong><QRCodeSVG value={`${location.origin}?qr=${station.qr_code}`} size={132} /><small>{station.qr_code}</small></article>)}</div></Panel><Panel title="Dodaj materiał"><form className="stack" onSubmit={(e) => { e.preventDefault(); submit("/api/materials", e.currentTarget); }}><label>Stacja<select name="station_id">{state.stations.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label><label>Tytuł<input name="title" required /></label><label>URL<input name="url" /></label><label>Notatki<textarea name="notes" /></label><Button variant="primary">Zapisz materiał</Button></form></Panel><Panel title="Dodaj pytanie"><form className="stack" onSubmit={(e) => { e.preventDefault(); submit("/api/questions", e.currentTarget); }}><label>Stacja<select name="station_id">{state.stations.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label><label>Pytanie<textarea name="question" required /></label><label>Odpowiedź<textarea name="answer" /></label><label>Maks. punktów<input name="max_points" type="number" defaultValue={10} /></label><Button variant="primary">Zapisz pytanie</Button></form></Panel></div>;
}

function SessionCard({ session, actions }: { session: Session; actions?: React.ReactNode }) {
  const pct = session.total ? Math.min(100, (session.attendance / session.total) * 100) : 0;
  return <article className="session-card"><div className="card-row"><strong>{session.title}</strong><span>{dateLabel(session.session_date)}</span></div><div className="mini-progress"><span style={{ width: `${pct}%` }} /></div><p>Obecność: <strong>{session.attendance}/{session.total}</strong> · {session.location}</p>{actions && <div className="button-row">{actions}</div>}</article>;
}

function PhotoTile({ photo, onOpen, onEdit, onShareInternal, onDelete }: { photo: Photo; onOpen?: (photo: Photo) => void; onEdit?: (photo: Photo) => void; onShareInternal?: (photo: Photo) => void; onDelete?: (id: number) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const tileRef = useRef<HTMLElement | null>(null);
  const showControls = !!onOpen || !!onEdit;
  useEffect(() => {
    if (!menuOpen && !infoOpen) return;
    const close = (event: PointerEvent) => {
      if (!tileRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
        setInfoOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setInfoOpen(false);
      }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen, infoOpen]);
  return <article ref={tileRef} className={"photo-tile " + (photo.image_data ? "has-image" : photo.color) + (menuOpen || infoOpen ? " menu-open" : "")}>
    <button className="photo-open" type="button" onClick={() => onOpen?.(photo)} disabled={!photo.image_data}>
      {photo.image_data ? <img src={photo.image_data} alt={photo.title} loading="lazy" decoding="async" /> : null}
      {!photo.image_data && <span>Brak zdjęcia</span>}
    </button>
    {showControls && <button className="photo-info-button" type="button" aria-label="Informacje o zdjęciu" onClick={() => { setInfoOpen(!infoOpen); setMenuOpen(false); }}>i</button>}
    {infoOpen && <div className="photo-info-menu">
      <strong>{photo.title}</strong>
      <span>{dateLabel(photo.created_at || photo.session_date)}</span>
      <span>{photo.session_title}</span>
      {photo.mime_type && <small>{photo.mime_type}</small>}
    </div>}
    {onEdit && <button className="photo-menu-button" type="button" aria-label="Opcje zdjęcia" onClick={() => { setMenuOpen(!menuOpen); setInfoOpen(false); }}>•••</button>}
    {onEdit && menuOpen && <div className="photo-actions-menu open">
      <button type="button" onClick={() => { setMenuOpen(false); onEdit(photo); }}>Edytuj</button>
      <button type="button" onClick={() => { setMenuOpen(false); sharePhoto(photo); }}>Kopiuj link</button>
      {onShareInternal && <button type="button" onClick={() => { setMenuOpen(false); onShareInternal(photo); }}>Udostępnij w hufcu</button>}
      {onDelete && <button className="danger" type="button" onClick={() => { setMenuOpen(false); onDelete(photo.id); }}>Usuń</button>}
    </div>}
  </article>;
}

function Ranking({ ranking }: { ranking: Team[] }) {
  return <ol className="ranking">{ranking.map((team, index) => <li key={team.id}><span>{index + 1}</span><strong>{team.name}</strong><b>{team.total_points} pkt</b></li>)}</ol>;
}

function WardDialog({ state, ward, onClose, onSaved, onDelete, runBusy }: { state: AppState; ward: Ward | null; onClose: () => void; onSaved: (state: AppState) => void; onDelete: (id: number) => void; runBusy: BusyRunner }) {
  return <Modal title={ward ? "Edytuj podopiecznego" : "Dodaj podopiecznego"} onClose={onClose}><form className="stack" onSubmit={async (event) => { event.preventDefault(); onSaved(await runBusy("Zapisywanie podopiecznego...", () => api<AppState>("/api/wards", { method: "POST", body: JSON.stringify({ ...Object.fromEntries(new FormData(event.currentTarget).entries()), game_id: state.game.id }) }))); }}><input type="hidden" name="id" defaultValue={ward?.id || ""} /><label>Imię i nazwisko<input name="name" defaultValue={ward?.name || ""} required /></label><label>Wiek<input name="age" type="number" defaultValue={ward?.age || 12} /></label><label>Rodzic / opiekun<input name="parent_name" defaultValue={ward?.parent_name || ""} /></label><label>Kontakt<input name="contact" defaultValue={ward?.contact || ""} /></label><label>Grupa<select name="cohort_id" defaultValue={ward?.cohort_id || ""}>{state.cohorts.map((cohort) => <option key={cohort.id} value={cohort.id}>{cohort.name}</option>)}</select></label><Button variant="primary">Zapisz</Button>{ward && <div className="danger-zone"><strong>Usunięcie podopiecznego</strong><p className="help">Ta akcja usunie osobę z listy i historii przypisań w panelu.</p><Button variant="danger" type="button" onClick={() => { if (window.confirm(`Usunąć podopiecznego ${ward.name}?`)) onDelete(ward.id); }}>Usuń podopiecznego</Button></div>}</form></Modal>;
}

function SessionDialog({ state, session, onClose, onSaved, runBusy }: { state: AppState; session: Session | null; onClose: () => void; onSaved: (state: AppState) => void; runBusy: BusyRunner }) {
  return <Modal title={session ? "Edytuj zbiórkę" : "Zaplanuj zbiórkę"} onClose={onClose}><form className="stack" onSubmit={async (event) => { event.preventDefault(); onSaved(await runBusy("Zapisywanie zbiórki...", () => api<AppState>("/api/sessions", { method: "POST", body: JSON.stringify({ ...Object.fromEntries(new FormData(event.currentTarget).entries()), game_id: state.game.id }) }))); }}><input type="hidden" name="id" defaultValue={session?.id || ""} /><label>Tytuł<input name="title" defaultValue={session?.title || ""} required /></label><label>Data<input name="session_date" type="date" defaultValue={session?.session_date ? String(session.session_date).slice(0, 10) : new Date().toISOString().slice(0, 10)} /></label><label>Lokalizacja<input name="location" defaultValue={session?.location || ""} /></label><label>Grupa<select name="cohort_id" defaultValue={session?.cohort_id || ""}><option value="">Cała grupa</option>{state.cohorts.map((cohort) => <option key={cohort.id} value={cohort.id}>{cohort.name}</option>)}</select></label><label>Widoczność<select name="scope" defaultValue={session?.scope || "grupa"}><option value="grupa">Cała grupa hufcowa</option><option value="moja">Mój osobisty kalendarz</option></select></label><label>Obecność<input name="attendance" type="number" defaultValue={session?.attendance || 0} /></label><label>Planowana liczba osób<input name="total" type="number" defaultValue={session?.total || 0} /></label><Button variant="primary">Zapisz</Button></form></Modal>;
}

function PhotoDialog({ state, photo, onClose, onSaved, runBusy }: { state: AppState; photo: Photo; onClose: () => void; onSaved: (state: AppState) => void; runBusy: BusyRunner }) {
  return <Modal title="Edytuj zdjęcie" onClose={onClose}><form className="stack" onSubmit={async (event) => { event.preventDefault(); onSaved(await runBusy("Zapisywanie zdjęcia...", () => api<AppState>("/api/photos", { method: "POST", body: JSON.stringify({ ...Object.fromEntries(new FormData(event.currentTarget).entries()), game_id: state.game.id }) }))); }}><input type="hidden" name="id" defaultValue={photo.id} /><label>Nazwa zdjęcia<input name="title" defaultValue={photo.title} required /></label>{photo.image_data && <img className="dialog-photo" src={photo.image_data} alt={photo.title} />}<Button variant="primary">Zapisz</Button></form></Modal>;
}

function AccountDialog({ user, initialTab, prefs, setPrefs, notifications, onClose, onSaved, onLogout }: { user: User; initialTab: "profil" | "wyglad" | "powiadomienia" | "konto"; prefs: AppPrefs; setPrefs: (prefs: AppPrefs) => void; notifications: NotificationItem[]; onClose: () => void; onSaved: (user: User) => void; onLogout: () => void }) {
  const [tab, setTab] = useState(initialTab);
  const tabButton = (id: typeof tab, label: string) => <button type="button" className={tab === id ? "settings-tab active" : "settings-tab"} onClick={() => setTab(id)}>{label}</button>;
  async function togglePush() {
    if (!prefs.push && "Notification" in window) {
      const permission = await Notification.requestPermission();
      if (permission === "granted") {
        setPrefs({ ...prefs, push: true });
        const first = notifications[0];
        new Notification(first?.title || "Powiadomienia Hufca włączone", { body: first?.detail || "Będziesz widzieć przypomnienia z panelu." });
      }
      return;
    }
    setPrefs({ ...prefs, push: !prefs.push });
  }
  const prefRow = (key: "email" | "push", label: string, desc: string, onClick?: () => void) => <div className="switch-row"><span><strong>{label}</strong><small>{desc}</small></span><button type="button" className={prefs[key] ? "switch on" : "switch"} onClick={onClick || (() => setPrefs({ ...prefs, [key]: !prefs[key] }))}><span /></button></div>;
  return <Modal title="Ustawienia" onClose={onClose}>
    <div className="settings-tabs">{tabButton("profil", "Profil")}{tabButton("wyglad", "Wygląd")}{tabButton("powiadomienia", "Powiadomienia")}{tabButton("konto", "Konto")}</div>
    {tab === "profil" && <form className="stack settings-pane" onSubmit={async (event) => { event.preventDefault(); const result = await api<{ ok: true; user: User }>("/api/profile", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget).entries())) }); onSaved(result.user); }}>
      <div className="profile-head"><span>{initials(user.name)}</span><div><strong>{user.name}</strong><small>{user.role}</small></div></div>
      <label>Imię i nazwisko<input name="name" defaultValue={user.name} required /></label>
      <label>E-mail<input name="email" type="email" defaultValue={user.email} required /></label>
      <Button variant="primary">Zapisz zmiany</Button>
    </form>}
    {tab === "wyglad" && <div className="settings-pane">
      <div><strong>Pasek boczny</strong><p className="help">Wybierz szerokość menu nawigacji. Zmiana działa od razu i zostaje po odświeżeniu.</p><div className="segmented"><button type="button" className={prefs.sidebar === "full" ? "active" : ""} onClick={() => setPrefs({ ...prefs, sidebar: "full" })}>Pełny</button><button type="button" className={prefs.sidebar === "compact" ? "active" : ""} onClick={() => setPrefs({ ...prefs, sidebar: "compact" })}>Zwinięty</button></div></div>
      <div><strong>Kolory systemu</strong><div className="swatches"><button type="button" className={prefs.theme === "forest" ? "active" : ""} onClick={() => setPrefs({ ...prefs, theme: "forest" })} /><button type="button" className={prefs.theme === "terra" ? "active" : ""} onClick={() => setPrefs({ ...prefs, theme: "terra" })} /><button type="button" className={prefs.theme === "cream" ? "active" : ""} onClick={() => setPrefs({ ...prefs, theme: "cream" })} /></div></div>
    </div>}
    {tab === "powiadomienia" && <div className="settings-pane">{prefRow("email", "E-mail", "Zgoda na wysyłkę podsumowań i przypomnień, gdy zostanie podpięty SMTP.")}{prefRow("push", "Powiadomienia push", "Powiadomienia przeglądarki na komputerze i telefonie po udzieleniu zgody.", togglePush)}<p className="help">Aktualnie panel generuje {notifications.length} powiadomień z danych systemu.</p></div>}
    {tab === "konto" && <div className="settings-pane"><label>Aktualne hasło<input type="password" /></label><label>Nowe hasło<input type="password" /></label><Button variant="primary">Zmień hasło</Button><div className="danger-zone"><Button variant="danger" onClick={onLogout}>Wyloguj się</Button></div></div>}
  </Modal>;
}

function ShareDialog({ state, photo, onClose, onSaved, runBusy }: { state: AppState; photo: Photo; onClose: () => void; onSaved: (state: AppState) => void; runBusy: BusyRunner }) {
  return <Modal title="Udostępnij w hufcu" onClose={onClose}><form className="stack" onSubmit={async (event) => { event.preventDefault(); onSaved(await runBusy("Udostępnianie zdjęcia...", () => api<AppState>("/api/internal-shares", { method: "POST", body: JSON.stringify({ ...Object.fromEntries(new FormData(event.currentTarget).entries()), photo_id: photo.id, game_id: state.game.id }) }))); }}><p className="help">{photo.title}</p><label>Odbiorcy<select name="target_type" defaultValue="hufiec"><option value="hufiec">Cały hufiec</option><option value="cohort">Wybrana grupa</option><option value="parents">Rodzice</option><option value="staff">Wychowawcy</option></select></label><label>Grupa, jeśli wybrano grupę<select name="target_id" defaultValue=""><option value="">Bez grupy</option>{state.cohorts.map((cohort) => <option key={cohort.id} value={cohort.id}>{cohort.name}</option>)}</select></label><label>Wiadomość<textarea name="note" placeholder="np. Zdjęcia z dzisiejszej zbiórki są już dostępne." /></label><Button variant="primary">Udostępnij</Button></form></Modal>;
}

type Conversation = { key: string; label: string; hint: string; target_type: string; target_id: number | null };

type ChatAttachment = { attachment_name: string; attachment_mime: string; attachment_data: string };
type MediaPreview = { src: string; title: string; mime?: string | null };

function MessagesView({ state, user, setState }: { state: AppState; user: User; setState: (state: AppState) => void }) {
  const [attachment, setAttachment] = useState<ChatAttachment | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [messageMenuId, setMessageMenuId] = useState<number | null>(null);
  const [preview, setPreview] = useState<MediaPreview | null>(null);
  const [mobileThreadOpen, setMobileThreadOpen] = useState(false);
  const bubbleListRef = useRef<HTMLDivElement | null>(null);
  const longPressRef = useRef<number | null>(null);
  const conversations: Conversation[] = [
    { key: "hufiec", label: "Cały hufiec", hint: "wszyscy wychowawcy i administrator", target_type: "hufiec", target_id: null },
    { key: "staff", label: "Wychowawcy", hint: "rozmowa kadry", target_type: "staff", target_id: null },
    { key: "parents", label: "Rodzice", hint: "komunikaty i pytania rodziców", target_type: "parents", target_id: null },
    ...state.cohorts.map((cohort) => ({ key: "cohort-" + cohort.id, label: cohort.name, hint: cohort.caretaker_user_name || cohort.caretaker || "grupa bez opiekuna", target_type: "cohort", target_id: cohort.id })),
    ...state.caregivers.filter((caregiver) => caregiver.id !== user.id).map((caregiver) => ({ key: "user-" + caregiver.id, label: caregiver.name, hint: caregiver.role, target_type: "user", target_id: caregiver.id }))
  ];
  const [activeKey, setActiveKey] = useState(conversations[0]?.key || "hufiec");
  const active = conversations.find((conversation) => conversation.key === activeKey) || conversations[0];
  function messageBelongsToConversation(message: Message, conversation: Conversation) {
    if (conversation.target_type === "user") {
      return message.target_type === "user"
        && ((Number(message.target_id) === Number(conversation.target_id) && message.sender_id === user.id)
          || (Number(message.target_id) === user.id && Number(message.sender_id) === Number(conversation.target_id)));
    }
    return message.target_type === conversation.target_type && (conversation.target_id == null || Number(message.target_id) === Number(conversation.target_id));
  }
  const thread = state.messages
    .filter((message) => messageBelongsToConversation(message, active))
    .slice()
    .reverse();
  const activeUnreadCount = active ? messageUnreadFor(state, active.target_type, active.target_id) : 0;

  useEffect(() => {
    const box = bubbleListRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [activeKey, thread.length]);

  useEffect(() => {
    if (!active || activeUnreadCount === 0) return;
    const timer = window.setTimeout(async () => {
      const next = await api<AppState>("/api/messages/read", {
        method: "POST",
        body: JSON.stringify({ target_type: active.target_type, target_id: active.target_id, game_id: state.game.id })
      });
      setState(next);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [activeKey, activeUnreadCount, active?.target_type, active?.target_id, state.game.id, setState]);

  useEffect(() => {
    setDraft("");
    setAttachment(null);
    setReplyTo(null);
    setEditingMessage(null);
    setMessageMenuId(null);
  }, [activeKey]);

  function clearLongPress() {
    if (longPressRef.current) window.clearTimeout(longPressRef.current);
    longPressRef.current = null;
  }

  function startReply(message: Message) {
    setReplyTo(message);
    setEditingMessage(null);
    setMessageMenuId(null);
  }

  function startEdit(message: Message) {
    setDraft(message.body || "");
    setEditingMessage(message);
    setReplyTo(null);
    setMessageMenuId(null);
  }

  function quoteText(message: Message | null) {
    if (!message) return "";
    return message.body || message.photo_title || message.attachment_name || "Załącznik";
  }

  function openMedia(src: string | null | undefined, title: string | null | undefined, mime?: string | null) {
    if (!src) return;
    setPreview({ src, title: title || "Podgląd", mime });
  }

  return <div className="messages-page">
    <div className="page-head"><div><h1>Wiadomości</h1><p className="help">Rozmowy z hufcem, grupami, rodzicami i konkretnymi wychowawcami.</p></div></div>
    <section className={"chat-shell " + (mobileThreadOpen ? "mobile-thread-open" : "mobile-list-open")}>
      <aside className="chat-list">
        <strong>Rozmowy</strong>
        {conversations.map((conversation) => {
          const count = messageUnreadFor(state, conversation.target_type, conversation.target_id);
          return <button key={conversation.key} className={"conversation-button " + (active.key === conversation.key ? "active" : "")} onClick={() => { setActiveKey(conversation.key); setMobileThreadOpen(true); }}>
            <span>{initials(conversation.label)}</span>
            <div><strong>{conversation.label}</strong><small>{conversation.hint}</small></div>
            {count > 0 && <em>{count}</em>}
          </button>;
        })}
      </aside>
      <section className="chat-thread">
        <div className="chat-head"><button className="chat-back" type="button" aria-label="Wróć do rozmów" onClick={() => setMobileThreadOpen(false)}>‹</button><div><h2>{active.label}</h2><span>{active.hint}</span></div></div>
        <div className="bubble-list" ref={bubbleListRef}>
          {thread.length === 0 && <div className="empty-chat">Nie ma jeszcze wiadomości w tej rozmowie.</div>}
          {thread.map((message) => {
            const mine = message.sender_id === user.id;
            const attachmentIsMedia = !!message.attachment_data && (!!message.attachment_mime?.startsWith("image/") || !!message.attachment_mime?.startsWith("video/"));
            return <article
              key={message.id}
              className={"message-bubble " + (mine ? "mine" : "")}
              onContextMenu={(event) => { event.preventDefault(); setMessageMenuId(message.id); }}
              onPointerDown={() => { clearLongPress(); longPressRef.current = window.setTimeout(() => setMessageMenuId(message.id), 520); }}
              onPointerUp={clearLongPress}
              onPointerLeave={clearLongPress}
            >
              <small>{message.sender_name || "System hufca"} · {dateLabel(message.created_at)}{message.edited_at && <em>edytowane *</em>}</small>
              {message.reply_to_id && <button className="message-quote" type="button">
                <span>{message.reply_sender_name || "Wiadomość"}</span>
                <strong>{message.reply_body || message.reply_photo_title || message.reply_attachment_name || "Załącznik"}</strong>
              </button>}
              {message.body && <p>{message.body}</p>}
              {message.photo_image_data && <button className="message-photo" type="button" onClick={() => openMedia(message.photo_image_data, message.photo_title || "Zdjęcie z galerii", message.photo_mime_type)}>
                <img src={message.photo_image_data} alt={message.photo_title || "Zdjęcie z galerii"} loading="lazy" decoding="async" />
                <strong>{message.photo_title || "Zdjęcie z galerii"}</strong>
              </button>}
              {!message.photo_image_data && message.photo_title && <span>Zdjęcie: {message.photo_title}</span>}
              {attachmentIsMedia && <button className="message-attachment" type="button" onClick={() => openMedia(message.attachment_data, message.attachment_name || "Załącznik", message.attachment_mime)}>
                {message.attachment_mime?.startsWith("image/") && <img src={message.attachment_data || ""} alt={message.attachment_name || "Załącznik"} loading="lazy" decoding="async" />}
                {message.attachment_mime?.startsWith("video/") && <video src={message.attachment_data || ""} muted playsInline preload="metadata" />}
                <strong>{message.attachment_name || "Załącznik"}</strong>
                <small>{message.attachment_mime || "plik"}</small>
              </button>}
              {message.attachment_data && !attachmentIsMedia && <a className="message-attachment" href={message.attachment_data} download={message.attachment_name || "zalacznik"}>
                <strong>{message.attachment_name || "Załącznik"}</strong>
                <small>{message.attachment_mime || "plik"}</small>
              </a>}
              {messageMenuId === message.id && <div className="message-actions-popover">
                <button type="button" onClick={() => startReply(message)}>Odpowiedz</button>
                {mine && message.body && <button type="button" onClick={() => startEdit(message)}>Edytuj</button>}
                <button type="button" onClick={() => setMessageMenuId(null)}>Zamknij</button>
              </div>}
            </article>;
          })}
        </div>
        <form className={"chat-compose " + (sending ? "sending" : "")} onSubmit={async (event) => {
          event.preventDefault();
          if (sending) return;
          const body = draft.trim();
          if (!body && !attachment) return;
          setSending(true);
          try {
            const path = editingMessage ? `/api/messages/${editingMessage.id}` : "/api/messages";
            setState(await api<AppState>(path, {
              method: "POST",
              body: JSON.stringify({
                body,
                target_type: active.target_type,
                target_id: active.target_id,
                game_id: state.game.id,
                reply_to_id: replyTo?.id || null,
                ...(editingMessage ? {} : attachment || {})
              })
            }));
            setDraft("");
            setAttachment(null);
            setReplyTo(null);
            setEditingMessage(null);
          } finally {
            setSending(false);
          }
        }}>
          <div className="compose-field">
            {(replyTo || editingMessage) && <div className="compose-context">
              <span>{editingMessage ? "Edytujesz wiadomość" : `Odpowiedź do: ${replyTo?.sender_name || "Wiadomość"}`}</span>
              <strong>{editingMessage ? editingMessage.body : quoteText(replyTo)}</strong>
              <button type="button" onClick={() => { setReplyTo(null); setEditingMessage(null); setDraft(editingMessage ? "" : draft); }}>×</button>
            </div>}
            <textarea name="body" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={editingMessage ? "Edytuj wiadomość" : "Napisz do: " + active.label} disabled={sending} />
            {sending && <div className="sending-status">{attachment ? "Wysyłanie pliku..." : "Wysyłanie wiadomości..."}</div>}
            {attachment && <div className="attachment-preview">
              {attachment.attachment_mime.startsWith("image/") && <img src={attachment.attachment_data} alt={attachment.attachment_name} />}
              <span><strong>{attachment.attachment_name}</strong><small>{attachment.attachment_mime || "plik"}</small></span>
              <button type="button" onClick={() => setAttachment(null)} disabled={sending}>Usuń</button>
            </div>}
          </div>
          <label className="attach-button">
            <input type="file" accept="image/*,video/*,.gif" disabled={sending || !!editingMessage} onChange={async (event) => { const file = event.currentTarget.files?.[0]; if (file) setAttachment(await fileToAttachment(file)); event.currentTarget.value = ""; }} />
            <UiIcon name="attach" />
            <span>Załącz</span>
          </label>
          <Button className="send-button" variant="primary" disabled={sending || (!draft.trim() && !attachment)}><UiIcon name="send" /><span>{sending ? "Wysyłanie" : "Wyślij"}</span></Button>
        </form>
      </section>
    </section>
    {preview && <MediaLightbox media={preview} onClose={() => setPreview(null)} />}
  </div>;
}

function MediaLightbox({ media, onClose }: { media: MediaPreview; onClose: () => void }) {
  const isVideo = media.mime?.startsWith("video/");
  return createPortal(<div className="lightbox media-lightbox" role="dialog" aria-modal="true" onClick={onClose}>
    <button className="lightbox-close" onClick={onClose}>Zamknij</button>
    <figure onClick={(event) => event.stopPropagation()}>
      {isVideo ? <video src={media.src} controls autoPlay /> : <img src={media.src} alt={media.title} decoding="async" />}
      <figcaption><strong>{media.title}</strong><span>{media.mime || "plik"}</span></figcaption>
    </figure>
  </div>, document.body);
}

function StaffView({ state, setState }: { state: AppState; setState: (state: AppState) => void }) {
  const [tab, setTab] = useState<"create" | "accounts" | "groups">("create");
  const [editingCaregiver, setEditingCaregiver] = useState<Caregiver | null>(null);
  async function saveCaregiver(form: HTMLFormElement, person: Caregiver) {
    const data = Object.fromEntries(new FormData(form).entries());
    if (!data.password) delete data.password;
    setState(await api<AppState>("/api/caregivers", { method: "POST", body: JSON.stringify({ ...data, id: person.id, game_id: state.game.id }) }));
    setEditingCaregiver(null);
  }
  return <div className="staff-page">
    <div className="page-head"><div><h1>Wychowawcy i grupy</h1><p className="help">Twórz konta wychowawców, przypisuj grupy i sprawdzaj, którzy podopieczni są pod czyją opieką.</p></div></div>
    <div className="admin-tabs"><button className={tab === "create" ? "active" : ""} onClick={() => setTab("create")}>Tworzenie</button><button className={tab === "accounts" ? "active" : ""} onClick={() => setTab("accounts")}>Konta wychowawców</button><button className={tab === "groups" ? "active" : ""} onClick={() => setTab("groups")}>Grupy i podopieczni</button></div>
    {tab === "create" && <div className="staff-create-grid">
      <Panel title="Dodaj wychowawcę" kicker="konto logowania"><form className="stack" onSubmit={async (event) => { event.preventDefault(); setState(await api<AppState>("/api/caregivers", { method: "POST", body: JSON.stringify({ ...Object.fromEntries(new FormData(event.currentTarget).entries()), game_id: state.game.id }) })); event.currentTarget.reset(); }}><label>Imię i nazwisko<input name="name" required /></label><label>E-mail<input name="email" type="email" required /></label><label>Hasło startowe<input name="password" type="text" placeholder="ustaw hasło dla konta" required /></label><label>Rola<select name="role" defaultValue="wychowawca"><option value="wychowawca">Wychowawca</option><option value="administrator">Administrator</option></select></label><label>Przypisz grupę<select name="cohort_id" defaultValue=""><option value="">Bez grupy</option>{state.cohorts.map((cohort) => <option key={cohort.id} value={cohort.id}>{cohort.name}</option>)}</select></label><Button variant="primary">Utwórz konto</Button></form></Panel>
      <Panel title="Nowa grupa" kicker="rocznik lub drużyna"><form className="stack" onSubmit={async (event) => { event.preventDefault(); setState(await api<AppState>("/api/cohorts", { method: "POST", body: JSON.stringify({ ...Object.fromEntries(new FormData(event.currentTarget).entries()), game_id: state.game.id }) })); event.currentTarget.reset(); }}><label>Nazwa grupy<input name="name" placeholder="np. Grupa 2025 albo Wilki" required /></label><label>Wychowawca<select name="caretaker_user_id" defaultValue=""><option value="">Bez opiekuna</option>{state.caregivers.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label><Button variant="primary">Dodaj grupę</Button></form></Panel>
    </div>}
    {tab === "accounts" && <div className="staff-manage-grid">
      <Panel title="Konta wychowawców"><div className="staff-list staff-list-wide">{state.caregivers.map((person) => <article className="staff-row" key={person.id}><span>{initials(person.name)}</span><div><strong>{person.name}</strong><small>{person.email} · {person.role}</small></div><em>{person.group_count} grup</em><Button onClick={() => setEditingCaregiver(person)}>Edytuj</Button></article>)}</div></Panel>
      {editingCaregiver && <Panel title="Edytuj konto" kicker="administrator">
        <form className="stack" onSubmit={(event) => { event.preventDefault(); saveCaregiver(event.currentTarget, editingCaregiver); }}>
          <label>Imię i nazwisko<input name="name" defaultValue={editingCaregiver.name} required /></label>
          <label>E-mail<input name="email" type="email" defaultValue={editingCaregiver.email} required /></label>
          <label>Rola<select name="role" defaultValue={editingCaregiver.role}><option value="wychowawca">Wychowawca</option><option value="administrator">Administrator</option></select></label>
          <label>Przypisz grupę<select name="cohort_id" defaultValue=""><option value="">Bez zmiany / bez grupy</option>{state.cohorts.map((cohort) => <option key={cohort.id} value={cohort.id}>{cohort.name}</option>)}</select></label>
          <label>Nowe hasło<input name="password" type="text" placeholder="zostaw puste, jeśli bez zmiany" /></label>
          <div className="button-row"><Button variant="primary">Zapisz konto</Button><Button type="button" onClick={() => setEditingCaregiver(null)}>Anuluj</Button></div>
        </form>
      </Panel>}
    </div>}
    {tab === "groups" && <Panel title="Grupy i podopieczni"><div className="group-list">{state.cohorts.map((cohort) => {
      const wards = state.wards.filter((ward) => ward.cohort_id === cohort.id);
      return <article className="group-card" key={cohort.id}><div><strong>{cohort.name}</strong><small>Wychowawca: {cohort.caretaker_user_name || "Bez opiekuna"}</small></div><form onSubmit={async (event) => { event.preventDefault(); setState(await api<AppState>("/api/cohorts", { method: "POST", body: JSON.stringify({ id: cohort.id, name: cohort.name, ...Object.fromEntries(new FormData(event.currentTarget).entries()), game_id: state.game.id }) })); }}><select name="caretaker_user_id" defaultValue={cohort.caretaker_user_id || ""}><option value="">Bez opiekuna</option>{state.caregivers.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select><Button>Zapisz</Button></form><Button variant="danger" onClick={async () => { if (window.confirm(`Usunąć grupę ${cohort.name}? Podopieczni zostaną bez przypisanej grupy.`)) setState(await api<AppState>(`/api/cohorts/${cohort.id}?gameId=${state.game.id}`, { method: "DELETE" })); }}>Usuń grupę</Button><p>{wards.length ? wards.map((ward) => ward.name).join(", ") : "Brak podopiecznych w tej grupie."}</p></article>;
    })}</div></Panel>}
  </div>;
}

function TeamDialog({ gameId, onClose, onSaved }: { gameId: number; onClose: () => void; onSaved: (state: AppState) => void }) {
  return <Modal title="Dodaj drużynę" onClose={onClose}><form className="stack" onSubmit={async (event) => { event.preventDefault(); onSaved(await api<AppState>("/api/teams", { method: "POST", body: JSON.stringify({ ...Object.fromEntries(new FormData(event.currentTarget).entries()), game_id: gameId }) })); }}><label>Nazwa<input name="name" placeholder="np. Wilki" required /></label><label>Kolor<input name="color" type="color" defaultValue="#1e5c46" /></label><Button variant="primary">Dodaj</Button></form></Modal>;
}

function TvDialog({ state, ranking, onClose }: { state: AppState; ranking: Team[]; onClose: () => void }) {
  return <div className="modal"><div className="tv"><Button onClick={onClose}>Zamknij</Button><div className="tv-timer">{secondsLabel(state.game.remaining_seconds)}</div><Ranking ranking={ranking} /></div></div>;
}

createRoot(document.getElementById("root")!).render(<App />);
