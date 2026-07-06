import "leaflet/dist/leaflet.css";
import "./styles.css";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
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
type Message = { id: number; sender_id: number | null; sender_name: string | null; target_type: string; target_id: number | null; cohort_name: string | null; body: string; photo_id: number | null; photo_title: string | null; created_at: string };
type AppState = { ok: true; game: Game; games: Game[]; teams: Team[]; stations: Station[]; scores: Score[]; materials: Material[]; questions: Question[]; cohorts: Cohort[]; wards: Ward[]; sessions: Session[]; photos: Photo[]; shares: InternalShare[]; messages: Message[]; caregivers: Caregiver[] };

const templates = ["Własna", "Polska", "Włochy", "Olimp"];
const navItems = [["dashboard", "Pulpit"], ["wards", "Podopieczni"], ["cohorts", "Roczniki"], ["sessions", "Zbiórki"], ["gallery", "Galeria"], ["messages", "Wiadomości"], ["staff", "Wychowawcy i grupy"], ["games", "Gry terenowe"]] as const;
const gameTabs = [["prepare", "Przygotowanie"], ["run", "Gra"], ["score", "Ocena"], ["teams", "Drużyny"], ["resources", "QR i materiały"]] as const;

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

function Button({ children, variant = "secondary", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" }) {
  return <button className={`btn btn-${variant}`} {...props}>{children}</button>;
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
  return <div className="modal">
    <div className="dialog">
      <div className="panel-head"><h2>{title}</h2><Button onClick={onClose}>Zamknij</Button></div>
      {children}
    </div>
  </div>;
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
  const [modal, setModal] = useState<null | "ward" | "session" | "team" | "photo" | "share" | "account" | "tv">(null);
  const [editingWard, setEditingWard] = useState<Ward | null>(null);
  const [editingSession, setEditingSession] = useState<Session | null>(null);
  const [editingPhoto, setEditingPhoto] = useState<Photo | null>(null);
  const [sharingPhoto, setSharingPhoto] = useState<Photo | null>(null);
  const mapEl = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const markers = useRef<L.LayerGroup | null>(null);

  const ranking = useMemo(() => [...(state?.teams || [])].sort((a, b) => b.total_points - a.total_points), [state]);
  const activeScore = state?.scores.find((score) => score.team_id === teamId && score.station_id === stationId) || null;

  async function load(gameId?: number) {
    const data = await api<AppState>(`/api/state${gameId ? `?gameId=${gameId}` : ""}`);
    setState(data);
    setTeamId((previous) => previous && data.teams.some((team) => team.id === previous) ? previous : data.teams[0]?.id || null);
    setStationId((previous) => previous && data.stations.some((station) => station.id === previous) ? previous : data.stations[0]?.id || null);
    return data;
  }

  function flash(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  }

  useEffect(() => {
    api<{ ok: true; user: User }>("/api/me")
      .then(async (result) => {
        setUser(result.user);
        await load();
        setAuth("ready");
      })
      .catch(() => setAuth("guest"));
  }, []);

  useEffect(() => {
    if (!state?.game.timer_running) return;
    const timer = window.setInterval(() => {
      setState((current) => current ? { ...current, game: { ...current.game, remaining_seconds: Math.max(0, current.game.remaining_seconds - 1) } } : current);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [state?.game.timer_running]);

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
        (form.elements.namedItem("title") as HTMLInputElement).focus();
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
    if (points.length) map.current.fitBounds(L.featureGroup(markers.current.getLayers()).getBounds().pad(0.18));
    else map.current.setView([52.22977, 21.01178], 15);
  }

  async function saveStation(payload: Partial<Station>) {
    if (!state) return;
    setState(await api<AppState>("/api/stations", { method: "POST", body: JSON.stringify({ ...payload, game_id: state.game.id }) }));
    flash("Stacja zapisana");
  }

  async function saveGame(form: HTMLFormElement) {
    const data = Object.fromEntries(new FormData(form).entries());
    setState(await api<AppState>("/api/games", { method: "POST", body: JSON.stringify({ ...data, use_template: form.use_template.checked }) }));
    flash(data.id ? "Gra zapisana" : "Nowa gra utworzona");
  }

  async function uploadPhotos(sessionId: number, files: File[]) {
    if (!state) return;
    let nextState = state;
    for (const file of files) {
      const image = await imageFileToDataUrl(file);
      nextState = await api<AppState>("/api/photos", {
        method: "POST",
        body: JSON.stringify({ session_id: sessionId, game_id: state.game.id, ...image })
      });
    }
    setState(nextState);
    flash(files.length === 1 ? "Zdjęcie zapisane w galerii" : "Zdjęcia zapisane w galerii");
  }

  if (auth === "checking") return <div className="loading">Ładowanie panelu...</div>;
  if (auth === "guest" || !user) return <Login onLogin={async (next) => { setUser(next); await load(); setAuth("ready"); }} />;
  if (!state) return <div className="loading">Ładowanie danych...</div>;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand-lock"><span className="brand-mark">H</span><span><strong>Hufc</strong><small>Panel wychowawcy</small></span></div>
      <nav>{navItems.filter(([id]) => user.role === "administrator" || id !== "staff").map(([id, label]) => <button key={id} className={`nav-item ${view === id ? "active" : ""}`} onClick={() => setView(id)}>{label}</button>)}</nav>
      <button className="user-chip" onClick={() => setModal("account")}>
        <span>{initials(user.name)}</span><strong>{user.name}</strong><small>{user.role}</small>
      </button>
    </aside>

    <main className="main full">
      {view === "dashboard" && <Dashboard state={state} user={user} setView={setView} />}
      {view === "wards" && <Wards state={state} onAdd={() => { setEditingWard(null); setModal("ward"); }} onEdit={(ward) => { setEditingWard(ward); setModal("ward"); }} onDelete={async (id) => setState(await api<AppState>(`/api/wards/${id}?gameId=${state.game.id}`, { method: "DELETE" }))} />}
      {view === "cohorts" && <Cohorts cohorts={state.cohorts} />}
      {view === "sessions" && <Sessions state={state} onAdd={() => { setEditingSession(null); setModal("session"); }} onEdit={(session) => { setEditingSession(session); setModal("session"); }} onDelete={async (id) => setState(await api<AppState>(`/api/sessions/${id}?gameId=${state.game.id}`, { method: "DELETE" }))} />}
      {view === "gallery" && <Gallery state={state} onAddGallery={() => { setEditingSession(null); setModal("session"); }} onUploadPhotos={uploadPhotos} onEditPhoto={(photo) => { setEditingPhoto(photo); setModal("photo"); }} onShareInternal={(photo) => { setSharingPhoto(photo); setModal("share"); }} onDeletePhoto={async (id) => setState(await api<AppState>(`/api/photos/${id}?gameId=${state.game.id}`, { method: "DELETE" }))} />}
      {view === "messages" && <MessagesView state={state} user={user} setState={setState} />}
      {view === "staff" && user.role === "administrator" && <StaffView state={state} setState={setState} />}
      {view === "games" && <GamesModule state={state} gameTab={gameTab} setGameTab={setGameTab} ranking={ranking} teamId={teamId} stationId={stationId} setTeamId={setTeamId} setStationId={setStationId} activeScore={activeScore} mapRef={mapEl} onSaveGame={saveGame} onSaveStation={saveStation} onAddTeam={() => setModal("team")} onDeleteStation={async (id) => setState(await api<AppState>(`/api/stations/${id}?gameId=${state.game.id}`, { method: "DELETE" }))} onTimer={async (command) => setState(await api<AppState>("/api/timer", { method: "POST", body: JSON.stringify({ game_id: state.game.id, command }) }))} onScore={async (payload) => { setState(await api<AppState>("/api/scores", { method: "POST", body: JSON.stringify(payload) })); flash("Ocena zapisana"); }} setState={setState} load={load} openTv={() => setModal("tv")} />}
    </main>

    {modal === "ward" && <WardDialog state={state} ward={editingWard} onClose={() => setModal(null)} onSaved={(next) => { setState(next); setModal(null); }} />}
    {modal === "session" && <SessionDialog state={state} session={editingSession} onClose={() => setModal(null)} onSaved={(next) => { setState(next); setModal(null); }} />}
    {modal === "photo" && editingPhoto && <PhotoDialog state={state} photo={editingPhoto} onClose={() => setModal(null)} onSaved={(next) => { setState(next); setModal(null); }} />}
    {modal === "share" && sharingPhoto && <ShareDialog state={state} photo={sharingPhoto} onClose={() => setModal(null)} onSaved={(next) => { setState(next); setModal(null); }} />}
    {modal === "account" && <AccountDialog user={user} onClose={() => setModal(null)} onSaved={(next) => { setUser(next); setModal(null); }} onLogout={() => api("/api/logout", { method: "POST" }).then(() => { setUser(null); setAuth("guest"); setModal(null); })} />}
    {modal === "team" && <TeamDialog gameId={state.game.id} onClose={() => setModal(null)} onSaved={(next) => { setState(next); setModal(null); }} />}
    {modal === "tv" && <TvDialog state={state} ranking={ranking} onClose={() => setModal(null)} />}
    {toast && <div className="toast">{toast}</div>}
  </div>;
}

function Dashboard({ state, user, setView }: { state: AppState; user: User; setView: (view: (typeof navItems)[number][0]) => void }) {
  const next = state.sessions[0];
  return <div>
    <span className="kicker">Witaj,</span><h1>{user.name}</h1>
    <div className="stat-grid">
      <Panel title="Podopieczni"><strong className="stat-number">{state.wards.length}</strong></Panel>
      <Panel title="Roczniki"><strong className="stat-number">{state.cohorts.length}</strong></Panel>
      <Panel title="Najbliższa zbiórka"><strong>{next ? dateLabel(next.session_date) : "Brak"}</strong></Panel>
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

function Wards({ state, onAdd, onEdit, onDelete }: { state: AppState; onAdd: () => void; onEdit: (ward: Ward) => void; onDelete: (id: number) => void }) {
  const [query, setQuery] = useState("");
  const rows = state.wards.filter((ward) => ward.name.toLowerCase().includes(query.toLowerCase()));
  return <div>
    <div className="page-head"><h1>Podopieczni</h1><Button variant="primary" onClick={onAdd}>Dodaj podopiecznego</Button></div>
    <label className="search">Szukaj<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Imię i nazwisko" /></label>
    <div className="rows">{rows.map((ward) => <article className="person-row" key={ward.id}><span>{initials(ward.name)}</span><div><strong>{ward.name}</strong><small>{ward.age} lat · rodzic: {ward.parent_name} · {ward.contact}</small></div><em>{ward.cohort_name}</em><Button onClick={() => onEdit(ward)}>Edytuj</Button><Button variant="danger" onClick={() => onDelete(ward.id)}>Usuń</Button></article>)}</div>
  </div>;
}

function Cohorts({ cohorts }: { cohorts: Cohort[] }) {
  return <div><h1>Roczniki</h1><div className="cohort-grid">{cohorts.map((cohort) => <Panel key={cohort.id} title={cohort.name} action={<span>{cohort.ward_count} osób</span>}><p>Opiekun: <strong>{cohort.caretaker}</strong></p></Panel>)}</div></div>;
}

function Sessions({ state, onAdd, onEdit, onDelete }: { state: AppState; onAdd: () => void; onEdit: (session: Session) => void; onDelete: (id: number) => void }) {
  const [filter, setFilter] = useState("all");
  const rows = state.sessions.filter((session) => filter === "all" || session.scope === filter);
  return <div>
    <div className="page-head"><h1>Zbiórki</h1><div className="button-row"><Button>Widok kalendarza</Button><Button variant="primary" onClick={onAdd}>Zaplanuj zbiórkę</Button></div></div>
    <div className="pill-row"><button className={filter === "all" ? "pill active" : "pill"} onClick={() => setFilter("all")}>Wszystkie</button><button className={filter === "grupa" ? "pill active" : "pill"} onClick={() => setFilter("grupa")}>Cała grupa hufcowa</button><button className={filter === "moja" ? "pill active" : "pill"} onClick={() => setFilter("moja")}>Mój osobisty kalendarz</button></div>
    <div className="session-grid">{rows.map((session) => <SessionCard key={session.id} session={session} actions={<><Button onClick={() => onEdit(session)}>Edytuj</Button><Button variant="danger" onClick={() => onDelete(session.id)}>Usuń</Button></>} />)}</div>
  </div>;
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

function GamesModule(props: { state: AppState; gameTab: string; setGameTab: (tab: any) => void; ranking: Team[]; teamId: number | null; stationId: number | null; setTeamId: (id: number) => void; setStationId: (id: number) => void; activeScore: Score | null; mapRef: React.RefObject<HTMLDivElement>; onSaveGame: (form: HTMLFormElement) => void; onSaveStation: (payload: Partial<Station>) => void; onAddTeam: () => void; onDeleteStation: (id: number) => void; onTimer: (command: "start" | "pause" | "reset") => void; onScore: (payload: { team_id: number | null; station_id: number | null; points: number; correct: boolean; cooperation: number; comment: string }) => void; setState: (state: AppState) => void; load: (gameId?: number) => void; openTv: () => void }) {
  const { state } = props;
  return <div>
    <div className="page-head">
      <div><span className="kicker">Gry terenowe</span><h1>{state.game.name}</h1></div>
      <div className="button-row"><label className="game-select">Gra<select value={state.game.id} onChange={(event) => props.load(Number(event.target.value))}>{state.games.map((game) => <option key={game.id} value={game.id}>{game.name}</option>)}</select></label><Button onClick={props.openTv} variant="primary">Ekran TV</Button></div>
    </div>
    <div className="pill-row">{gameTabs.map(([id, label]) => <button key={id} className={props.gameTab === id ? "pill active" : "pill"} onClick={() => props.setGameTab(id)}>{label}</button>)}</div>
    {props.gameTab === "prepare" && <GamePrepare {...props} />}
    {props.gameTab === "run" && <GameRun state={state} ranking={props.ranking} onTimer={props.onTimer} setGameTab={props.setGameTab} />}
    {props.gameTab === "score" && <ScoreView state={state} teamId={props.teamId} stationId={props.stationId} score={props.activeScore} setTeamId={props.setTeamId} setStationId={props.setStationId} onSave={props.onScore} />}
    {props.gameTab === "teams" && <TeamsView state={state} onAdd={props.onAddTeam} />}
    {props.gameTab === "resources" && <ResourcesView state={state} setState={props.setState} />}
  </div>;
}

function GamePrepare({ state, onSaveGame, onSaveStation, onAddTeam, onDeleteStation, mapRef }: any) {
  return <div className="flow">
    <Panel kicker="Krok 1" title="Ustaw grę"><form id="gameForm" className="form-grid" onSubmit={(event) => { event.preventDefault(); onSaveGame(event.currentTarget); }}><input name="id" type="hidden" defaultValue={state.game.id} /><label>Nazwa gry<input name="name" defaultValue={state.game.name} required /></label><label>Typ<select name="template" defaultValue={state.game.template}>{templates.map((item) => <option key={item}>{item}</option>)}</select></label><label>Data<input name="game_date" type="date" defaultValue={String(state.game.game_date).slice(0, 10)} /></label><label>Start<input name="start_time" type="time" defaultValue={String(state.game.start_time).slice(0, 5)} /></label><label>Czas minut<input name="duration_minutes" type="number" min={5} max={600} defaultValue={state.game.duration_minutes} /></label><label className="check"><input name="use_template" type="checkbox" /> Dodaj przykładowe stacje</label><div className="form-actions"><Button variant="primary" type="submit">Zapisz grę</Button></div></form></Panel>
    <Panel kicker="Krok 2" title="Stacje na mapie" action={<span>Kliknij mapę, aby wskazać punkt</span>}><div className="builder"><div ref={mapRef} className="map" /><div className="station-side"><form id="stationForm" className="stack" onSubmit={(event) => { event.preventDefault(); onSaveStation(Object.fromEntries(new FormData(event.currentTarget).entries())); event.currentTarget.reset(); }}><input name="id" type="hidden" /><label>Nazwa stacji<input name="title" placeholder="np. Most nad rzeką" required /></label><label>Kolejność<input name="station_order" type="number" min={1} defaultValue={state.stations.length + 1} /></label><label>Lat<input name="lat" type="number" step="0.000001" placeholder="kliknij mapę" /></label><label>Lng<input name="lng" type="number" step="0.000001" placeholder="kliknij mapę" /></label><Button variant="primary">Zapisz stację</Button></form><div className="station-list-admin">{state.stations.map((station: Station) => <article key={station.id} className="manage-row"><div><strong>{station.station_order}. {station.title}</strong><small>{station.lat ? `${Number(station.lat).toFixed(5)}, ${Number(station.lng).toFixed(5)}` : "bez punktu"}</small></div><Button onClick={() => fillStationForm(station)}>Edytuj</Button><Button variant="danger" onClick={() => onDeleteStation(station.id)}>Usuń</Button></article>)}</div></div></div></Panel>
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
  return <div className="score-grid"><Panel title="Drużyna">{state.teams.map((team: Team) => <button key={team.id} className={`choice ${team.id === teamId ? "active" : ""}`} onClick={() => setTeamId(team.id)}><strong>{team.name}</strong><small>{team.total_points} pkt</small></button>)}</Panel><Panel title="Stacja">{state.stations.map((station: Station) => <button key={station.id} className={`choice ${station.id === stationId ? "active" : ""}`} onClick={() => setStationId(station.id)}><strong>{station.title}</strong><small>{state.scores.some((s: Score) => s.team_id === teamId && s.station_id === station.id) ? "ukończona" : "nieodwiedzona"}</small></button>)}</Panel><Panel title={state.stations.find((s: Station) => s.id === stationId)?.title || "Ocena"}><form className="stack" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; onSave({ team_id: teamId, station_id: stationId, points, correct: form.correct.checked, cooperation: Number(form.cooperation.value), comment: form.comment.value }); }}><label>Punkty<input type="range" min={0} max={10} value={points} onChange={(event) => setPoints(Number(event.target.value))} /></label><div className="stepper"><Button type="button" onClick={() => setPoints(Math.max(0, points - 1))}>-</Button><strong>{points}</strong><Button type="button" onClick={() => setPoints(Math.min(10, points + 1))}>+</Button></div><label className="check"><input name="correct" type="checkbox" defaultChecked={score?.correct} /> Poprawna odpowiedź</label><label>Współpraca<select name="cooperation" defaultValue={score?.cooperation || 5}><option value="5">5 - świetna</option><option value="4">4 - dobra</option><option value="3">3 - OK</option><option value="2">2 - słaba</option><option value="1">1 - problem</option></select></label><label>Komentarz<textarea name="comment" defaultValue={score?.comment || ""} /></label><Button variant="primary">Zapisz ocenę</Button></form></Panel></div>;
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
  return <article className={"photo-tile " + (photo.image_data ? "has-image" : photo.color)}>
    <button className="photo-open" type="button" onClick={() => onOpen?.(photo)} disabled={!photo.image_data}>
      {photo.image_data ? <img src={photo.image_data} alt={photo.title} /> : null}
      {!photo.image_data && <span>Brak pliku zdjęcia</span>}
    </button>
    <div className="photo-meta">
      <strong>{photo.title}</strong>
      <small>{dateLabel(photo.created_at || photo.session_date)}</small>
      {onEdit && <div className="photo-actions">
        <Button onClick={() => onEdit(photo)}>Edytuj</Button>
        <Button onClick={() => sharePhoto(photo)}>Link</Button>
        {onShareInternal && <Button onClick={() => onShareInternal(photo)}>Do hufca</Button>}
        {onDelete && <Button variant="danger" onClick={() => onDelete(photo.id)}>Usuń</Button>}
      </div>}
    </div>
  </article>;
}

function Ranking({ ranking }: { ranking: Team[] }) {
  return <ol className="ranking">{ranking.map((team, index) => <li key={team.id}><span>{index + 1}</span><strong>{team.name}</strong><b>{team.total_points} pkt</b></li>)}</ol>;
}

function WardDialog({ state, ward, onClose, onSaved }: { state: AppState; ward: Ward | null; onClose: () => void; onSaved: (state: AppState) => void }) {
  return <Modal title={ward ? "Edytuj podopiecznego" : "Dodaj podopiecznego"} onClose={onClose}><form className="stack" onSubmit={async (event) => { event.preventDefault(); onSaved(await api<AppState>("/api/wards", { method: "POST", body: JSON.stringify({ ...Object.fromEntries(new FormData(event.currentTarget).entries()), game_id: state.game.id }) })); }}><input type="hidden" name="id" defaultValue={ward?.id || ""} /><label>Imię i nazwisko<input name="name" defaultValue={ward?.name || ""} required /></label><label>Wiek<input name="age" type="number" defaultValue={ward?.age || 12} /></label><label>Rodzic / opiekun<input name="parent_name" defaultValue={ward?.parent_name || ""} /></label><label>Kontakt<input name="contact" defaultValue={ward?.contact || ""} /></label><label>Rocznik<select name="cohort_id" defaultValue={ward?.cohort_id || ""}>{state.cohorts.map((cohort) => <option key={cohort.id} value={cohort.id}>{cohort.name}</option>)}</select></label><Button variant="primary">Zapisz</Button></form></Modal>;
}

function SessionDialog({ state, session, onClose, onSaved }: { state: AppState; session: Session | null; onClose: () => void; onSaved: (state: AppState) => void }) {
  return <Modal title={session ? "Edytuj zbiórkę" : "Zaplanuj zbiórkę"} onClose={onClose}><form className="stack" onSubmit={async (event) => { event.preventDefault(); onSaved(await api<AppState>("/api/sessions", { method: "POST", body: JSON.stringify({ ...Object.fromEntries(new FormData(event.currentTarget).entries()), game_id: state.game.id }) })); }}><input type="hidden" name="id" defaultValue={session?.id || ""} /><label>Tytuł<input name="title" defaultValue={session?.title || ""} required /></label><label>Data<input name="session_date" type="date" defaultValue={session?.session_date ? String(session.session_date).slice(0, 10) : new Date().toISOString().slice(0, 10)} /></label><label>Lokalizacja<input name="location" defaultValue={session?.location || ""} /></label><label>Rocznik<select name="cohort_id" defaultValue={session?.cohort_id || ""}><option value="">Cała grupa</option>{state.cohorts.map((cohort) => <option key={cohort.id} value={cohort.id}>{cohort.name}</option>)}</select></label><label>Widoczność<select name="scope" defaultValue={session?.scope || "grupa"}><option value="grupa">Cała grupa hufcowa</option><option value="moja">Mój osobisty kalendarz</option></select></label><label>Obecność<input name="attendance" type="number" defaultValue={session?.attendance || 0} /></label><label>Planowana liczba osób<input name="total" type="number" defaultValue={session?.total || 0} /></label><Button variant="primary">Zapisz</Button></form></Modal>;
}

function PhotoDialog({ state, photo, onClose, onSaved }: { state: AppState; photo: Photo; onClose: () => void; onSaved: (state: AppState) => void }) {
  return <Modal title="Edytuj zdjęcie" onClose={onClose}><form className="stack" onSubmit={async (event) => { event.preventDefault(); onSaved(await api<AppState>("/api/photos", { method: "POST", body: JSON.stringify({ ...Object.fromEntries(new FormData(event.currentTarget).entries()), game_id: state.game.id }) })); }}><input type="hidden" name="id" defaultValue={photo.id} /><label>Nazwa zdjęcia<input name="title" defaultValue={photo.title} required /></label>{photo.image_data && <img className="dialog-photo" src={photo.image_data} alt={photo.title} />}<Button variant="primary">Zapisz</Button></form></Modal>;
}

function AccountDialog({ user, onClose, onSaved, onLogout }: { user: User; onClose: () => void; onSaved: (user: User) => void; onLogout: () => void }) {
  return <Modal title="Konto" onClose={onClose}><form className="stack" onSubmit={async (event) => { event.preventDefault(); const result = await api<{ ok: true; user: User }>("/api/profile", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget).entries())) }); onSaved(result.user); }}><span className="kicker">{user.role}</span><label>Imię i nazwisko<input name="name" defaultValue={user.name} required /></label><label>E-mail<input name="email" type="email" defaultValue={user.email} required /></label><div className="form-actions"><Button variant="primary">Zapisz zmiany</Button></div></form><div className="danger-zone"><Button variant="danger" onClick={onLogout}>Wyloguj się</Button></div></Modal>;
}

