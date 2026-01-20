// src/pages/leaderboard.js
import { API } from "../api/endpoints.js";
import { toastError, toastSuccess, toastInfo } from "../ui/toast.js";
import { cleanupCaches } from "../cache_cleanup.js";
import { getRouteToken } from "../router.js";
import { lsGet, lsSet, lsDel } from "../storage.js";

const LS_SELECTED_SEASON = "mlfc_selected_season_v1";
const LS_SEASONS_CACHE = "mlfc_seasons_cache_v1";
const LS_LB_PREFIX = "mlfc_leaderboard_v2:"; // + seasonId => {ts,data}

function now(){ return Date.now(); }

function lbKey(seasonId){ return `${LS_LB_PREFIX}${seasonId}`; }

function seasonSelectHtml(seasons, selectedId) {
  const opts = (seasons||[]).map(s =>
    `<option value="${s.seasonId}" ${s.seasonId===selectedId?"selected":""}>${s.name}</option>`
  ).join("");
  return `
    <div class="row" style="gap:10px; align-items:center; margin-top:10px">
      <div class="small" style="min-width:64px"><b>Season</b></div>
      <select class="input" id="seasonSelect" style="flex:1">${opts}</select>
    </div>
  `;
}

async function getSeasonsCached() {
  const cached = lsGet(LS_SEASONS_CACHE);
  if (cached?.data?.ok) return cached.data;
  const res = await API.seasons();
  if (res.ok) lsSet(LS_SEASONS_CACHE, { ts: now(), data: res });
  return res;
}

function pickSelectedSeason(seasonsRes) {
  const seasons = seasonsRes.seasons || [];
  const current = seasonsRes.currentSeasonId || "";
  let selected = localStorage.getItem(LS_SELECTED_SEASON) || "";
  if (!seasons.some(s => s.seasonId === selected)) selected = current || seasons[0]?.seasonId || "";
  if (selected) localStorage.setItem(LS_SELECTED_SEASON, selected);
  return { seasons, selected };
}

function sortRows(rows, mode) {
  const r = (rows||[]).slice();
  if (mode === "goals") r.sort((a,b)=>(b.goals||0)-(a.goals||0));
  else if (mode === "assists") r.sort((a,b)=>(b.assists||0)-(a.assists||0));
  else r.sort((a,b)=>(b.avgRating||0)-(a.avgRating||0));
  return r;
}

function renderTable(root, rows, sortMode) {
  const body = root.querySelector("#lbBody");
  const sorted = sortRows(rows, sortMode);

  body.innerHTML = sorted.map((x, i) => `
    <tr style="border-top:1px solid rgba(11,18,32,0.06)">
      <td style="padding:10px; font-weight:950">${i+1}</td>
      <td style="padding:10px; font-weight:950">${x.playerName}</td>
      <td style="padding:10px; text-align:center">${x.goals || 0}</td>
      <td style="padding:10px; text-align:center">${x.assists || 0}</td>
      <td style="padding:10px; text-align:center">${(x.avgRating || 0).toFixed(2)}</td>
      <td style="padding:10px; text-align:center" class="small">${x.matchesRated || 0}</td>
    </tr>
  `).join("") || `<tr><td colspan="6" class="small" style="padding:12px">No data.</td></tr>`;
}

