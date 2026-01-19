import { API } from "../api/endpoints.js";
import { toastError, toastSuccess, toastInfo } from "../ui/toast.js";

function currentPath() {
  return (location.hash || "#/match").split("?")[0];
}

function renderFromData(root, data) {
  const topScorers = (data.topScorers || []).slice(0, 10);
  const topAssists = (data.topAssists || []).slice(0, 10);
  const bestPlayers = (data.bestPlayers || []).slice(0, 10);

  root.innerHTML = `
    <div class="card">
      <div class="h1">Leaderboards</div>
      <div class="small">Refresh only when you want (no background auto reload).</div>
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
      <div class="small">Min 2 rating entries</div>
      <ul class="list" style="margin-top:8px">
        ${
          bestPlayers.map(x =>
            `<li><b>${x.playerName}</b> — ${Number(x.avgRating).toFixed(2)} <span class="small">(${x.matchesRated})</span></li>`
          ).join("") || "<li class='small'>No data</li>"
        }
      </ul>
    </div>
  `;
}

async function loadAndRender(root, routeAtStart, { showToast } = { showToast: false }) {
  const stillHere = () => currentPath() === routeAtStart;
  if (!stillHere()) return;

  const btn = root.querySelector("#refresh");
  const msg = root.querySelector("#msg");

  if (btn) btn.disabled = true;
  if (msg) msg.textContent = "Loading…";

  const data = await API.leaderboard();

  if (!stillHere()) return;

  if (btn) btn.disabled = false;

  if (!data.ok) {
    if (msg) msg.textContent = data.error || "Failed";
    toastError(data.error || "Failed to load leaderboard");
    return;
  }

  if (showToast) toastSuccess("Leaderboards refreshed.");
  else toastInfo("Leaderboards loaded.");

  renderFromData(root, data);

  // re-bind refresh after rerender
  root.querySelector("#refresh").onclick = () => loadAndRender(root, routeAtStart, { showToast: true });
}

export async function renderLeaderboardPage(root) {
  const routeAtStart = currentPath();

  // initial skeleton
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

  await loadAndRender(root, routeAtStart, { showToast: false });
}