function ShareDialog({ state, photo, onClose, onSaved }: { state: AppState; photo: Photo; onClose: () => void; onSaved: (state: AppState) => void }) {
  return <Modal title="Udostępnij w hufcu" onClose={onClose}><form className="stack" onSubmit={async (event) => { event.preventDefault(); onSaved(await api<AppState>("/api/internal-shares", { method: "POST", body: JSON.stringify({ ...Object.fromEntries(new FormData(event.currentTarget).entries()), photo_id: photo.id, game_id: state.game.id }) })); }}><p className="help">{photo.title}</p><label>Odbiorcy<select name="target_type" defaultValue="hufiec"><option value="hufiec">Cały hufiec</option><option value="cohort">Wybrany rocznik</option><option value="parents">Rodzice</option><option value="staff">Wychowawcy</option></select></label><label>Rocznik, jeśli wybrano rocznik<select name="target_id" defaultValue=""><option value="">Bez rocznika</option>{state.cohorts.map((cohort) => <option key={cohort.id} value={cohort.id}>{cohort.name}</option>)}</select></label><label>Wiadomość<textarea name="note" placeholder="np. Zdjęcia z dzisiejszej zbiórki są już dostępne." /></label><Button variant="primary">Udostępnij</Button></form></Modal>;
}

type Conversation = { key: string; label: string; hint: string; target_type: string; target_id: number | null };

