import { API } from "../api/endpoints.js";
import { toastError, toastSuccess } from "../ui/toast.js";

function currentPath() {
  return (location.hash || "#/match").split("?")[0];
}

function setDisabled(btn, disabled, busyText) {
  if (!btn) return;
  btn.disabled = disabled;
  if (busyText) {
    if (!btn.dataset.origText) btn.dataset.origText = btn.textContent;
    btn.textContent = disabled ? busyText : btn.dataset.origText;
  }
}

function renderFromData(root, data) {
  const topScorers = (data.topScorers || []).slice(0, 10);
  const topAssists = (data.topAssists || []).slice(0, 10);
  const bestPlayers = (data.bestPlayers || []).slice(0, 10);

  root.innerHTML = `
    <div class="card">
      <div class="h1">Leaderboards</div>
      <div class="small">Tap Refresh to reload. (No background auto refresh.)</div>
      <div class="row" style="margin-top:10px">
        <button class="btn primary" id="refresh">Refresh</button>
      </div>
      <div class="small" id="msg" style="margin-top:8px"></div>
    </div>

    <div class="card">
      <div class="h1">Top Scorers</div>
      <ul class="list">
        ${topScorers.map(x => `<li><b>${x.playerName}</b> — ${x.goals}</li>`).join("") || "<li class='small'>No data</li>"}
      </ul>
    </div>

    <div class="card">
      <div class="h1">Top Assists</div>
      <ul class="list">
        ${topAssists.map(x => `<li><b>${x.playerName}</b> — ${x.assists}</li>`).join("") || "<li class='small'>No data</li>"}
      </ul>
    </div>

    <div class="card">
      <div class="h1">Best Players (Avg Rating)</div>
      <ul class="list" style="margin-top:8px">
        ${
          bestPlayers.length
            ? bestPlayers.map(x =>
                `<li><b>${x.playerName}</b> — ${Number(x.avgRating).toFixed(2)} <span class="small">(${x.matchesRated})</span></li>`
              ).join("")
            : "<li class='small'>No data</li>"
        }
      </ul>
    </div>
  `;
}

async function loadAndRender(root, routeAtStart, { toastOnSuccess } = { toastOnSuccess: false }) {
  const stillHere = () => currentPath() === routeAtStart;
  if (!stillHere()) return;

  const btn = root.querySelector("#refresh");
  const msg = root.querySelector("#msg");

  setDisabled(btn, true, "Refreshing…");
  if (msg) msg.textContent = "Loading…";

  const data = await API.leaderboard();

  if (!stillHere()) return;

  setDisabled(btn, false);
  if (!data.ok) {
    if (msg) msg.textContent = data.error || "Failed";
    toastError(data.error || "Failed to load leaderboard");
    return;
  }

  renderFromData(root, data);
  root.querySelector("#refresh").onclick = () => loadAndRender(root, routeAtStart, { toastOnSuccess: true });

  if (toastOnSuccess) toastSuccess("Leaderboards refreshed.");
}

export async function renderLeaderboardPage(root) {
  const routeAtStart = currentPath();

  root.innerHTML = `
    <div class="card">
      <div class="h1">Leaderboards</div>
      <div class="small">Loading…</div>
      <div class="row" style="margin-top:10px">
        <button class="btn primary" id="refresh" disabled>Refresh</button>
      </div>
      <div class="small" id="msg" style="margin-top:8px"></div>
    </div>
  `;

  await loadAndRender(root, routeAtStart, { toastOnSuccess: false });
}
