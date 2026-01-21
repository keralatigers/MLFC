// src/pages/admin.js
import { API } from "../api/endpoints.js";
import { toastSuccess, toastError, toastInfo, toastWarn } from "../ui/toast.js";
import { cleanupCaches } from "../cache_cleanup.js";
import { isReloadForAdminList, isReloadForAdminMatchCode } from "../nav_state.js";

const LS_ADMIN_KEY = "mlfc_adminKey";
const LS_SELECTED_SEASON = "mlfc_selected_season_v1";
const LS_SEASONS_CACHE = "mlfc_seasons_cache_v1"; // {ts, data}

const LS_ADMIN_MATCHES_PREFIX = "mlfc_admin_matches_cache_v3:"; // + seasonId => {ts, matches}
const LS_MANAGE_CACHE_PREFIX = "mlfc_admin_manage_cache_v3:";   // + code => {ts, data}
const LS_MATCH_DETAIL_PREFIX = "mlfc_match_detail_cache_v2:";   // shared with match page

const SEASONS_TTL_MS = 60 * 10000;

let MEM = {
  adminKey: null,
  seasons: [],
  selectedSeasonId: "",
  matches: [],
};

function now() { return Date.now(); }
function currentHashPath() { return (location.hash || "#/match").split("?")[0]; }
function currentHashQuery() { return new URLSearchParams(location.hash.split("?")[1] || ""); }
function stillOnAdmin(routeToken) {
  return currentHashPath() === "#/admin" && window.__mlfcAdminToken === routeToken;
}

function baseUrl() { return location.href.split("#")[0]; }
function matchLink(publicCode) { return `${baseUrl()}#/match?code=${publicCode}`; }
function captainLink(publicCode, captainName) {
  return `${baseUrl()}#/captain?code=${publicCode}&captain=${encodeURIComponent(captainName)}`;
}
function waOpenPrefill(text) {
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
}

function lsGet(key) { try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; } }
function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }
function lsDel(key) { try { localStorage.removeItem(key); } catch {} }

function matchesKey(seasonId) { return `${LS_ADMIN_MATCHES_PREFIX}${seasonId}`; }
function manageKey(code) { return `${LS_MANAGE_CACHE_PREFIX}${code}`; }

function setDisabled(btn, disabled, busyText) {
  if (!btn) return;
  btn.disabled = disabled;
  if (busyText) {
    if (!btn.dataset.origText) btn.dataset.origText = btn.textContent;
    btn.textContent = disabled ? busyText : btn.dataset.origText;
  }
}

