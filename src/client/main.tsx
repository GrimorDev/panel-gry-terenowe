import "leaflet/dist/leaflet.css";
import "./styles.css";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import L from "leaflet";
import { QRCodeSVG } from "qrcode.react";

type User = { id: number; email: string; name: string; role: string };
type Game = { id: number; name: string; template: string; game_date: string; start_time: string; duration_minutes: number; remaining_seconds: number; timer_running: boolean; status: string; team_count?: number; station_count?: number };
type Team = { id: number; game_id: number; name: string; color: string; total_points: number; avg_cooperation: number; correct_count: number; finished_count: number };
type Station = { id: number; game_id: number; title: string; station_order: number; lat: string | null; lng: string | null; qr_code: string };
type Score = { team_id: number; station_id: number; points: number; correct: boolean; cooperation: number; comment: string; finished_at: string | null };
type Material = { id: number; station_id: number; station_title: string; title: string; url: string; notes: string };
type Question = { id: number; station_id: number; station_title: string; question: string; answer: string; max_points: number };
type AppState = { ok: true; game: Game; games: Game[]; teams: Team[]; stations: Station[]; scores: Score[]; materials: Material[]; questions: Question[] };

const templates = ["Własna", "Polska", "Włochy", "Olimp"];
const api = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(url, { headers: options?.body instanceof FormData ? undefined : { "Content-Type": "application/json" }, ...options });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || "Błąd serwera");
  return data;
};