function MessagesView({ state, user, setState }: { state: AppState; user: User; setState: (state: AppState) => void }) {
  const conversations: Conversation[] = [
    { key: "hufiec", label: "Cały hufiec", hint: "wszyscy wychowawcy i administrator", target_type: "hufiec", target_id: null },
    { key: "staff", label: "Wychowawcy", hint: "rozmowa kadry", target_type: "staff", target_id: null },
    { key: "parents", label: "Rodzice", hint: "komunikaty i pytania rodziców", target_type: "parents", target_id: null },
    ...state.cohorts.map((cohort) => ({ key: `cohort-${cohort.id}`, label: cohort.name, hint: cohort.caretaker_user_name || cohort.caretaker || "grupa bez opiekuna", target_type: "cohort", target_id: cohort.id })),
    ...state.caregivers.filter((caregiver) => caregiver.id !== user.id).map((caregiver) => ({ key: `user-${caregiver.id}`, label: caregiver.name, hint: caregiver.role, target_type: "user", target_id: caregiver.id }))
  ];
  const [activeKey, setActiveKey] = useState(conversations[0]?.key || "hufiec");
  const active = conversations.find((conversation) => conversation.key === activeKey) || conversations[0];
  const thread = state.messages
    .filter((message) => message.target_type === active.target_type && (active.target_id == null || Number(message.target_id) === Number(active.target_id)))
    .slice()
    .reverse();

  return <div>
    <div className="page-head"><div><h1>Wiadomości</h1><p className="help">Rozmowy z hufcem, grupami, rodzicami i konkretnymi wychowawcami.</p></div></div>
    <section className="chat-shell">
      <aside className="chat-list">
        <strong>Rozmowy</strong>
        {conversations.map((conversation) => {
          const count = state.messages.filter((message) => message.target_type === conversation.target_type && (conversation.target_id == null || Number(message.target_id) === Number(conversation.target_id))).length;
          return <button key={conversation.key} className={`conversation-button ${active.key === conversation.key ? "active" : ""}`} onClick={() => setActiveKey(conversation.key)}>
            <span>{initials(conversation.label)}</span>
            <div><strong>{conversation.label}</strong><small>{conversation.hint}</small></div>
            {count > 0 && <em>{count}</em>}
          </button>;
        })}
      </aside>
      <section className="chat-thread">
        <div className="chat-head"><div><h2>{active.label}</h2><span>{active.hint}</span></div></div>
        <div className="bubble-list">
          {thread.length === 0 && <div className="empty-chat">Nie ma jeszcze wiadomości w tej rozmowie.</div>}
          {thread.map((message) => <article key={message.id} className={`message-bubble ${message.sender_id === user.id ? "mine" : ""}`}>
            <small>{message.sender_name || "System hufca"} · {dateLabel(message.created_at)}</small>
            <p>{message.body}</p>
            {message.photo_title && <span>Zdjęcie: {message.photo_title}</span>}
          </article>)}
        </div>
        <form className="chat-compose" onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          setState(await api<AppState>("/api/messages", { method: "POST", body: JSON.stringify({ body: form.body.value, target_type: active.target_type, target_id: active.target_id, game_id: state.game.id }) }));
          form.reset();
        }}>
          <textarea name="body" placeholder={`Napisz do: ${active.label}`} required />
          <Button variant="primary">Wyślij</Button>
        </form>
      </section>
    </section>
  </div>;
}