function uniqueSorted(arr) {
  return [...new Set(arr)].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function clearPublicMatchDetailCache(publicCode) {
  try {
    if (publicCode) localStorage.removeItem(`${LS_MATCH_DETAIL_PREFIX}${publicCode}`);
  } catch {}
}
function clearManageCache(publicCode) {
  try {
    if (publicCode) localStorage.removeItem(manageKey(publicCode));
  } catch {}
}
function clearAdminMatchesCache(seasonId) {
  try {
    if (seasonId) localStorage.removeItem(matchesKey(seasonId));
  } catch {}
}

// Robust human formatter (prevents invalid display if browser parsing differs)
function formatHumanDateTime(dateStr, timeStr) {
  const d = String(dateStr || "").trim();
  const t = String(timeStr || "").trim();
  if (!d || !t) return `${d || "Unknown date"} ${t || ""}`.trim();

  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  const hhmm = m ? `${String(m[1]).padStart(2, "0")}:${m[2]}` : t;

  const dt = new Date(`${d}T${hhmm}:00`);
  if (Number.isNaN(dt.getTime())) return `${d} ${hhmm}`;

  return dt.toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getViewParams(query) {
  // views:
  // - open (default)
  // - past
  // - manage (requires code)
  const view = (query.get("view") || "open").toLowerCase();
  const code = query.get("code") || "";
  const prev = (query.get("prev") || "open").toLowerCase();
  return { view, code, prev };
}

async function loadSeasonsCached(routeToken) {
  const cached = lsGet(LS_SEASONS_CACHE);
  if (cached?.data?.ok && (now() - (cached.ts || 0)) <= SEASONS_TTL_MS) return cached.data;

  const res = await API.seasons();
  if (!stillOnAdmin(routeToken)) return { ok: false, error: "Route changed" };
  if (res.ok) lsSet(LS_SEASONS_CACHE, { ts: now(), data: res });
  return res;
}

function pickSelectedSeason(seasonsRes) {
  const seasons = seasonsRes.seasons || [];
  const current = seasonsRes.currentSeasonId || "";

  let selected = localStorage.getItem(LS_SELECTED_SEASON) || "";
  if (!seasons.some(s => s.seasonId === selected)) selected = current || seasons[0]?.seasonId || "";
  if (selected) localStorage.setItem(LS_SELECTED_SEASON, selected);

  return { seasons, selected, current };
}

function seasonsSelectHtml(seasons, selected) {
  const opts = (seasons || []).map(s =>
    `<option value="${s.seasonId}" ${s.seasonId === selected ? "selected" : ""}>${s.name}</option>`
  ).join("");
  return `
    <div class="row" style="gap:10px; align-items:center; margin-top:10px">
      <div class="small" style="min-width:64px"><b>Season</b></div>
      <select class="input" id="seasonSelect" style="flex:1">${opts}</select>
    </div>
  `;
}

// Only called when user presses Refresh (no auto calls)
async function refreshMatchesFromApi(seasonId, routeToken) {
  const adminKey = MEM.adminKey || localStorage.getItem(LS_ADMIN_KEY);
  if (!adminKey) return { ok: false, error: "Missing admin key" };
  MEM.adminKey = adminKey;

  const res = await API.adminListMatches(adminKey, seasonId);
  if (!stillOnAdmin(routeToken)) return { ok: false, error: "Route changed" };
  if (!res.ok) return res;

  MEM.matches = res.matches || [];
  lsSet(matchesKey(seasonId), { ts: now(), matches: MEM.matches });
  return { ok: true, matches: MEM.matches };
}

// Cache-first load (no API)
function loadMatchesFromLocal(seasonId) {
  const cached = lsGet(matchesKey(seasonId));
  if (cached?.matches && Array.isArray(cached.matches)) {
    MEM.matches = cached.matches;
    return true;
  }
  MEM.matches = [];
  return false;
}

function renderLogin(root) {
  root.innerHTML = `
    <details class="card" open>
      <summary style="font-weight:950">Admin Login</summary>
      <div class="small" style="margin-top:8px">Enter admin key once. It will be remembered on this device.</div>
      <input id="key" class="input" placeholder="Admin key" style="margin-top:10px" />
      <div class="row" style="margin-top:10px">
        <button id="login" class="btn primary">Login</button>
        <button id="clear" class="btn gray">Clear key</button>
      </div>
      <div id="msg" class="small" style="margin-top:10px"></div>
    </details>
  `;

  const keyEl = root.querySelector("#key");
  const msgEl = root.querySelector("#msg");
  keyEl.value = localStorage.getItem(LS_ADMIN_KEY) || "";

  root.querySelector("#clear").onclick = () => {
    localStorage.removeItem(LS_ADMIN_KEY);
    toastInfo("Admin key cleared.");
    msgEl.textContent = "Cleared.";
  };

  root.querySelector("#login").onclick = async () => {
    const adminKey = keyEl.value.trim();
    if (!adminKey) return toastWarn("Enter admin key");

    setDisabled(root.querySelector("#login"), true, "Logging…");
    msgEl.textContent = "Logging in…";

    const routeToken = (window.__mlfcAdminToken = String(Math.random()));
    const seasonsRes = await loadSeasonsCached(routeToken);

    setDisabled(root.querySelector("#login"), false);
    if (!seasonsRes.ok) {
      msgEl.textContent = seasonsRes.error || "Failed seasons";
      return toastError(seasonsRes.error || "Failed seasons");
    }

    const { seasons, selected } = pickSelectedSeason(seasonsRes);
    MEM.seasons = seasons;
    MEM.selectedSeasonId = selected;

    // Validate key by calling admin list once
    const res = await API.adminListMatches(adminKey, selected);
    if (!res.ok) {
      msgEl.textContent = res.error || "Unauthorized";
      return toastError(res.error || "Unauthorized");
    }

    localStorage.setItem(LS_ADMIN_KEY, adminKey);
    MEM.adminKey = adminKey;
    MEM.matches = res.matches || [];
    lsSet(matchesKey(selected), { ts: now(), matches: MEM.matches });

    toastSuccess("Logged in.");
    location.hash = "#/admin?view=open";
  };
}

function topNavHtml(view) {
  const openActive = view === "open" ? "primary" : "gray";
  const pastActive = view === "past" ? "primary" : "gray";
  return `
    <div class="row" style="margin-top:10px; gap:10px; flex-wrap:wrap">
      <button class="btn ${openActive}" id="goOpen">Open matches</button>
      <button class="btn ${pastActive}" id="goPast">Past matches</button>
    </div>
  `;
}

function matchRowHtml(m, view) {
  const status = String(m.status || "").toUpperCase();
  const locked = String(m.ratingsLocked || "").toUpperCase() === "TRUE";
  const isCompleted = status === "COMPLETED";
  const isEditLocked = locked || status === "CLOSED" || isCompleted;

  // If locked/completed: disable Manage + Lock ratings
  const disableManage = isEditLocked;
  const disableLock = locked || isCompleted;

  const when = formatHumanDateTime(m.date, m.time);

  return `
    <div style="padding:10px 0; border-bottom:1px solid #eee">
      <div class="row" style="justify-content:space-between">
        <div style="min-width:0">
          <div style="font-weight:950; color: rgba(11,18,32,0.92)">${m.title}</div>
          <div class="small">${when} • ${m.type}</div>
        </div>
        <div class="row" style="gap:6px">
          <span class="badge">${m.status}</span>
          ${locked ? `<span class="badge badge--bad">LOCKED</span>` : ""}
        </div>
      </div>

      <div class="row" style="margin-top:8px; flex-wrap:wrap">
        <button class="btn gray" data-manage="${m.publicCode}" ${disableManage ? "disabled" : ""}>Manage</button>
        <button class="btn gray" data-lock="${m.matchId}" ${disableLock ? "disabled" : ""}>Lock ratings</button>
        ${isEditLocked ? `<button class="btn gray" data-unlock="${m.matchId}">Unlock match</button>` : ""}
      </div>
    </div>
  `;
}

function renderAdminShell(root, view) {
  root.innerHTML = `
    <div class="card" id="adminHeaderCard">
      <div class="h1">Admin</div>
      <div class="small">Season selection is shared across all tabs.</div>

      <div id="seasonBlock"></div>

      <div class="row" style="margin-top:10px; gap:10px; flex-wrap:wrap">
        <button id="logout" class="btn gray">Logout</button>
      </div>

      ${topNavHtml(view)}

      <div class="small" id="msg" style="margin-top:10px"></div>
    </div>

    <details class="card" id="seasonMgmt">
      <summary style="font-weight:950">Season management</summary>

      <div class="small" style="margin-top:8px">
        Create seasons like: <b>24 Winter</b>, <b>24-25 Summer</b>, <b>25 Winter</b>, <b>25-26 Summer</b>.
      </div>

      <input id="seasonName" class="input" placeholder="Season name (e.g., 25-26 Summer)" style="margin-top:10px" />
      <div class="row" style="margin-top:10px">
        <input id="seasonStart" class="input" type="date" style="flex:1" />
        <input id="seasonEnd" class="input" type="date" style="flex:1" />
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn primary" id="createSeason">Create season</button>
      </div>

      <div class="hr"></div>
      <div class="h1">Seasons</div>
      <div id="seasonList" class="small" style="margin-top:8px"></div>
    </details>

    <details class="card" id="createMatchCard" open>
      <summary style="font-weight:950">Create match</summary>

      <input id="title" class="input" placeholder="Title" style="margin-top:10px" />
      <input id="date" class="input" type="date" style="margin-top:10px" />
      <input id="time" class="input" type="time" value="19:00" style="margin-top:10px" />
      <select id="type" class="input" style="margin-top:10px">
        <option value="INTERNAL" selected>Internal (Blue vs Orange)</option>
        <option value="OPPONENT">Against opponents (1 captain)</option>
      </select>

      <button id="createMatch" class="btn primary" style="margin-top:10px">Create</button>
      <div id="created" class="small" style="margin-top:10px"></div>
    </details>

    <div id="listArea"></div>
    <div id="manageArea"></div>
  `;

  // Requested: Season management collapsed by default
  root.querySelector("#seasonMgmt").open = false;
}

function setAdminChromeVisible(root, visible) {
  const display = visible ? "" : "none";
  const header = root.querySelector("#adminHeaderCard");
  const seasonMgmt = root.querySelector("#seasonMgmt");
  const createMatch = root.querySelector("#createMatchCard");
  if (header) header.style.display = display;
  if (seasonMgmt) seasonMgmt.style.display = display;
  if (createMatch) createMatch.style.display = display;
}

function renderListView(root, view) {
  const listArea = root.querySelector("#listArea");
  const manageArea = root.querySelector("#manageArea");

  // When list view is visible, show admin chrome
  setAdminChromeVisible(root, true);

  // Show list, hide manage (destroy manage DOM so Back returns to a clean full view)
  listArea.style.display = "block";
  manageArea.style.display = "none";
  manageArea.innerHTML = "";

  const open = (MEM.matches || []).filter(m => String(m.status || "").toUpperCase() === "OPEN");
  const past = (MEM.matches || []).filter(m => String(m.status || "").toUpperCase() !== "OPEN");

  listArea.innerHTML = `
    <div class="card">
      <div class="h1">${view === "past" ? "Past matches" : "Open matches"}</div>
      <div id="matchesList" style="margin-top:10px">
        ${
          (view === "past" ? past : open).length
            ? (view === "past" ? past : open).map(m => matchRowHtml(m, view)).join("")
            : `<div class="small">No matches.</div>`
        }
      </div>
    </div>
  `;

  bindListButtons(root, view);
}

async function openManageView(root, code, routeToken, prevView) {
  const listArea = root.querySelector("#listArea");
  const manageArea = root.querySelector("#manageArea");

  // In manage view, hide admin header / season mgmt / create match so only match management shows.
  setAdminChromeVisible(root, false);

  // Hide list, show manage (do not destroy list DOM)
  listArea.style.display = "none";
  manageArea.style.display = "block";

  // Render from cache instantly if present
  const cached = lsGet(manageKey(code));
  if (cached?.data?.ok) {
    renderManageUI(root, cached.data, routeToken, { fromCache: true, prevView });

    // Per requirement: reload match details from API only on a browser refresh.
    if (isReloadForAdminMatchCode(code)) {
      API.getPublicMatch(code)
        .then(fresh => {
          if (!stillOnAdmin(routeToken)) return;
          if (!fresh?.ok) return;
          lsSet(manageKey(code), { ts: now(), data: fresh });
          renderManageUI(root, fresh, routeToken, { fromCache: false, prevView });
        })
        .catch(() => {});
    }

    return;
  }

  // No cache: show loading, then fetch ONCE
  manageArea.innerHTML = `<div class="card"><div class="h1">Loading match…</div><div class="small">Fetching details…</div></div>`;

  const fresh = await API.getPublicMatch(code);
  if (!stillOnAdmin(routeToken)) return;
  if (!fresh.ok) {
    manageArea.innerHTML = `<div class="card"><div class="h1">Error</div><div class="small">${fresh.error}</div></div>`;
    return toastError(fresh.error || "Failed to load match");
  }
  lsSet(manageKey(code), { ts: now(), data: fresh });
  renderManageUI(root, fresh, routeToken, { fromCache: false, prevView });
}

function bindTopNav(root, routeToken) {
  root.querySelector("#goOpen").onclick = () => {
    if (!stillOnAdmin(routeToken)) return;
    location.hash = "#/admin?view=open";
  };
  root.querySelector("#goPast").onclick = () => {
    if (!stillOnAdmin(routeToken)) return;
    location.hash = "#/admin?view=past";
  };
}

function bindSeasonSelector(root, routeToken) {
  root.querySelector("#seasonBlock").innerHTML = seasonsSelectHtml(MEM.seasons, MEM.selectedSeasonId);
  const select = root.querySelector("#seasonSelect");

  select.onchange = () => {
    if (!stillOnAdmin(routeToken)) return;

    MEM.selectedSeasonId = select.value;
    localStorage.setItem(LS_SELECTED_SEASON, MEM.selectedSeasonId);

    // cache-first load matches for season (no API)
    loadMatchesFromLocal(MEM.selectedSeasonId);

    const { view } = getViewParams(currentHashQuery());

    // If in manage and season changes, go back to open list for new season
    if (view === "manage") {
      location.hash = "#/admin?view=open";
    } else {
      renderListView(root, view);
    }
  };
}

function bindSeasonMgmt(root, routeToken) {
  const listEl = root.querySelector("#seasonList");
  listEl.innerHTML = (MEM.seasons || []).map(s => `• ${s.name} (${s.status}) ${s.startDate} → ${s.endDate}`).join("<br/>") || "No seasons yet.";

  root.querySelector("#createSeason").onclick = async () => {
    if (!stillOnAdmin(routeToken)) return;

    const btn = root.querySelector("#createSeason");
    const name = String(root.querySelector("#seasonName").value || "").trim();
    const startDate = String(root.querySelector("#seasonStart").value || "").trim();
    const endDate = String(root.querySelector("#seasonEnd").value || "").trim();
    if (!name || !startDate || !endDate) return toastWarn("Enter season name + start/end date.");

    setDisabled(btn, true, "Creating…");
    const out = await API.adminCreateSeason(MEM.adminKey, { name, startDate, endDate });
    setDisabled(btn, false);

    if (!out.ok) return toastError(out.error || "Failed to create season");
    toastSuccess("Season created.");

    // Reload seasons list (cache bust)
    lsDel(LS_SEASONS_CACHE);
    const seasonsRes = await loadSeasonsCached(routeToken);
    if (!stillOnAdmin(routeToken)) return;
    if (!seasonsRes.ok) return toastError(seasonsRes.error || "Failed to reload seasons");

    const picked = pickSelectedSeason(seasonsRes);
    MEM.seasons = picked.seasons;

    // Server will pick latest season as current; pickSelectedSeason respects that
    MEM.selectedSeasonId = picked.selected;
    localStorage.setItem(LS_SELECTED_SEASON, MEM.selectedSeasonId);

    // No auto API for matches; clear old season cache so user chooses Refresh when needed
    clearAdminMatchesCache(MEM.selectedSeasonId);
    loadMatchesFromLocal(MEM.selectedSeasonId);

    bindSeasonSelector(root, routeToken);
    bindSeasonMgmt(root, routeToken);

    // show open list from cache (likely empty until Refresh)
    renderListView(root, "open");
  };
}

function bindCreateMatch(root, routeToken) {
  root.querySelector("#createMatch").onclick = async () => {
    if (!stillOnAdmin(routeToken)) return;

    const btn = root.querySelector("#createMatch");
    setDisabled(btn, true, "Creating…");

    const payload = {
      title: root.querySelector("#title").value.trim() || "Weekly Match",
      date: root.querySelector("#date").value,
      time: root.querySelector("#time").value || "19:00",
      type: root.querySelector("#type").value,
      seasonId: MEM.selectedSeasonId
    };

    const out = await API.adminCreateMatch(MEM.adminKey, payload);
    setDisabled(btn, false);

    const created = root.querySelector("#created");
    if (!out.ok) {
      created.textContent = out.error || "Failed";
      return toastError(out.error || "Failed to create match");
    }

    toastSuccess("Match created.");

    // Requested: do NOT show URL here; just open the new match manage view
    created.textContent = "Created ✅ Opening match…";

    // Collapse create match section
    const details = root.querySelector("#createMatchCard");
    if (details) details.open = false;

    // Add new match into MEM + app storage immediately (NO API)
    const newMatch = {
      matchId: out.matchId,
      publicCode: out.publicCode,
      seasonId: out.seasonId || MEM.selectedSeasonId,
      title: payload.title,
      date: payload.date,
      time: payload.time,
      type: payload.type,
      status: "OPEN",
      ratingsLocked: "FALSE"
    };

    // Put new OPEN match at top
    MEM.matches = [newMatch, ...(MEM.matches || []).filter(m => String(m.matchId) !== String(newMatch.matchId))];
    lsSet(matchesKey(MEM.selectedSeasonId), { ts: now(), matches: MEM.matches });

    // Clear any stale caches for this match code
    clearPublicMatchDetailCache(out.publicCode);
    clearManageCache(out.publicCode);

    // Navigate to manage view (prev=open)
    location.hash = `#/admin?view=manage&code=${encodeURIComponent(out.publicCode)}&prev=open`;
  };
}

function bindHeaderButtons(root, routeToken) {
  root.querySelector("#logout").onclick = () => {
    localStorage.removeItem(LS_ADMIN_KEY);
    toastInfo("Logged out.");
    renderLogin(root);
  };
}

function bindListButtons(root, view) {
  // Manage
  // IMPORTANT: Don't rely solely on hashchange to open manage.
  // If the user previously opened the same match, setting the same hash may not trigger router work
  // depending on browser behavior + replaceState usage. So we open manage directly and then update URL.
  root.querySelectorAll('[data-manage]:not([disabled])').forEach(btn => {
    btn.onclick = async () => {
      const routeToken = window.__mlfcAdminToken;
      if (!stillOnAdmin(routeToken)) return;

      const code = btn.getAttribute("data-manage");
      // Navigate using the hash so the browser back button returns to the admin list view
      // (instead of whatever tab was open before entering admin).
      location.hash = `#/admin?view=manage&code=${encodeURIComponent(code)}&prev=${encodeURIComponent(view)}`;
    };
  });

  // Lock ratings
  root.querySelectorAll('[data-lock]:not([disabled])').forEach(btn => {
    btn.onclick = async () => {
      const routeToken = window.__mlfcAdminToken;
      if (!stillOnAdmin(routeToken)) return;

      const matchId = btn.getAttribute("data-lock");
      setDisabled(btn, true, "Locking…");

      const out = await API.adminLockRatings(MEM.adminKey, matchId);
      setDisabled(btn, false);

      if (!out.ok) return toastError(out.error || "Failed");
      toastSuccess("Ratings locked.");

      const found = (MEM.matches || []).find(x => String(x.matchId) === String(matchId));
      if (found?.publicCode) {
        clearPublicMatchDetailCache(found.publicCode);
        clearManageCache(found.publicCode);
      }

      // Update list cache via API only if user wants latest; but here action definitely changed state
      // so we update MEM locally (fast) and save.
      MEM.matches = (MEM.matches || []).map(m => {
        if (String(m.matchId) !== String(matchId)) return m;
        return { ...m, status: "COMPLETED", ratingsLocked: "TRUE" };
      });
      lsSet(matchesKey(MEM.selectedSeasonId), { ts: now(), matches: MEM.matches });

      // Re-render current list without API
      renderListView(root, view);
    };
  });

  // Unlock match
  root.querySelectorAll('[data-unlock]').forEach(btn => {
    btn.onclick = async () => {
      const routeToken = window.__mlfcAdminToken;
      if (!stillOnAdmin(routeToken)) return;

      const matchId = btn.getAttribute("data-unlock");
      setDisabled(btn, true, "Unlocking…");

      const out = await API.adminUnlockMatch(MEM.adminKey, matchId);
      setDisabled(btn, false);

      if (!out.ok) return toastError(out.error || "Failed");
      toastSuccess("Match unlocked.");

      const found = (MEM.matches || []).find(x => String(x.matchId) === String(matchId));
      if (found?.publicCode) {
        clearPublicMatchDetailCache(found.publicCode);
        clearManageCache(found.publicCode);
      }

      // Update MEM locally immediately (no API)
      MEM.matches = (MEM.matches || []).map(m => {
        if (String(m.matchId) !== String(matchId)) return m;
        return { ...m, status: "OPEN", ratingsLocked: "FALSE" };
      });
      lsSet(matchesKey(MEM.selectedSeasonId), { ts: now(), matches: MEM.matches });

      // Re-render list without API
      renderListView(root, view);
    };
  });
}

/* =======================
   Manage UI (FULL)
   - Opponent: set captain, show link only AFTER save + share button
   - Internal: compact table (player + Blue/Orange), remove enables buttons again,
              captains chosen via checkbox in team lists,
              Save setup + Share teams buttons AFTER lists,
              Captain links section only AFTER save
   - No close availability anywhere
   ======================= */

function renderManageUI(root, data, routeToken, { fromCache, prevView } = { fromCache: true, prevView: "open" }) {
  if (!stillOnAdmin(routeToken)) return;

  const manageArea = root.querySelector("#manageArea");
  const listArea = root.querySelector("#listArea");
  listArea.style.display = "none";
  manageArea.style.display = "block";

  const m = data.match;
  const status = String(m.status || "").toUpperCase();
  const locked = String(m.ratingsLocked || "").toUpperCase() === "TRUE";
  const isCompleted = status === "COMPLETED";
  const isEditLocked = locked || status === "CLOSED" || isCompleted;

  const type = String(m.type || "").toUpperCase();
  const availability = data.availability || [];
  const yesPlayers = uniqueSorted(availability
    .filter(a => String(a.availability).toUpperCase() === "YES")
    .map(a => String(a.playerName || "").trim())
  );

  const captains = data.captains || {};
  const teams = data.teams || [];

  const when = formatHumanDateTime(m.date, m.time);

  manageArea.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between; align-items:flex-start">
        <div style="min-width:0">
          <div class="h1" style="margin:0">Manage: ${m.title}</div>
          <div class="small" style="margin-top:6px">${when} • ${m.type} • ${m.status}</div>
          <div class="small" style="margin-top:6px">${fromCache ? "Loaded from device cache." : "Loaded from API."}</div>
          <div class="small" style="margin-top:6px">Refresh your browser to reload latest match details.</div>
        </div>
      </div>

      <div class="small" style="margin-top:10px">Match link:</div>
      <div class="small" style="word-break:break-all">${matchLink(m.publicCode)}</div>

      <div class="row" style="margin-top:12px; gap:10px; flex-wrap:wrap">
        <button class="btn primary" id="shareMatch">Share match link</button>
        ${isEditLocked ? `<button class="btn gray" id="unlockBtn">Unlock match</button>` : ""}
        <button class="btn primary" id="lockRatingsTop" ${locked ? "disabled" : ""}>Lock ratings</button>
      </div>

      ${locked ? `<div class="small" style="margin-top:10px">This match is locked. Manage and Lock actions are disabled in lists.</div>` : ""}
    </div>

    <div id="manageBody"></div>
  `;

  // Per requirement: no in-page Back/Refresh buttons.
  // Use browser back/forward and browser refresh when needed.

  manageArea.querySelector("#shareMatch").onclick = () => {
    waOpenPrefill(`Manor Lakes FC match link:\n${matchLink(m.publicCode)}`);
    toastInfo("WhatsApp opened.");
  };

  const unlockBtn = manageArea.querySelector("#unlockBtn");
  if (unlockBtn) {
    unlockBtn.onclick = async () => {
      if (!stillOnAdmin(routeToken)) return;
      setDisabled(unlockBtn, true, "Unlocking…");
      const out = await API.adminUnlockMatch(MEM.adminKey, m.matchId);
      setDisabled(unlockBtn, false);
      if (!out.ok) return toastError(out.error || "Failed");

      toastSuccess("Unlocked.");
      clearPublicMatchDetailCache(m.publicCode);
      clearManageCache(m.publicCode);

      // Update MEM locally (no API)
      MEM.matches = (MEM.matches || []).map(x => String(x.matchId) === String(m.matchId)
        ? { ...x, status: "OPEN", ratingsLocked: "FALSE" }
        : x
      );
      lsSet(matchesKey(MEM.selectedSeasonId), { ts: now(), matches: MEM.matches });

      // Fetch fresh match once to update manage view (explicit action just happened)
      const fresh = await API.getPublicMatch(m.publicCode);
      if (stillOnAdmin(routeToken) && fresh.ok) {
        lsSet(manageKey(m.publicCode), { ts: now(), data: fresh });
        renderManageUI(root, fresh, routeToken, { fromCache: false, prevView });
      }
    };
  }

  manageArea.querySelector("#lockRatingsTop").onclick = async () => {
    if (!stillOnAdmin(routeToken)) return;

    const btn = manageArea.querySelector("#lockRatingsTop");
    setDisabled(btn, true, "Locking…");

    const out = await API.adminLockRatings(MEM.adminKey, m.matchId);
    setDisabled(btn, false);
    if (!out.ok) return toastError(out.error || "Failed");

    toastSuccess("Ratings locked.");
    clearPublicMatchDetailCache(m.publicCode);
    clearManageCache(m.publicCode);

    // Update MEM locally (no API)
    MEM.matches = (MEM.matches || []).map(x => String(x.matchId) === String(m.matchId)
      ? { ...x, status: "COMPLETED", ratingsLocked: "TRUE" }
      : x
    );
    lsSet(matchesKey(MEM.selectedSeasonId), { ts: now(), matches: MEM.matches });

    // Fetch fresh match once to update manage view
    const fresh = await API.getPublicMatch(m.publicCode);
    if (stillOnAdmin(routeToken) && fresh.ok) {
      lsSet(manageKey(m.publicCode), { ts: now(), data: fresh });
      renderManageUI(root, fresh, routeToken, { fromCache: false, prevView });
    }
  };

  const manageBody = manageArea.querySelector("#manageBody");

  /* ================= OPPONENT ================= */
  if (type === "OPPONENT") {
    const cap = String(captains.captain1 || "");
    const opts = yesPlayers.map(p => `<option value="${p}">${p}</option>`).join("");
    const capUrl = cap ? captainLink(m.publicCode, cap) : "";

    manageBody.innerHTML = `
      <details class="card" open>
        <summary style="font-weight:950">Captain setup</summary>

        <div class="small" style="margin-top:8px">Select captain from available players. Link appears after save.</div>

        <select id="captainSel" class="input" style="margin-top:10px" ${isEditLocked ? "disabled" : ""}>
          <option value="">Select captain</option>
          ${opts}
        </select>

        <div class="row" style="margin-top:10px">
          <button class="btn primary" id="saveCap" ${isEditLocked ? "disabled" : ""}>Save captain</button>
        </div>

        <div class="hr"></div>

        <div class="h1">Captain link</div>
        ${
          cap
            ? `<div class="row" style="justify-content:space-between; align-items:flex-start">
                <div class="small" style="word-break:break-all; flex:1">${capUrl}</div>
                <button class="btn primary" id="shareCap">Share</button>
              </div>`
            : `<div class="small">Save captain to generate link.</div>`
        }

        <div class="small" id="msg" style="margin-top:10px"></div>
      </details>
    `;

    const capSel = manageBody.querySelector("#captainSel");
    capSel.value = cap || "";

    manageBody.querySelector("#saveCap").onclick = async () => {
      const btn = manageBody.querySelector("#saveCap");
      const msg = manageBody.querySelector("#msg");
      const sel = capSel.value.trim();
      if (!sel) return toastWarn("Select a captain");

      setDisabled(btn, true, "Saving…");
      msg.textContent = "Saving…";
      const out = await API.adminSetupOpponent(MEM.adminKey, { matchId: m.matchId, captain: sel });
      setDisabled(btn, false);

      if (!out.ok) { msg.textContent = out.error || "Failed"; return toastError(out.error || "Failed"); }
      msg.textContent = "Saved ✅";
      toastSuccess("Captain saved.");

      clearManageCache(m.publicCode);

      const fresh = await API.getPublicMatch(m.publicCode);
      if (stillOnAdmin(routeToken) && fresh.ok) {
        lsSet(manageKey(m.publicCode), { ts: now(), data: fresh });
        renderManageUI(root, fresh, routeToken, { fromCache: false, prevView });
      }
    };

    const shareBtn = manageBody.querySelector("#shareCap");
    if (shareBtn) shareBtn.onclick = () => {
      waOpenPrefill(`Captain link:\n${capUrl}`);
      toastInfo("WhatsApp opened.");
    };

    return;
  }

  /* ================= INTERNAL ================= */
  let blue = uniqueSorted(teams.filter(t => String(t.team).toUpperCase() === "BLUE").map(t => String(t.playerName || "").trim()));
  let orange = uniqueSorted(teams.filter(t => String(t.team).toUpperCase() === "ORANGE").map(t => String(t.playerName || "").trim()));
  let captainBlue = String(captains.captain1 || "");
  let captainOrange = String(captains.captain2 || "");

  // Links can be generated as soon as we know the captain names (no need to wait for Save setup).
  const blueUrl = captainBlue ? captainLink(m.publicCode, captainBlue) : "";
  const orangeUrl = captainOrange ? captainLink(m.publicCode, captainOrange) : "";
  const hasSavedSetup = (blue.length + orange.length) > 0 && !!captainBlue && !!captainOrange;

  function assignedTeam(p) {
    if (blue.includes(p)) return "BLUE";
    if (orange.includes(p)) return "ORANGE";
    return "";
  }

  function setTeam(p, team) {
    // remove from both
    blue = blue.filter(x => x !== p);
    orange = orange.filter(x => x !== p);

    if (team === "BLUE") blue = uniqueSorted([...blue, p]);
    if (team === "ORANGE") orange = uniqueSorted([...orange, p]);

    // if captain got removed, clear
    if (!blue.includes(captainBlue)) captainBlue = "";
    if (!orange.includes(captainOrange)) captainOrange = "";
  }

  function removeFromTeam(p) {
    blue = blue.filter(x => x !== p);
    orange = orange.filter(x => x !== p);
    if (captainBlue === p) captainBlue = "";
    if (captainOrange === p) captainOrange = "";
  }

  manageBody.innerHTML = `
    <details class="card" open>
      <summary style="font-weight:950">Internal setup</summary>

      <div class="small" style="margin-top:8px">
        Assign available players to Blue/Orange. You can change teams anytime. Tap <b>Clear</b> to unassign.
      </div>

      <div style="margin-top:12px">
        <div id="teamAssignList" class="assignList"></div>
      </div>

      <div class="hr"></div>

      <div class="row" style="gap:14px; align-items:flex-start; flex-wrap:wrap">
        <div style="flex:1; min-width:260px">
          <div class="badge assignBadge--blue">BLUE - <span id="blueCount">0</span></div>
          <div id="blueList" style="margin-top:10px"></div>
        </div>
        <div style="flex:1; min-width:260px">
          <div class="badge assignBadge--orange">ORANGE - <span id="orangeCount">0</span></div>
          <div id="orangeList" style="margin-top:10px"></div>
        </div>
      </div>

      <!-- Requested: Save + Share after lists -->
      <div class="row" style="margin-top:14px; gap:10px; flex-wrap:wrap">
        <button class="btn primary" id="saveSetup" ${isEditLocked ? "disabled" : ""}>Save setup</button>
        <button class="btn primary" id="shareTeams" ${hasSavedSetup ? "" : "disabled"}>Share teams</button>
      </div>

      <div id="setupMsg" class="small" style="margin-top:10px"></div>
    </details>

    <details class="card" open>
      <summary style="font-weight:950">Captain links</summary>

      <div class="row" style="align-items:flex-start; justify-content:space-between; margin-top:10px; gap:10px; flex-wrap:wrap">
        <div style="flex:1; min-width:0">
          <div class="small"><b>Blue captain:</b> <span id="capBlueName">${captainBlue || "(not selected)"}</span></div>
          <div class="small" id="capBlueUrl" style="word-break:break-all">${captainBlue ? captainLink(m.publicCode, captainBlue) : ""}</div>
        </div>
        <button class="btn primary" id="shareBlueCap" ${captainBlue ? "" : "disabled"}>Share</button>
      </div>

      <div class="hr"></div>

      <div class="row" style="align-items:flex-start; justify-content:space-between; gap:10px; flex-wrap:wrap">
        <div style="flex:1; min-width:0">
          <div class="small"><b>Orange captain:</b> <span id="capOrangeName">${captainOrange || "(not selected)"}</span></div>
          <div class="small" id="capOrangeUrl" style="word-break:break-all">${captainOrange ? captainLink(m.publicCode, captainOrange) : ""}</div>
        </div>
        <button class="btn primary" id="shareOrangeCap" ${captainOrange ? "" : "disabled"}>Share</button>
      </div>

      <div class="small" id="capLinksTip" style="margin-top:10px">Links are available immediately. Tap <b>Save setup</b> to persist teams/captains.</div>
    </details>
  `;

  // Mobile-friendly assignment UI: no horizontal scrolling, and team can be changed directly.
  function renderTeamAssignList() {
    const box = manageBody.querySelector("#teamAssignList");
    if (!box) return;

    if (!yesPlayers.length) {
      box.innerHTML = `<div class="card"><div class="small">No available players yet.</div></div>`;
      return;
    }

    box.innerHTML = yesPlayers.map(p => {
      const a = assignedTeam(p);
      const badgeCls = a === "BLUE" ? "assignBadge assignBadge--blue"
        : a === "ORANGE" ? "assignBadge assignBadge--orange"
        : "assignBadge";
      const badgeText = a ? a : "UNASSIGNED";

      const blueActive = a === "BLUE" ? "primary" : "gray";
      const orangeActive = a === "ORANGE" ? "primary" : "gray";

      return `
        <div class="assignCard">
          <div class="assignCard__head">
            <div style="min-width:0">
              <div class="assignCard__name">${p}</div>
              <div class="assignCard__meta">Assigned: <b>${badgeText}</b></div>
            </div>
            <div class="${badgeCls}">${badgeText}</div>
          </div>

          <div class="assignBtns">
            <button class="btn ${blueActive} tiny" data-team-btn="BLUE" data-player="${encodeURIComponent(p)}" ${isEditLocked ? "disabled" : ""}>Blue</button>
            <button class="btn ${orangeActive} tiny" data-team-btn="ORANGE" data-player="${encodeURIComponent(p)}" ${isEditLocked ? "disabled" : ""}>Orange</button>
            <button class="btn ghost tiny" data-remove="${encodeURIComponent(p)}" ${isEditLocked ? "disabled" : ""} ${a ? "" : "disabled"}>Clear</button>
          </div>
        </div>
      `;
    }).join("");

    box.querySelectorAll("[data-team-btn]").forEach(b => {
      b.onclick = () => {
        const team = b.getAttribute("data-team-btn");
        const p = decodeURIComponent(b.getAttribute("data-player"));
        setTeam(p, team);
        renderAll();
      };
    });

    box.querySelectorAll("[data-remove]").forEach(b => {
      b.onclick = () => {
        const p = decodeURIComponent(b.getAttribute("data-remove"));
        removeFromTeam(p);
        renderAll();
      };
    });
  }

  function renderLists() {
    const blueEl = manageBody.querySelector("#blueList");
    const orangeEl = manageBody.querySelector("#orangeList");
    const blueCountEl = manageBody.querySelector("#blueCount");
    const orangeCountEl = manageBody.querySelector("#orangeCount");

    if (blueCountEl) blueCountEl.textContent = String(blue.length);
    if (orangeCountEl) orangeCountEl.textContent = String(orange.length);

    function listHtml(players, teamName) {
      if (!players.length) return `<div class="small">No players yet.</div>`;
      return players.map(p => {
        const isCap = (teamName === "BLUE" ? captainBlue === p : captainOrange === p);
        const disabled = isEditLocked ? "disabled" : "";
        return `
          <div class="teamMiniRow">
            <div class="teamMiniRow__name" title="${p}">${p}</div>

            <div class="teamMiniRow__cap">
              <label class="small" style="display:flex; gap:6px; align-items:center">
                <input type="checkbox" data-cap="${teamName}" data-player="${encodeURIComponent(p)}" ${isCap ? "checked" : ""} ${disabled}/>
                Captain
              </label>
            </div>

            <button class="teamMiniRow__x" data-remove="${encodeURIComponent(p)}" ${disabled} aria-label="Remove ${p}">×</button>
          </div>
        `;
      }).join("");
    }

    blueEl.innerHTML = listHtml(blue, "BLUE");
    orangeEl.innerHTML = listHtml(orange, "ORANGE");

    manageBody.querySelectorAll("[data-cap]").forEach(cb => {
      cb.onchange = () => {
        const teamName = cb.getAttribute("data-cap");
        const p = decodeURIComponent(cb.getAttribute("data-player"));
        if (teamName === "BLUE") captainBlue = cb.checked ? p : "";
        if (teamName === "ORANGE") captainOrange = cb.checked ? p : "";
        renderAll();
      };
    });

    manageBody.querySelectorAll("[data-remove]").forEach(btn => {
      btn.onclick = () => {
        const p = decodeURIComponent(btn.getAttribute("data-remove"));
        removeFromTeam(p);
        renderAll();
      };
    });
  }

  function renderAll() {
    blue = uniqueSorted(blue);
    orange = uniqueSorted(orange);
    renderTeamAssignList();
    renderLists();

    // Update captain link UI live (captains can change before Save)
    const blueNameEl = manageBody.querySelector("#capBlueName");
    const orangeNameEl = manageBody.querySelector("#capOrangeName");
    const blueUrlEl = manageBody.querySelector("#capBlueUrl");
    const orangeUrlEl = manageBody.querySelector("#capOrangeUrl");
    const shareBlueBtn = manageBody.querySelector("#shareBlueCap");
    const shareOrangeBtn = manageBody.querySelector("#shareOrangeCap");

    const liveBlueUrl = captainBlue ? captainLink(m.publicCode, captainBlue) : "";
    const liveOrangeUrl = captainOrange ? captainLink(m.publicCode, captainOrange) : "";

    if (blueNameEl) blueNameEl.textContent = captainBlue || "(not selected)";
    if (orangeNameEl) orangeNameEl.textContent = captainOrange || "(not selected)";
    if (blueUrlEl) blueUrlEl.textContent = liveBlueUrl;
    if (orangeUrlEl) orangeUrlEl.textContent = liveOrangeUrl;
    if (shareBlueBtn) shareBlueBtn.disabled = !liveBlueUrl;
    if (shareOrangeBtn) shareOrangeBtn.disabled = !liveOrangeUrl;

    const shareBtn = manageBody.querySelector("#shareTeams");
    if (shareBtn) {
      const ok = (blue.length + orange.length) > 0 && captainBlue && captainOrange;
      shareBtn.disabled = !ok;
    }
  }

  renderAll();

  // Save setup
  manageBody.querySelector("#saveSetup").onclick = async () => {
    if (!stillOnAdmin(routeToken)) return;
    if (isEditLocked) return toastWarn("Match is locked. Unlock to edit.");

    const msg = manageBody.querySelector("#setupMsg");
    if (!captainBlue || !captainOrange) {
      msg.textContent = "Select captains for BOTH Blue and Orange.";
      return toastWarn("Select both captains.");
    }

    const btn = manageBody.querySelector("#saveSetup");
    setDisabled(btn, true, "Saving…");
    msg.textContent = "Saving…";

    const out = await API.adminSetupInternal(MEM.adminKey, {
      matchId: m.matchId,
      bluePlayers: blue,
      orangePlayers: orange,
      captainBlue,
      captainOrange
    });

    setDisabled(btn, false);

    if (!out.ok) {
      msg.textContent = out.error || "Failed";
      return toastError(out.error || "Failed to save setup");
    }

    msg.textContent = "Saved ✅";
    toastSuccess("Setup saved.");

    clearManageCache(m.publicCode);

    const fresh = await API.getPublicMatch(m.publicCode);
    if (stillOnAdmin(routeToken) && fresh.ok) {
      lsSet(manageKey(m.publicCode), { ts: now(), data: fresh });
      renderManageUI(root, fresh, routeToken, { fromCache: false, prevView });
    }
  };

  // Share teams (after saved)
  const shareTeamsBtn = manageBody.querySelector("#shareTeams");
  shareTeamsBtn.onclick = () => {
    const ok = (blue.length + orange.length) > 0 && captainBlue && captainOrange;
    if (!ok) return toastWarn("Save setup first.");

    setDisabled(shareTeamsBtn, true, "Opening…");

    const lines = [];
    lines.push(`Match: ${m.title}`);
    lines.push(`When: ${when}`);
    lines.push(`Type: INTERNAL`);
    lines.push(`Link: ${matchLink(m.publicCode)}`);
    lines.push("");
    lines.push(`BLUE Captain: ${captainBlue}`);
    blue.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
    lines.push("");
    lines.push(`ORANGE Captain: ${captainOrange}`);
    orange.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
    lines.push("");
    lines.push(`Blue Captain Link: ${captainLink(m.publicCode, captainBlue)}`);
    lines.push(`Orange Captain Link: ${captainLink(m.publicCode, captainOrange)}`);

    waOpenPrefill(lines.join("\n"));
    toastInfo("WhatsApp opened.");

    setTimeout(() => setDisabled(shareTeamsBtn, false), 900);
  };

  // Captain link share buttons (only exist after save)
  const sb = manageBody.querySelector("#shareBlueCap");
  if (sb) sb.onclick = () => { waOpenPrefill(`Blue captain link:\n${captainLink(m.publicCode, captainBlue)}`); toastInfo("WhatsApp opened."); };
  const so = manageBody.querySelector("#shareOrangeCap");
  if (so) so.onclick = () => { waOpenPrefill(`Orange captain link:\n${captainLink(m.publicCode, captainOrange)}`); toastInfo("WhatsApp opened."); };
}

/* =======================
   Main entry
   ======================= */

export async function renderAdminPage(root, query) {
  cleanupCaches();

  const routeToken = (window.__mlfcAdminToken = String(Math.random()));

  const adminKey = localStorage.getItem(LS_ADMIN_KEY);
  if (!adminKey) {
    renderLogin(root);
    return;
  }
  MEM.adminKey = adminKey;

  // seasons cache-first
  const seasonsRes = await loadSeasonsCached(routeToken);
  if (!stillOnAdmin(routeToken)) return;

  if (!seasonsRes.ok) {
    toastError(seasonsRes.error || "Failed to load seasons");
    renderLogin(root);
    return;
  }

  const picked = pickSelectedSeason(seasonsRes);
  MEM.seasons = picked.seasons;
  MEM.selectedSeasonId = localStorage.getItem(LS_SELECTED_SEASON) || picked.selected;

  // matches cache-first (no API)
  loadMatchesFromLocal(MEM.selectedSeasonId);

  const { view, code, prev } = getViewParams(query);

  renderAdminShell(root, view);

  bindTopNav(root, routeToken);
  bindSeasonSelector(root, routeToken);
  bindSeasonMgmt(root, routeToken);
  bindCreateMatch(root, routeToken);
  bindHeaderButtons(root, routeToken);

  const msg = root.querySelector("#msg");
  msg.textContent = MEM.matches.length
    ? "Loaded from device cache. Refresh your browser to fetch the latest."
    : "No cached matches for this season yet. Refresh your browser to load from server.";

  // Per requirement: fetch admin matches from API ONLY on browser refresh (or first time with empty cache).
  const shouldReloadFetch = isReloadForAdminList() || !MEM.matches.length;
  if (shouldReloadFetch) {
    msg.textContent = "Loading latest…";
    const out = await refreshMatchesFromApi(MEM.selectedSeasonId, routeToken);
    if (!stillOnAdmin(routeToken)) return;
    if (!out.ok) {
      msg.textContent = out.error || "Failed to load";
    } else {
      msg.textContent = "";
    }
  }

  // Render view without API
  if (view === "manage" && code) {
    await openManageView(root, code, routeToken, prev || "open");
  } else {
    renderListView(root, (view === "past") ? "past" : "open");
  }
}