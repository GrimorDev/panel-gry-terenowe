const apiUrl = "api.php";

let state = null;
let selectedTeamId = null;
let selectedStationId = null;
let map = null;
let markers = [];
let qrScanner = null;
let localTimer = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;",
  }[char]));
}

function toast(message) {
  const box = $("#toast");
  box.textContent = message;
  box.classList.add("show");
  setTimeout(() => box.classList.remove("show"), 2600);
}

async function api(action = "state", options = {}) {
  const response = await fetch(`${apiUrl}?action=${encodeURIComponent(action)}`, options);
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || "Błąd API");
  return data;
}

async function post(action, payload) {
  return api(action, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function formatTimer(seconds) {
  const safe = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(safe / 60).toString().padStart(2, "0");
  const rest = Math.floor(safe % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
}

function initials(name) {
  return String(name).split(" ").filter(Boolean).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

function scoreFor(teamId, stationId) {
  return state.scores.find((score) => Number(score.team_id) === Number(teamId) && Number(score.station_id) === Number(stationId));
}

function stationStatus(stationId) {
  if (!selectedTeamId) return { color: "#cbd5d1", label: "brak drużyny" };
  const score = scoreFor(selectedTeamId, stationId);
  if (score?.finished_at) return { color: "#16a34a", label: "ukończona" };
  if (score?.started_at) return { color: "#f4b63d", label: "w trakcie" };
  return { color: "#cbd5d1", label: "nieodwiedzona" };
}

function getRanking() {
  return [...state.teams].sort((a, b) => Number(b.total_points) - Number(a.total_points) || a.name.localeCompare(b.name, "pl"));
}

function renderTimer() {
  const game = state.game;
  $("#timer").textContent = formatTimer(game.remaining_seconds);
  $("#tvTimer").textContent = formatTimer(game.remaining_seconds);
  $("#durationInput").value = game.duration_minutes;
  $("#gameMeta").textContent = `${game.duration_minutes} min · ${game.start_time.slice(0, 5)}`;
  $("#timerStatus").textContent = game.status === "running" ? "Odlicza" : game.status === "paused" ? "Pauza" : game.status === "finished" ? "Gra zakończona" : "Gotowa";
  const ratio = Number(game.remaining_seconds) / Math.max(1, Number(game.duration_minutes) * 60);
  $("#timerBar").style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  $("#timer").classList.toggle("warning", ratio <= .35 && ratio > .15);
  $("#timer").classList.toggle("danger", ratio <= .15);
}

function startLocalTimer() {
  clearInterval(localTimer);
  localTimer = setInterval(() => {
    if (!state?.game?.timer_running) return;
    state.game.remaining_seconds = Math.max(0, Number(state.game.remaining_seconds) - 1);
    if (state.game.remaining_seconds === 0) {
      state.game.timer_running = false;
      state.game.status = "finished";
      toast("Gra zakończona");
    }
    renderTimer();
  }, 1000);
}

function renderRanking() {
  const html = getRanking().map((team, index) => `
    <li>
      <span class="place">${index + 1}</span>
      <span>${esc(team.name)}</span>
      <span class="score">${Number(team.total_points)} pkt</span>
    </li>
  `).join("");
  $("#ranking").innerHTML = html || "<li>Brak drużyn</li>";
  $("#tvRanking").innerHTML = html;
  $("#teamCounter").textContent = `${state.teams.length} drużyn`;
}

function renderBadges() {
  const ranking = getRanking();
  const bestPoints = ranking[0];
  const bestCoop = [...state.teams].sort((a, b) => Number(b.avg_cooperation) - Number(a.avg_cooperation))[0];
  const bestCorrect = [...state.teams].sort((a, b) => Number(b.correct_count) - Number(a.correct_count))[0];
  $("#badges").innerHTML = [
    ["Najwięcej punktów", bestPoints?.name || "-"],
    ["Najlepsza współpraca", bestCoop?.name || "-"],
    ["Najwięcej poprawnych", bestCorrect?.name || "-"],
  ].map(([label, value]) => `<div class="badge"><strong>${esc(label)}</strong>${esc(value)}</div>`).join("");
}

function avatar(team) {
  if (team.avatar_path) return `<img class="avatar" src="${esc(team.avatar_path)}" alt="Avatar ${esc(team.name)}">`;
  return `<span class="avatar" style="--team-color:${esc(team.color)}">${esc(initials(team.name))}</span>`;
}

function renderTeams() {
  if (!selectedTeamId && state.teams[0]) selectedTeamId = Number(state.teams[0].id);
  $("#teamGrid").innerHTML = state.teams.map((team) => `
    <article class="team-card">
      ${avatar(team)}
      <div>
        <h3>${esc(team.name)}</h3>
        <div class="meta">
          <strong>${Number(team.total_points)} pkt</strong>
          <span>${Number(team.finished_count)} / ${state.stations.length} stacji</span>
        </div>
      </div>
    </article>
  `).join("");

  $("#teamChips").innerHTML = state.teams.map((team) => `
    <button class="chip ${Number(team.id) === Number(selectedTeamId) ? "active" : ""}" data-team="${team.id}">
      ${esc(team.name)}<br><small>${Number(team.total_points)} pkt</small>
    </button>
  `).join("");

  $$("[data-team]").forEach((button) => button.addEventListener("click", () => {
    selectedTeamId = Number(button.dataset.team);
    renderScoreView();
    renderMap();
  }));
}

function renderStations() {
  if (!selectedStationId && state.stations[0]) selectedStationId = Number(state.stations[0].id);
  $("#stationList").innerHTML = state.stations.map((station) => {
    const status = stationStatus(station.id);
    return `
      <button class="station-row ${Number(station.id) === Number(selectedStationId) ? "active" : ""}" data-station="${station.id}">
        <span>${esc(station.title)}<br><small>${esc(status.label)}</small></span>
        <span class="status-dot" style="--dot:${status.color}"></span>
      </button>
    `;
  }).join("");
  $$("[data-station]").forEach((button) => button.addEventListener("click", () => {
    selectedStationId = Number(button.dataset.station);
    renderScoreView();
  }));
}

function renderScoreView() {
  renderTeams();
  renderStations();
  const team = state.teams.find((item) => Number(item.id) === Number(selectedTeamId));
  const station = state.stations.find((item) => Number(item.id) === Number(selectedStationId));
  const score = team && station ? scoreFor(team.id, station.id) : null;
  $("#scoreTitle").textContent = team && station ? `${station.title} · ${team.name}` : "Ocena";
  $("#scoreHint").textContent = score?.finished_at ? "zapisana" : "nowa";
  const points = score ? Number(score.points) : 7;
  $("#points").value = points;
  $("#pointsOutput").value = points;
  $("#pointsBig").textContent = points;
  $("#correct").checked = score?.correct === true || score?.correct === "t";
  $("#cooperation").value = score?.cooperation ? String(score.cooperation) : "5";
  $("#comment").value = score?.comment || "";
}

function renderQrCards() {
  const base = state.app_url || window.location.origin + window.location.pathname;
  $("#qrGrid").innerHTML = state.stations.map((station) => {
    const url = `${base}?qr=${encodeURIComponent(station.qr_code)}`;
    return `
      <article class="qr-card">
        <strong>${esc(station.title)}</strong>
        <div class="qr-box" data-qr="${url}"></div>
        <span class="qr-code-text">${esc(station.qr_code)}</span>
        <div class="meta">
          <button class="secondary" data-edit-station="${station.id}">Edytuj</button>
          <button class="secondary" data-delete-station="${station.id}">Usuń</button>
        </div>
      </article>
    `;
  }).join("");

  if (window.QRCode) {
    $$(".qr-box").forEach((box) => {
      box.innerHTML = "";
      new QRCode(box, { text: box.dataset.qr, width: 124, height: 124 });
    });
  } else {
    $$(".qr-box").forEach((box) => box.textContent = box.dataset.qr);
  }

  $$("[data-edit-station]").forEach((button) => button.addEventListener("click", () => fillStationForm(Number(button.dataset.editStation))));
  $$("[data-delete-station]").forEach((button) => button.addEventListener("click", async () => {
    if (!confirm("Usunąć tę stację?")) return;
    state = await post("deleteStation", { game_id: state.game.id, id: Number(button.dataset.deleteStation) });
    renderAll();
    toast("Stacja usunięta");
  }));
}

function renderStationSelects() {
  const options = state.stations.map((station) => `<option value="${station.id}">${esc(station.title)}</option>`).join("");
  $$("[data-station-select]").forEach((select) => {
    const previous = select.value;
    select.innerHTML = options;
    if (previous) select.value = previous;
  });
}

function renderContentList() {
  const materials = (state.materials || []).map((material) => `
    <article class="content-card">
      <strong>Materiał: ${esc(material.title)}</strong>
      <p>${esc(material.station_title)}</p>
      ${material.url ? `<p><a href="${esc(material.url)}" target="_blank" rel="noreferrer">${esc(material.url)}</a></p>` : ""}
      ${material.notes ? `<p>${esc(material.notes)}</p>` : ""}
    </article>
  `);
  const questions = (state.questions || []).map((question) => `
    <article class="content-card">
      <strong>Pytanie: ${esc(question.station_title)}</strong>
      <p>${esc(question.question)}</p>
      ${question.answer ? `<p>Odpowiedź: ${esc(question.answer)}</p>` : ""}
      <p>${question.max_points} pkt</p>
    </article>
  `);
  $("#contentList").innerHTML = [...materials, ...questions].join("") || "<p>Brak materiałów i pytań.</p>";
}

function fillStationForm(id) {
  const station = state.stations.find((item) => Number(item.id) === id);
  if (!station) return;
  showView("admin");
  const form = $("#stationForm");
  form.elements.id.value = station.id;
  form.elements.title.value = station.title;
  form.elements.station_order.value = station.station_order;
  form.elements.lat.value = station.lat || "";
  form.elements.lng.value = station.lng || "";
}

function renderMap() {
  if (!window.L || !state?.stations?.length) return;
  if (!map) {
    map = L.map("map", { scrollWheelZoom: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap",
    }).addTo(map);
  }
  markers.forEach((marker) => marker.remove());
  markers = [];
  const points = state.stations.filter((station) => station.lat && station.lng);
  points.forEach((station) => {
    const status = stationStatus(station.id);
    const marker = L.circleMarker([Number(station.lat), Number(station.lng)], {
      radius: 10,
      color: status.color,
      fillColor: status.color,
      fillOpacity: .9,
    }).addTo(map);
    marker.bindPopup(`
      <strong>${esc(station.title)}</strong><br>
      ${esc(status.label)}<br>
      <button data-popup-station="${station.id}">Oceń tutaj</button>
    `);
    marker.on("popupopen", () => {
      setTimeout(() => {
        document.querySelector(`[data-popup-station="${station.id}"]`)?.addEventListener("click", () => {
          selectedStationId = Number(station.id);
          showView("score");
        });
      }, 0);
    });
    markers.push(marker);
  });
  fitMap();
}

function fitMap() {
  if (!map || !markers.length) return;
  map.fitBounds(L.featureGroup(markers).getBounds().pad(.25));
}

function renderAll() {
  $("#gameName").textContent = state.game.name;
  renderTimer();
  renderRanking();
  renderBadges();
  renderScoreView();
  renderQrCards();
  renderStationSelects();
  renderContentList();
  renderMap();
  startLocalTimer();
}

async function reloadState() {
  state = await api("state");
  if (!selectedTeamId && state.teams[0]) selectedTeamId = Number(state.teams[0].id);
  if (!selectedStationId && state.stations[0]) selectedStationId = Number(state.stations[0].id);
  renderAll();
}

function showView(id) {
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === id));
  $$(".nav").forEach((button) => button.classList.toggle("active", button.dataset.view === id));
  if (id === "mapView") setTimeout(() => { map?.invalidateSize(); fitMap(); }, 80);
}

async function handleQrCode(text) {
  const url = new URL(text, window.location.href);
  const code = url.searchParams.get("qr") || url.searchParams.get("station") || text.trim();
  const data = await api(`stationByQr&code=${encodeURIComponent(code)}`);
  selectedStationId = Number(data.station_id);
  if ($("#qrDialog").open) $("#qrDialog").close();
  stopQrScanner();
  showView("score");
  renderScoreView();
  toast("Otworzono stację z QR");
}

async function startQrScanner() {
  $("#qrDialog").showModal();
  if (!window.Html5Qrcode) {
    toast("Biblioteka QR nie wczytała się. Wpisz kod ręcznie.");
    return;
  }
  try {
    qrScanner = new Html5Qrcode("qrReader");
    await qrScanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 240, height: 240 } },
      (decodedText) => handleQrCode(decodedText).catch((error) => toast(error.message))
    );
  } catch (error) {
    toast("Kamera niedostępna. Sprawdź HTTPS albo wpisz kod ręcznie.");
  }
}

