import { API } from "../api/endpoints.js";
import { toastError, toastSuccess, toastInfo } from "../ui/toast.js";
import { cleanupCaches } from "../cache_cleanup.js";

const LS_LEADERBOARD_KEY = "mlfc_leaderboard_cache_v1";
// You said “manual refresh”; keep cache long.
const LEADERBOARD_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function currentPath() {
  return (location.hash || "#/match").split("?")[0];
}

function lsGet(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}
function lsDel(key) {
  try { localStorage.removeItem(key); } catch {}
}
function isFresh(entry, ttlMs) {
  if (!entry?.ts) return false;
  return (Date.now() - entry.ts) <= ttlMs;
}

function renderFromData(root, data, { cacheNote = "" } = {}) {
  const topScorers = (data.topScorers || []).slice(0, 10);
  const topAssists = (data.topAssists || []).slice(0, 10);
  const bestPlayers = (data.bestPlayers || []).slice(0, 10); // show even if 1 rating

  root.innerHTML = `
    <div class="card">
      <div class="h1">Leaderboards</div>
      <div class="small">Cached on your device. Tap Refresh when you want.</div>
      ${cacheNote ? `<div class="small" style="margin-top:6px">${cacheNote}</div>` : ""}
      <div class="row" style="margin-top:10px">
        <button class="btn primary" id="refresh">Refresh</button>
        <button class="btn gray" id="clearCache">Clear cache</button>
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

  // Bind buttons
  root.querySelector("#refresh").onclick = () => refreshLeaderboard(root);
  root.querySelector("#clearCache").onclick = () => {
    lsDel(LS_LEADERBOARD_KEY);
    toastInfo("Leaderboard cache cleared.");
    // Re-render minimal state
    renderEmpty(root, "Cache cleared. Tap Refresh to load.");
  };
}

function renderEmpty(root, note) {
  root.innerHTML = `
    <div class="card">
      <div class="h1">Leaderboards</div>
      <div class="small">${note || "No cached data. Tap Refresh to load."}</div>
      <div class="row" style="margin-top:10px">
        <button class="btn primary" id="refresh">Refresh</button>
      </div>
      <div class="small" id="msg" style="margin-top:8px"></div>
    </div>
  `;
  root.querySelector("#refresh").onclick = () => refreshLeaderboard(root);
}

async function refreshLeaderboard(root) {
  const routeAtStart = currentPath();
  const stillHere = () => currentPath() === routeAtStart;

  const refreshBtn = root.querySelector("#refresh");
  const msgEl = root.querySelector("#msg");

  if (refreshBtn) refreshBtn.disabled = true;
  if (msgEl) msgEl.textContent = "Loading…";

  const res = await API.leaderboard();

  if (!stillHere()) return;

  if (refreshBtn) refreshBtn.disabled = false;

  if (!res.ok) {
    if (msgEl) msgEl.textContent = res.error || "Failed";
    toastError(res.error || "Failed to load leaderboard");
    return;
  }

  lsSet(LS_LEADERBOARD_KEY, { ts: Date.now(), data: res });
  toastSuccess("Leaderboards refreshed.");

  renderFromData(root, res, { cacheNote: "" });
}

export async function renderLeaderboardPage(root) {
  cleanupCaches(); // keep storage tidy

  // No API call on tab open — cache-first
  const cached = lsGet(LS_LEADERBOARD_KEY);

  if (cached?.data?.ok) {
    const note = isFresh(cached, LEADERBOARD_TTL_MS)
      ? "Loaded from device cache."
      : "Loaded cached data (may be old). Tap Refresh if needed.";

    renderFromData(root, cached.data, { cacheNote: note });
    return;
  }

  renderEmpty(root, "No cached data yet. Tap Refresh to load.");
}