export async function renderLeaderboardPage(root, query, tokenFromRouter) {
  cleanupCaches();
  const token = tokenFromRouter || getRouteToken();

  let sortMode = "rating";

  root.innerHTML = `
    <div class="card">
      <div class="h1">Leaderboard</div>
      <div id="seasonBlock"></div>
      <div class="row" style="margin-top:10px; gap:10px; flex-wrap:wrap">
        <button class="btn primary" id="refresh">Refresh</button>
        <button class="btn gray" id="clearCache">Clear cache</button>
      </div>
      <div class="small" id="msg" style="margin-top:8px"></div>

      <div class="row" style="margin-top:10px; gap:10px; flex-wrap:wrap">
        <button class="btn gray" id="sortGoals">Sort Goals</button>
        <button class="btn gray" id="sortAssists">Sort Assists</button>
        <button class="btn gray" id="sortRating">Sort Rating</button>
      </div>
    </div>

    <div class="card">
      <div class="h1">Season Stats</div>
      <div style="margin-top:10px; overflow:auto; border-radius:14px; border:1px solid rgba(11,18,32,0.10)">
        <table style="width:100%; border-collapse:collapse; min-width:620px">
          <thead>
            <tr style="background: rgba(11,18,32,0.04)">
              <th style="text-align:left; padding:10px; font-size:12px; color:rgba(11,18,32,0.72)">#</th>
              <th style="text-align:left; padding:10px; font-size:12px; color:rgba(11,18,32,0.72)">Player</th>
              <th style="text-align:center; padding:10px; font-size:12px; color:rgba(11,18,32,0.72)">Goals</th>
              <th style="text-align:center; padding:10px; font-size:12px; color:rgba(11,18,32,0.72)">Assists</th>
              <th style="text-align:center; padding:10px; font-size:12px; color:rgba(11,18,32,0.72)">Avg Rating</th>
              <th style="text-align:center; padding:10px; font-size:12px; color:rgba(11,18,32,0.72)">Rated</th>
            </tr>
          </thead>
          <tbody id="lbBody"></tbody>
        </table>
      </div>
    </div>
  `;

  const msg = root.querySelector("#msg");

  // seasons cache-first
  const seasonsRes = await getSeasonsCached();
  if (getRouteToken() !== token) return;
  if (!seasonsRes.ok) {
    msg.textContent = seasonsRes.error || "Failed seasons";
    return toastError(seasonsRes.error || "Failed seasons");
  }
  const { seasons, selected } = pickSelectedSeason(seasonsRes);
  let seasonId = selected;
  root.querySelector("#seasonBlock").innerHTML = seasonSelectHtml(seasons, seasonId);

  let rows = [];
  const cached = lsGet(lbKey(seasonId));
  if (cached?.data?.ok) {
    rows = cached.data.rows || [];
    msg.textContent = "Loaded from device cache.";
  } else {
    msg.textContent = "No cached data. Tap Refresh.";
  }
  renderTable(root, rows, sortMode);

  root.querySelector("#seasonSelect").onchange = () => {
    seasonId = root.querySelector("#seasonSelect").value;
    localStorage.setItem(LS_SELECTED_SEASON, seasonId);

    const c = lsGet(lbKey(seasonId));
    rows = c?.data?.ok ? (c.data.rows || []) : [];
    msg.textContent = rows.length ? "Loaded from device cache." : "No cached data. Tap Refresh.";
    renderTable(root, rows, sortMode);
  };

  root.querySelector("#sortGoals").onclick = () => { sortMode = "goals"; renderTable(root, rows, sortMode); };
  root.querySelector("#sortAssists").onclick = () => { sortMode = "assists"; renderTable(root, rows, sortMode); };
  root.querySelector("#sortRating").onclick = () => { sortMode = "rating"; renderTable(root, rows, sortMode); };

  root.querySelector("#clearCache").onclick = () => {
    lsDel(lbKey(seasonId));
    rows = [];
    renderTable(root, rows, sortMode);
    toastInfo("Leaderboard cache cleared.");
    msg.textContent = "Cleared. Tap Refresh.";
  };

  root.querySelector("#refresh").onclick = async () => {
    const btn = root.querySelector("#refresh");
    btn.disabled = true; btn.textContent = "Refreshing…";
    msg.textContent = "Loading…";

    const res = await API.leaderboardSeason(seasonId);

    btn.disabled = false; btn.textContent = "Refresh";
    if (getRouteToken() !== token) return;

    if (!res.ok) {
      msg.textContent = res.error || "Failed";
      return toastError(res.error || "Failed leaderboard");
    }

    lsSet(lbKey(seasonId), { ts: now(), data: res });
    rows = res.rows || [];
    renderTable(root, rows, sortMode);
    msg.textContent = "";
    toastSuccess("Leaderboard refreshed.");
  };
}