function stopQrScanner() {
  if (!qrScanner) return;
  qrScanner.stop().catch(() => {}).finally(() => { qrScanner = null; });
}

function bindEvents() {
  $$(".nav").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
  $("#quickScore").addEventListener("click", () => showView("score"));
  $("#quickTeam").addEventListener("click", () => $("#teamDialog").showModal());
  $("#quickStation").addEventListener("click", () => showView("admin"));
  $("#quickMap").addEventListener("click", () => showView("mapView"));
  $("#addTeamBtn").addEventListener("click", () => $("#teamDialog").showModal());
  $("#fitMap").addEventListener("click", fitMap);
  $("#tvBtn").addEventListener("click", () => $("#tvDialog").showModal());
  $("#scanQrBtn").addEventListener("click", startQrScanner);

  $$("[data-close]").forEach((button) => button.addEventListener("click", () => {
    document.getElementById(button.dataset.close).close();
    if (button.dataset.close === "qrDialog") stopQrScanner();
  }));

  $("#points").addEventListener("input", (event) => {
    $("#pointsOutput").value = event.target.value;
    $("#pointsBig").textContent = event.target.value;
  });
  $("#minusPoint").addEventListener("click", () => {
    $("#points").value = Math.max(0, Number($("#points").value) - 1);
    $("#points").dispatchEvent(new Event("input"));
  });
  $("#plusPoint").addEventListener("click", () => {
    $("#points").value = Math.min(10, Number($("#points").value) + 1);
    $("#points").dispatchEvent(new Event("input"));
  });

  $("#startTimer").addEventListener("click", async () => {
    state = await post("timer", { game_id: state.game.id, command: "start" });
    renderAll();
  });
  $("#pauseTimer").addEventListener("click", async () => {
    state = await post("timer", { game_id: state.game.id, command: "pause" });
    renderAll();
  });
  $("#resetTimer").addEventListener("click", async () => {
    state = await post("timer", { game_id: state.game.id, command: "reset" });
    renderAll();
  });
  $("#saveDuration").addEventListener("click", async () => {
    state = await post("timer", { game_id: state.game.id, command: "duration", duration_minutes: Number($("#durationInput").value) });
    renderAll();
    toast("Czas gry ustawiony");
  });

  $("#scoreForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    state = await post("score", {
      team_id: selectedTeamId,
      station_id: selectedStationId,
      points: Number($("#points").value),
      correct: $("#correct").checked,
      cooperation: Number($("#cooperation").value),
      comment: $("#comment").value,
    });
    renderAll();
    toast("Ocena zapisana");
  });

  $("#teamForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    form.append("game_id", state.game.id);
    const data = await api("team", { method: "POST", body: form });
    state = data;
    $("#teamDialog").close();
    event.currentTarget.reset();
    renderAll();
    toast("Drużyna dodana");
  });

  $("#gameForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    state = await post("game", Object.fromEntries(new FormData(form).entries()));
    selectedTeamId = null;
    selectedStationId = null;
    renderAll();
    showView("dashboard");
    toast("Nowa gra utworzona");
  });

  $("#stationForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    data.game_id = state.game.id;
    state = await post("station", data);
    event.currentTarget.reset();
    renderAll();
    toast("Stacja zapisana");
  });

  $("#materialForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    state = await post("material", Object.fromEntries(new FormData(event.currentTarget).entries()));
    event.currentTarget.reset();
    renderAll();
    toast("Materiał zapisany");
  });

  $("#questionForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    state = await post("question", Object.fromEntries(new FormData(event.currentTarget).entries()));
    event.currentTarget.reset();
    renderAll();
    toast("Pytanie zapisane");
  });

  $("#manualQr").addEventListener("submit", (event) => {
    event.preventDefault();
    const code = new FormData(event.currentTarget).get("code");
    handleQrCode(String(code)).catch((error) => toast(error.message));
  });
}

async function boot() {
  bindEvents();
  $("#gameForm").elements.game_date.valueAsDate = new Date();
  try {
    await reloadState();
    const params = new URLSearchParams(window.location.search);
    if (params.has("qr")) await handleQrCode(params.get("qr"));
    setInterval(reloadState, 15000);
  } catch (error) {
    toast(error.message);
    console.error(error);
  }
}

boot();