function secondsLabel(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds || 0));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function initials(name: string) {
  return name.split(" ").filter(Boolean).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
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

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState("admin@hufc.local");
  const [password, setPassword] = useState("hufc1234");
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
      <h1>Panel wychowawcy — podopieczni, zbiórki i gry terenowe w jednym miejscu.</h1>
      <p>Narzędzie do prowadzenia pracy wychowawczej i gier terenowych bez papieru.</p>
      <small>© 2026 Hufc</small>
    </section>
    <section className="login-pane">
      <form className="login-card" onSubmit={submit}>
        <h2>Logowanie</h2>
        <p>Konto wychowawcy</p>
        <label>E-mail<input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required /></label>
        <label>Hasło<input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required /></label>
        {error && <div className="form-error">{error}</div>}
        <Button variant="primary" type="submit">Zaloguj się</Button>
        <small>Nie masz konta? Skontaktuj się z komendantem hufca.</small>
      </form>
    </section>
  </main>;
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [state, setState] = useState<AppState | null>(null);
  const [view, setView] = useState("setup");
  const [teamId, setTeamId] = useState<number | null>(null);
  const [stationId, setStationId] = useState<number | null>(null);
  const [toast, setToast] = useState("");
  const [teamDialog, setTeamDialog] = useState(false);
  const [tvOpen, setTvOpen] = useState(false);
  const mapEl = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const markerLayer = useRef<L.LayerGroup | null>(null);

  const ranking = useMemo(() => [...(state?.teams || [])].sort((a, b) => b.total_points - a.total_points), [state]);
  const activeTeam = state?.teams.find((team) => team.id === teamId) || null;
  const activeStation = state?.stations.find((station) => station.id === stationId) || null;
  const activeScore = state?.scores.find((score) => score.team_id === teamId && score.station_id === stationId) || null;

  function showToast(message: string) {
    setToast(message);
    setTimeout(() => setToast(""), 2400);
  }

  async function load(gameId?: number) {
    const query = gameId ? `?gameId=${gameId}` : "";
    const data = await api<AppState>(`/api/state${query}`);
    setState(data);
    setTeamId((previous) => previous && data.teams.some((team) => team.id === previous) ? previous : data.teams[0]?.id || null);
    setStationId((previous) => previous && data.stations.some((station) => station.id === previous) ? previous : data.stations[0]?.id || null);
  }

  useEffect(() => {
    api<{ ok: true; user: User }>("/api/me").then((result) => {
      setUser(result.user);
      return load();
    }).catch(() => setUser(null));
  }, []);

  useEffect(() => {
    if (!state?.game.timer_running) return;
    const timer = window.setInterval(() => {
      setState((current) => current ? { ...current, game: { ...current.game, remaining_seconds: Math.max(0, current.game.remaining_seconds - 1) } } : current);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [state?.game.timer_running]);

  useEffect(() => {
    if (!state || view !== "setup" || !mapEl.current) return;
    if (!map.current) {
      map.current = L.map(mapEl.current);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map.current);
      markerLayer.current = L.layerGroup().addTo(map.current);
      map.current.on("click", (event: L.LeafletMouseEvent) => {
        const form = document.querySelector<HTMLFormElement>("#stationForm");
        if (!form || !state) return;
        form.elements.namedItem("id") && ((form.elements.namedItem("id") as HTMLInputElement).value = "");
        (form.elements.namedItem("station_order") as HTMLInputElement).value = String(state.stations.length + 1);
        (form.elements.namedItem("lat") as HTMLInputElement).value = event.latlng.lat.toFixed(6);
        (form.elements.namedItem("lng") as HTMLInputElement).value = event.latlng.lng.toFixed(6);
        (form.elements.namedItem("title") as HTMLInputElement).focus();
        showToast("Miejsce stacji wybrane na mapie");
      });
    }
    setTimeout(() => map.current?.invalidateSize(), 80);
    renderMarkers();
  }, [state, view, teamId]);

  function renderMarkers() {
    if (!state || !map.current || !markerLayer.current) return;
    markerLayer.current.clearLayers();
    const points = state.stations.filter((station) => station.lat && station.lng);
    for (const station of points) {
      const status = stationStatus(station.id);
      const icon = L.divIcon({ className: "station-pin", html: `<span style="background:${status.color}"></span><strong>${station.station_order}</strong>`, iconSize: [34, 34], iconAnchor: [17, 17] });
      const marker = L.marker([Number(station.lat), Number(station.lng)], { draggable: true, icon }).addTo(markerLayer.current);
      marker.bindPopup(`<strong>${station.title}</strong><br>${status.label}`);
      marker.on("dragend", async () => {
        const point = marker.getLatLng();
        await saveStation({ ...station, lat: point.lat.toFixed(6), lng: point.lng.toFixed(6) });
      });
    }
    if (points.length) map.current.fitBounds(L.featureGroup(markerLayer.current.getLayers()).getBounds().pad(0.18));
    else map.current.setView([52.22977, 21.01178], 15);
  }

  function stationStatus(id: number) {
    if (!teamId) return { label: "brak drużyny", color: "var(--color-idle-dot)" };
    const score = state?.scores.find((item) => item.team_id === teamId && item.station_id === id);
    if (score?.finished_at) return { label: "ukończona", color: "var(--color-success)" };
    return { label: "nieodwiedzona", color: "var(--color-idle-dot)" };
  }

  async function saveGame(form: HTMLFormElement) {
    const data = Object.fromEntries(new FormData(form).entries());
    const result = await api<AppState>("/api/games", { method: "POST", body: JSON.stringify({ ...data, use_template: form.use_template.checked }) });
    setState(result);
    showToast(data.id ? "Gra zapisana" : "Nowa gra utworzona");
  }

  async function saveStation(payload: Partial<Station> & { game_id?: number }) {
    if (!state) return;
    const result = await api<AppState>("/api/stations", { method: "POST", body: JSON.stringify({ ...payload, game_id: state.game.id }) });
    setState(result);
    showToast("Stacja zapisana");
  }

  if (!user) return <Login onLogin={setUser} />;
  if (!state) return <div className="loading">Ładowanie panelu...</div>;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand-lock"><span className="brand-mark">H</span><span><strong>Hufc</strong><small>Panel wychowawcy</small></span></div>
      <nav>
        {[["setup", "Przygotuj grę"], ["run", "Prowadź grę"], ["score", "Ocena stacji"], ["teams", "Drużyny"], ["resources", "Materiały"]].map(([id, label]) =>
          <button key={id} className={`nav-item ${view === id ? "active" : ""}`} onClick={() => setView(id)}>{label}</button>
        )}
      </nav>
      <button className="user-chip" onClick={() => api("/api/logout", { method: "POST" }).then(() => setUser(null))}>
        <span>{initials(user.name)}</span><strong>{user.name}</strong><small>Wyloguj się</small>
      </button>
    </aside>

    <main className="main">
      <header className="topbar">
        <div><span className="kicker">Wybrana gra</span><h1>{state.game.name}</h1></div>
        <div className="top-actions">
          <label className="field compact">Gra<select value={state.game.id} onChange={(event) => load(Number(event.target.value))}>{state.games.map((game) => <option key={game.id} value={game.id}>{game.name} ({game.team_count || 0} druż., {game.station_count || 0} st.)</option>)}</select></label>
          <Button onClick={() => setView("score")}>Skanuj QR</Button>
          <Button variant="primary" onClick={() => setTvOpen(true)}>Ekran TV</Button>
        </div>
      </header>

      {view === "setup" && <SetupView state={state} onSaveGame={saveGame} onSaveStation={saveStation} onAddTeam={() => setTeamDialog(true)} onDeleteGame={async () => {
        if (!confirm("Usunąć całą grę?")) return;
        const result = await api<AppState>(`/api/games/${state.game.id}`, { method: "DELETE" });
        setState(result);
      }} onDeleteStation={async (id: number) => {
        const result = await api<AppState>(`/api/stations/${id}?gameId=${state.game.id}`, { method: "DELETE" });
        setState(result);
      }} mapRef={mapEl} />}

      {view === "run" && <RunView state={state} ranking={ranking} onTimer={async (command: "start" | "pause" | "reset") => setState(await api<AppState>("/api/timer", { method: "POST", body: JSON.stringify({ game_id: state.game.id, command }) }))} setView={setView} />}
      {view === "score" && <ScoreView state={state} teamId={teamId} stationId={stationId} score={activeScore} setTeamId={setTeamId} setStationId={setStationId} onSave={async (payload: { team_id: number | null; station_id: number | null; points: number; correct: boolean; cooperation: number; comment: string }) => {
        const result = await api<AppState>("/api/scores", { method: "POST", body: JSON.stringify(payload) });
        setState(result);
        showToast("Ocena zapisana");
      }} />}
      {view === "teams" && <TeamsView state={state} onAdd={() => setTeamDialog(true)} />}
      {view === "resources" && <ResourcesView state={state} setState={setState} />}
    </main>

    {teamDialog && <TeamDialog gameId={state.game.id} onClose={() => setTeamDialog(false)} onSaved={(next) => { setState(next); setTeamDialog(false); showToast("Drużyna dodana"); }} />}
    {tvOpen && <TvDialog state={state} ranking={ranking} onClose={() => setTvOpen(false)} />}
    {toast && <div className="toast">{toast}</div>}
  </div>;
}

function SetupView({ state, onSaveGame, onSaveStation, onAddTeam, onDeleteGame, onDeleteStation, mapRef }: any) {
  return <div className="flow">
    <Panel kicker="Krok 1" title="Ustaw grę" action={<Button onClick={() => { const form = document.querySelector<HTMLFormElement>("#gameForm"); form?.reset(); if (form) (form.elements.namedItem("id") as HTMLInputElement).value = ""; }}>Nowa gra</Button>}>
      <form id="gameForm" className="form-grid" onSubmit={(event) => { event.preventDefault(); onSaveGame(event.currentTarget); }}>
        <input name="id" type="hidden" defaultValue={state.game.id} />
        <label>Nazwa gry<input name="name" defaultValue={state.game.name} required /></label>
        <label>Typ<select name="template" defaultValue={state.game.template}>{templates.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>Data<input name="game_date" type="date" defaultValue={String(state.game.game_date).slice(0, 10)} /></label>
        <label>Start<input name="start_time" type="time" defaultValue={String(state.game.start_time).slice(0, 5)} /></label>
        <label>Czas minut<input name="duration_minutes" type="number" min={5} max={600} defaultValue={state.game.duration_minutes} /></label>
        <label className="check"><input name="use_template" type="checkbox" /> Dodaj przykładowe stacje</label>
        <div className="form-actions"><Button variant="primary" type="submit">Zapisz grę</Button><Button variant="danger" type="button" onClick={onDeleteGame}>Usuń grę</Button></div>
      </form>
    </Panel>

    <Panel kicker="Krok 2" title="Dodaj stacje na mapie" action={<span>Kliknij mapę, wpisz nazwę, zapisz</span>}>
      <div className="builder">
        <div ref={mapRef} className="map" />
        <div className="station-side">
          <form id="stationForm" className="stack" onSubmit={(event) => {
            event.preventDefault();
            const data = Object.fromEntries(new FormData(event.currentTarget).entries());
            onSaveStation(data);
            event.currentTarget.reset();
          }}>
            <input name="id" type="hidden" />
            <label>Nazwa stacji<input name="title" placeholder="np. Most nad rzeką" required /></label>
            <label>Kolejność<input name="station_order" type="number" min={1} defaultValue={state.stations.length + 1} /></label>
            <label>Lat<input name="lat" type="number" step="0.000001" placeholder="kliknij mapę" /></label>
            <label>Lng<input name="lng" type="number" step="0.000001" placeholder="kliknij mapę" /></label>
            <Button variant="primary" type="submit">Zapisz stację</Button>
          </form>
          <div className="station-list-admin">{state.stations.length ? state.stations.map((station: Station) => <article key={station.id} className="manage-row">
            <div><strong>{station.station_order}. {station.title}</strong><small>{station.lat ? `${Number(station.lat).toFixed(5)}, ${Number(station.lng).toFixed(5)}` : "bez punktu"}</small></div>
            <Button onClick={() => {
              const form = document.querySelector<HTMLFormElement>("#stationForm");
              if (!form) return;
              (form.elements.namedItem("id") as HTMLInputElement).value = String(station.id);
              (form.elements.namedItem("title") as HTMLInputElement).value = station.title;
              (form.elements.namedItem("station_order") as HTMLInputElement).value = String(station.station_order);
              (form.elements.namedItem("lat") as HTMLInputElement).value = station.lat || "";
              (form.elements.namedItem("lng") as HTMLInputElement).value = station.lng || "";
            }}>Edytuj</Button>
            <Button variant="danger" onClick={() => onDeleteStation(station.id)}>Usuń</Button>
          </article>) : <p className="empty">Nie ma jeszcze stacji.</p>}</div>
        </div>
      </div>
    </Panel>

    <Panel kicker="Krok 3" title="Dodaj drużyny" action={<Button variant="primary" onClick={onAddTeam}>Dodaj drużynę</Button>}>
      <div className="mini-grid">{state.teams.length ? state.teams.map((team: Team) => <div className="mini-row" key={team.id}><span style={{ background: team.color }} /><strong>{team.name}</strong><small>{team.total_points} pkt</small></div>) : <p className="empty">Dodaj drużyny przed startem gry.</p>}</div>
    </Panel>
  </div>;
}

function RunView({ state, ranking, onTimer, setView }: any) {
  const ratio = state.game.remaining_seconds / Math.max(1, state.game.duration_minutes * 60);
  return <div className="run-grid">
    <Panel kicker="Timer gry" title={state.game.timer_running ? "Odlicza" : "Gotowa"} action={<span>{state.game.duration_minutes} min</span>} className="timer-panel">
      <div className={`timer ${ratio < .15 ? "danger" : ratio < .35 ? "warning" : ""}`}>{secondsLabel(state.game.remaining_seconds)}</div>
      <div className="progress"><span style={{ width: `${Math.max(0, Math.min(1, ratio)) * 100}%` }} /></div>
      <div className="button-row"><Button variant="primary" onClick={() => onTimer("start")}>Start</Button><Button onClick={() => onTimer("pause")}>Pauza</Button><Button onClick={() => onTimer("reset")}>Reset</Button></div>
    </Panel>
    <Panel title="Ranking live" action={<span>{state.teams.length} drużyn</span>}><Ranking ranking={ranking} /></Panel>
    <Panel title="Szybkie akcje"><div className="action-grid"><Button onClick={() => setView("score")}>Oceń stację</Button><Button onClick={() => setView("teams")}>Drużyny</Button><Button onClick={() => setView("setup")}>Stacje na mapie</Button><Button onClick={() => setView("resources")}>QR i materiały</Button></div></Panel>
  </div>;
}

function ScoreView({ state, teamId, stationId, score, setTeamId, setStationId, onSave }: any) {
  const [points, setPoints] = useState(score?.points || 7);
  useEffect(() => setPoints(score?.points || 7), [score?.points, teamId, stationId]);
  return <div className="score-grid">
    <Panel title="Drużyna">{state.teams.map((team: Team) => <button key={team.id} className={`choice ${team.id === teamId ? "active" : ""}`} onClick={() => setTeamId(team.id)}><strong>{team.name}</strong><small>{team.total_points} pkt</small></button>)}</Panel>
    <Panel title="Stacja">{state.stations.map((station: Station) => <button key={station.id} className={`choice ${station.id === stationId ? "active" : ""}`} onClick={() => setStationId(station.id)}><strong>{station.title}</strong><small>{state.scores.some((s: Score) => s.team_id === teamId && s.station_id === station.id) ? "ukończona" : "nieodwiedzona"}</small></button>)}</Panel>
    <Panel title={state.stations.find((s: Station) => s.id === stationId)?.title || "Ocena"} action={<span>{state.teams.find((t: Team) => t.id === teamId)?.name}</span>}>
      <form className="stack" onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        onSave({ team_id: teamId, station_id: stationId, points, correct: form.correct.checked, cooperation: Number(form.cooperation.value), comment: form.comment.value });
      }}>
        <label>Punkty<input type="range" min={0} max={10} value={points} onChange={(event) => setPoints(Number(event.target.value))} /></label>
        <div className="stepper"><Button type="button" onClick={() => setPoints(Math.max(0, points - 1))}>-</Button><strong>{points}</strong><Button type="button" onClick={() => setPoints(Math.min(10, points + 1))}>+</Button></div>
        <label className="check"><input name="correct" type="checkbox" defaultChecked={score?.correct} /> Poprawna odpowiedź</label>
        <label>Współpraca<select name="cooperation" defaultValue={score?.cooperation || 5}><option value="5">5 - świetna</option><option value="4">4 - dobra</option><option value="3">3 - OK</option><option value="2">2 - słaba</option><option value="1">1 - problem</option></select></label>
        <label>Komentarz<textarea name="comment" defaultValue={score?.comment || ""} /></label>
        <Button variant="primary" type="submit">Zapisz ocenę</Button>
      </form>
    </Panel>
  </div>;
}

function TeamsView({ state, onAdd }: any) {
  return <Panel title="Drużyny" action={<Button variant="primary" onClick={onAdd}>Dodaj drużynę</Button>}>
    <div className="team-grid">{state.teams.map((team: Team) => <article className="team-card" key={team.id}><span className="avatar" style={{ background: team.color }}>{initials(team.name)}</span><div><h3>{team.name}</h3><p>{team.total_points} pkt · {team.finished_count}/{state.stations.length} stacji</p></div></article>)}</div>
  </Panel>;
}

function ResourcesView({ state, setState }: any) {
  async function submit(path: string, form: HTMLFormElement) {
    const result = await api<AppState>(path, { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
    setState(result);
    form.reset();
  }
  return <div className="resource-grid">
    <Panel title="Kody QR stacji" className="wide"><div className="qr-grid">{state.stations.map((station: Station) => <article className="qr-card" key={station.id}><strong>{station.title}</strong><QRCodeSVG value={`${location.origin}?qr=${station.qr_code}`} size={132} /><small>{station.qr_code}</small></article>)}</div></Panel>
    <Panel title="Dodaj materiał"><form className="stack" onSubmit={(e) => { e.preventDefault(); submit("/api/materials", e.currentTarget); }}><label>Stacja<select name="station_id">{state.stations.map((s: Station) => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label><label>Tytuł<input name="title" required /></label><label>URL<input name="url" /></label><label>Notatki<textarea name="notes" /></label><Button variant="primary">Zapisz materiał</Button></form></Panel>
    <Panel title="Dodaj pytanie"><form className="stack" onSubmit={(e) => { e.preventDefault(); submit("/api/questions", e.currentTarget); }}><label>Stacja<select name="station_id">{state.stations.map((s: Station) => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label><label>Pytanie<textarea name="question" required /></label><label>Odpowiedź<textarea name="answer" /></label><label>Maks. punktów<input name="max_points" type="number" defaultValue={10} /></label><Button variant="primary">Zapisz pytanie</Button></form></Panel>
  </div>;
}

function Ranking({ ranking }: { ranking: Team[] }) {
  return <ol className="ranking">{ranking.map((team, index) => <li key={team.id}><span>{index + 1}</span><strong>{team.name}</strong><b>{team.total_points} pkt</b></li>)}</ol>;
}

function TeamDialog({ gameId, onClose, onSaved }: { gameId: number; onClose: () => void; onSaved: (state: AppState) => void }) {
  return <div className="modal"><form className="dialog stack" onSubmit={async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget).entries()); onSaved(await api<AppState>("/api/teams", { method: "POST", body: JSON.stringify({ ...data, game_id: gameId }) })); }}><div className="panel-head"><h2>Dodaj drużynę</h2><Button type="button" onClick={onClose}>Zamknij</Button></div><label>Nazwa<input name="name" placeholder="np. Wilki" required /></label><label>Kolor<input name="color" type="color" defaultValue="#1e5c46" /></label><Button variant="primary">Dodaj</Button></form></div>;
}

function TvDialog({ state, ranking, onClose }: any) {
  return <div className="modal"><div className="tv"><Button onClick={onClose}>Zamknij</Button><div className="tv-timer">{secondsLabel(state.game.remaining_seconds)}</div><Ranking ranking={ranking} /></div></div>;
}

createRoot(document.getElementById("root")!).render(<App />);