function StaffView({ state, setState }: { state: AppState; setState: (state: AppState) => void }) {
  return <div>
    <div className="page-head"><div><h1>Wychowawcy i grupy</h1><p className="help">Twórz konta wychowawców, przypisuj grupy i sprawdzaj, którzy podopieczni są pod czyją opieką.</p></div></div>
    <div className="staff-grid">
      <Panel title="Dodaj wychowawcę" kicker="konto logowania">
        <form className="stack" onSubmit={async (event) => {
          event.preventDefault();
          setState(await api<AppState>("/api/caregivers", { method: "POST", body: JSON.stringify({ ...Object.fromEntries(new FormData(event.currentTarget).entries()), game_id: state.game.id }) }));
          event.currentTarget.reset();
        }}>
          <label>Imię i nazwisko<input name="name" required /></label>
          <label>E-mail<input name="email" type="email" required /></label>
          <label>Hasło startowe<input name="password" type="text" placeholder="ustaw hasło dla konta" required /></label>
          <label>Rola<select name="role" defaultValue="wychowawca"><option value="wychowawca">Wychowawca</option><option value="administrator">Administrator</option></select></label>
          <label>Przypisz grupę<select name="cohort_id" defaultValue=""><option value="">Bez grupy</option>{state.cohorts.map((cohort) => <option key={cohort.id} value={cohort.id}>{cohort.name}</option>)}</select></label>
          <Button variant="primary">Utwórz konto</Button>
        </form>
      </Panel>
      <Panel title="Nowa grupa" kicker="rocznik lub drużyna">
        <form className="stack" onSubmit={async (event) => {
          event.preventDefault();
          setState(await api<AppState>("/api/cohorts", { method: "POST", body: JSON.stringify({ ...Object.fromEntries(new FormData(event.currentTarget).entries()), game_id: state.game.id }) }));
          event.currentTarget.reset();
        }}>
          <label>Nazwa grupy<input name="name" placeholder="np. Rocznik 2016 albo Wilki" required /></label>
          <label>Wychowawca<select name="caretaker_user_id" defaultValue=""><option value="">Bez opiekuna</option>{state.caregivers.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
          <Button variant="primary">Dodaj grupę</Button>
        </form>
      </Panel>
      <Panel title="Konta wychowawców" className="wide">
        <div className="staff-list">{state.caregivers.map((person) => <article className="staff-row" key={person.id}><span>{initials(person.name)}</span><div><strong>{person.name}</strong><small>{person.email} · {person.role}</small></div><em>{person.group_count} grup</em></article>)}</div>
      </Panel>
      <Panel title="Grupy i podopieczni" className="wide">
        <div className="group-list">{state.cohorts.map((cohort) => {
          const wards = state.wards.filter((ward) => ward.cohort_id === cohort.id);
          return <article className="group-card" key={cohort.id}>
            <div><strong>{cohort.name}</strong><small>Wychowawca: {cohort.caretaker_user_name || cohort.caretaker}</small></div>
            <form onSubmit={async (event) => { event.preventDefault(); setState(await api<AppState>("/api/cohorts", { method: "POST", body: JSON.stringify({ id: cohort.id, name: cohort.name, ...Object.fromEntries(new FormData(event.currentTarget).entries()), game_id: state.game.id }) })); }}>
              <select name="caretaker_user_id" defaultValue={cohort.caretaker_user_id || ""}><option value="">Bez opiekuna</option>{state.caregivers.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select>
              <Button>Zapisz</Button>
            </form>
            <p>{wards.length ? wards.map((ward) => ward.name).join(", ") : "Brak podopiecznych w tej grupie."}</p>
          </article>;
        })}</div>
      </Panel>
    </div>
  </div>;
}

function TeamDialog({ gameId, onClose, onSaved }: { gameId: number; onClose: () => void; onSaved: (state: AppState) => void }) {
  return <Modal title="Dodaj drużynę" onClose={onClose}><form className="stack" onSubmit={async (event) => { event.preventDefault(); onSaved(await api<AppState>("/api/teams", { method: "POST", body: JSON.stringify({ ...Object.fromEntries(new FormData(event.currentTarget).entries()), game_id: gameId }) })); }}><label>Nazwa<input name="name" placeholder="np. Wilki" required /></label><label>Kolor<input name="color" type="color" defaultValue="#1e5c46" /></label><Button variant="primary">Dodaj</Button></form></Modal>;
}

function TvDialog({ state, ranking, onClose }: { state: AppState; ranking: Team[]; onClose: () => void }) {
  return <div className="modal"><div className="tv"><Button onClick={onClose}>Zamknij</Button><div className="tv-timer">{secondsLabel(state.game.remaining_seconds)}</div><Ranking ranking={ranking} /></div></div>;
}

createRoot(document.getElementById("root")!).render(<App />);
