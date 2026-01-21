// src/pages/match.js
import { API } from "../api/endpoints.js";
import { toastSuccess, toastError, toastInfo, toastWarn } from "../ui/toast.js";
import { isReloadForMatchList, isReloadForMatchCode } from "../nav_state.js";

const LS_SEASONS_CACHE = "mlfc_seasons_cache_v1";
const LS_SELECTED_SEASON = "mlfc_selected_season_v1";

const LS_OPEN_CACHE_PREFIX = "mlfc_open_matches_cache_v2:";   // seasonId -> {ts,matches}
const LS_PAST_CACHE_PREFIX = "mlfc_past_matches_cache_v2:";   // seasonId -> {ts,page,pageSize,total,hasMore,matches}
const LS_MATCH_DETAIL_PREFIX = "mlfc_match_detail_cache_v2:"; // code -> {ts,data}
const LS_MATCH_META_PREFIX = "mlfc_matches_meta_v2:";         // seasonId -> {ts,fingerprint,latestCode}
const LS_PLAYERS_CACHE = "mlfc_players_cache_v2";             // {ts,players:[name...]}

const PLAYERS_TTL_MS = 6 * 60 * 60 * 1000;

// Prevent banner/meta re-check from immediately re-rendering / hiding updates
let SUPPRESS_META_ONCE = false;

// Router does not re-render a route if its hash is unchanged.
// When users switch away and back to the Match tab, we still need to check
// for new matches (meta banner). We keep references to the last rendered
// match list root and re-check meta on tab activation.
let ACTIVE_MATCH = { pageRoot: null, listRoot: null, seasonId: "" };
let MATCH_META_LAST_CHECK = 0;
let MATCH_META_LISTENERS_INSTALLED = false;

function isMatchRouteActive() {
  const hash = window.location.hash || "#/match";
  return hash.startsWith("#/match");
}

function scheduleMatchMetaCheck(reason = "") {
  // Backend-protection: only check meta when the Match tab is (re)entered.
  // Avoid calling frequently (no polling, no focus spam).
  const t = now();
  const cooldown = reason === "load" || reason === "tab" ? 0 : 15000;
  if (t - MATCH_META_LAST_CHECK < cooldown) return;
  MATCH_META_LAST_CHECK = t;

  if (!ACTIVE_MATCH.pageRoot || !ACTIVE_MATCH.listRoot || !ACTIVE_MATCH.seasonId) return;
  if (!isMatchRouteActive()) return;

  // Only check when list view is visible
  const listEl = ACTIVE_MATCH.pageRoot.querySelector("#matchListView");
  if (!listEl || listEl.style.display === "none") return;

  checkMetaAndShowBanner(ACTIVE_MATCH.pageRoot, ACTIVE_MATCH.listRoot, ACTIVE_MATCH.seasonId)
    .catch(() => {});
}

function ensureMatchMetaActivationListeners() {
  if (MATCH_META_LISTENERS_INSTALLED) return;
  MATCH_META_LISTENERS_INSTALLED = true;

  // Runs when user navigates to #/match (tab click). Router may skip re-render
  // if the hash is unchanged, but hashchange still fires when the user switches tabs.
  window.addEventListener("hashchange", () => {
    // Only treat this as a "tab enter" when the match route is active.
    if (isMatchRouteActive()) setTimeout(() => scheduleMatchMetaCheck("tab"), 0);
  });
}


function now() { return Date.now(); }
function lsGet(k){ try{return JSON.parse(localStorage.getItem(k)||"null");}catch{return null;} }
function lsSet(k,v){ try{localStorage.setItem(k,JSON.stringify(v));}catch{} }
function lsDel(k){ try{localStorage.removeItem(k);}catch{} }

function openKey(seasonId){ return `${LS_OPEN_CACHE_PREFIX}${seasonId}`; }
function pastKey(seasonId){ return `${LS_PAST_CACHE_PREFIX}${seasonId}`; }
function detailKey(code){ return `${LS_MATCH_DETAIL_PREFIX}${code}`; }
function metaKey(seasonId){ return `${LS_MATCH_META_PREFIX}${seasonId}`; }

function baseUrl(){ return location.href.split("#")[0]; }

function setDisabled(btn, disabled, busyText) {
  if (!btn) return;
  btn.disabled = disabled;
  if (busyText) {
    if (!btn.dataset.origText) btn.dataset.origText = btn.textContent;
    btn.textContent = disabled ? busyText : btn.dataset.origText;
  }
}

function uniqueSorted(arr){ return [...new Set(arr)].filter(Boolean).sort((a,b)=>a.localeCompare(b)); }

// Handle both normalized and Sheets Date-string formats
function normalizeDateStr(dateStr) {
  const s = String(dateStr || "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function normalizeTimeStr(timeStr) {
  const s = String(timeStr || "").trim();
  if (!s) return "";
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    const [h,m]=s.split(":");
    return `${String(h).padStart(2,"0")}:${m}`;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}
function formatHumanDateTime(dateStr, timeStr) {
  const d = normalizeDateStr(dateStr);
  const t = normalizeTimeStr(timeStr);
  if (!d || !t) return `${d||"Unknown date"} ${t||""}`.trim();
  const dt = new Date(`${d}T${t}:00`);
  if (Number.isNaN(dt.getTime())) return `${d} ${t}`;
  return dt.toLocaleString(undefined, {
    weekday:"short", year:"numeric", month:"short", day:"numeric",
    hour:"numeric", minute:"2-digit"
  });
}

// Prefer createdAt (newest first). Fallback to match datetime (soonest first) if missing.
function openMatchSortKey(m) {
  const created = new Date(m?.createdAt || "").getTime();
  if (!Number.isNaN(created) && created > 0) return { type: "created", v: created };
  const d = normalizeDateStr(m?.date);
  const t = normalizeTimeStr(m?.time);
  const dt = new Date(`${d}T${t}:00`).getTime();
  return { type: "dt", v: Number.isNaN(dt) ? 0 : dt };
}

// Find newest match (for LATEST tag)
function getLatestOpenCode(openMatches) {
  const list = Array.isArray(openMatches) ? openMatches : [];
  let best = null;
  for (const m of list) {
    const k = openMatchSortKey(m);
    if (!best) { best = { code: m.publicCode, key: k }; continue; }
    // createdAt wins always; else compare dt
    if (k.type === "created" && best.key.type !== "created") { best = { code: m.publicCode, key: k }; continue; }
    if (k.type === "created" && best.key.type === "created" && k.v > best.key.v) { best = { code: m.publicCode, key: k }; continue; }
    if (k.type === "dt" && best.key.type === "dt" && k.v > best.key.v) { best = { code: m.publicCode, key: k }; continue; }
  }
  return best?.code || "";
}

// Prefetch details for all open matches and store in localStorage cache.
// Runs in background; never blocks UI.
function prefetchOpenMatchDetails(openMatches) {
  const list = Array.isArray(openMatches) ? openMatches : [];
  const toFetch = list.filter(m => {
    const code = m?.publicCode;
    if (!code) return false;
    const cached = lsGet(detailKey(code));
    return !(cached?.data?.ok);
  });

  if (!toFetch.length) return;

  Promise.all(
    toFetch.map(m =>
      API.getPublicMatch(m.publicCode)
        .then(res => {
          if (res?.ok) {
            lsSet(detailKey(m.publicCode), { ts: now(), data: res });
          }
        })
        .catch(() => {})
    )
  );
}

function seasonsSelectHtml(seasons, selected) {
  const opts = (seasons||[]).map(s => `<option value="${s.seasonId}" ${s.seasonId===selected?"selected":""}>${s.name}</option>`).join("");
  return `
    <div class="row" style="gap:10px; align-items:center; margin-top:10px">
      <div class="small" style="min-width:64px"><b>Season</b></div>
      <select class="input" id="seasonSelect" style="flex:1">${opts}</select>
    </div>
  `;
}

function availabilityGroups(av) {
  const yes = uniqueSorted(av.filter(x=>x.availability==="YES").map(x=>x.playerName));
  const no = uniqueSorted(av.filter(x=>x.availability==="NO").map(x=>x.playerName));
  const maybe = uniqueSorted(av.filter(x=>x.availability==="MAYBE").map(x=>x.playerName));
  return { yes, no, maybe };
}

function whatsappAvailabilityMessage(match, availability) {
  const when = formatHumanDateTime(match.date, match.time);
  const { yes, no, maybe } = availabilityGroups(availability);

  const lines = [];
  lines.push(`match details : ${match.title}`);
  lines.push(`time : ${when}`);
  lines.push(`type : ${match.type}`);
  lines.push(`status : ${match.status}`);
  lines.push("");
  lines.push("avaialbilty");
  (yes.length ? yes : ["-"]).forEach((n,i)=>lines.push(`${i+1}.${n}`));
  lines.push("not available");
  (no.length ? no : ["-"]).forEach((n,i)=>lines.push(`${i+1}.${n}`));
  lines.push("maybe");
  (maybe.length ? maybe : ["-"]).forEach((n,i)=>lines.push(`${i+1}.${n}`));
  lines.push("");
  lines.push(`link : ${baseUrl()}#/match?code=${match.publicCode}`);
  return lines.join("\n");
}

function renderShell(root){
  root.innerHTML = `
    <div id="matchListView"></div>
    <div id="matchDetailView" style="display:none"></div>
  `;
}

async function loadSeasons() {
  const cached = lsGet(LS_SEASONS_CACHE)?.data;
  if (cached?.ok) return cached;

  const res = await API.seasons();
  if (res.ok) lsSet(LS_SEASONS_CACHE, { ts: now(), data: res });
  return res;
}

function pickSelectedSeason(seasonsRes) {
  const seasons = seasonsRes.seasons || [];
  const current = seasonsRes.currentSeasonId || seasons[0]?.seasonId || "";
  let selected = localStorage.getItem(LS_SELECTED_SEASON) || "";
  if (!seasons.some(s=>s.seasonId===selected)) selected = current;
  if (selected) localStorage.setItem(LS_SELECTED_SEASON, selected);
  return { seasons, selected };
}

async function getPlayersCached() {
  const cached = lsGet(LS_PLAYERS_CACHE);
  // requested: always use cached list; refresh only on Refresh Open button OR manual refresh button
  if (cached?.players?.length) return cached.players;

  // fallback: if missing cache, fetch once
  const res = await API.players();
  if (res.ok) {
    const list = uniqueSorted((res.players || []).map(p => p.name));
    lsSet(LS_PLAYERS_CACHE, { ts: now(), players: list });
    return list;
  }
  return cached?.players || [];
}

// Force refresh players and store in app cache
async function refreshPlayersCache() {
  const res = await API.players();
  if (!res.ok) {
    toastError(res.error || "Failed to refresh players");
    return null;
  }
  const list = uniqueSorted((res.players || []).map(p => p.name));
  lsSet(LS_PLAYERS_CACHE, { ts: now(), players: list });
  toastSuccess("Players refreshed");
  return list;
}

function renderBanner(root, html) {
  const el = root.querySelector("#banner");
  if (!el) return;
  el.innerHTML = html || "";
}

async function checkMetaAndShowBanner(pageRoot, seasonId) {
  const listRoot = pageRoot.querySelector("#matchListView");
  if (!listRoot) return;

  const prev = lsGet(metaKey(seasonId));
  const res = await API.publicMatchesMeta(seasonId);

  if (!res || res.ok !== true) {
    renderBanner(listRoot, "");
    return;
  }

  const next = { ts: now(), fingerprint: res.fingerprint || "", latestCode: res.latestCode || "" };
  lsSet(metaKey(seasonId), next);

  if (!next.fingerprint) { renderBanner(listRoot, ""); return; }

  const openCache = lsGet(openKey(seasonId));
  const openCodes = (openCache?.matches || []).map(m => m.publicCode);

  // When fingerprint changes or latestCode isn't in our cached open list, show update banner
  const isNew =
    !prev?.fingerprint ||
    prev.fingerprint !== next.fingerprint ||
    (next.latestCode && !openCodes.includes(next.latestCode));

  if (!isNew) { renderBanner(listRoot, ""); return; }

  renderBanner(listRoot, `
    <div class="card" style="border:1px solid rgba(16,185,129,0.35); background: rgba(16,185,129,0.10)">
      <div class="row" style="justify-content:space-between; align-items:center">
        <div style="min-width:0">
          <div style="font-weight:950">New match available</div>
          <div class="small">Tap Update to refresh open matches list.</div>
        </div>
        <div class="row" style="gap:10px">
          <button class="btn primary" id="metaUpdateBtn">Update</button>
          ${next.latestCode ? `<button class="btn gray" id="metaOpenBtn">Open</button>` : ""}
        </div>
      </div>
    </div>
  `);

  const up = listRoot.querySelector("#metaUpdateBtn");
  if (up) up.onclick = async () => {
    // Hide banner immediately so it can't "stick"
    renderBanner(listRoot, "");

    up.disabled = true; up.textContent = "Updating…";

    // Prevent banner/meta re-check from immediately re-rendering / hiding updates
    SUPPRESS_META_ONCE = true;

    const out = await API.publicOpenMatches(seasonId);

    up.disabled = false; up.textContent = "Update";
    if (!out || out.ok !== true) return toastError(out?.error || "Failed to update");

    // Update cache
    lsSet(openKey(seasonId), { ts: now(), matches: out.matches || [] });

    // Update meta cache too so banner won't immediately reappear
    const prevMeta = lsGet(metaKey(seasonId));
    lsSet(metaKey(seasonId), {
      ts: now(),
      fingerprint: prevMeta?.fingerprint || next.fingerprint,
      latestCode: next.latestCode
    });

    // Refresh UI (IMPORTANT: use pageRoot, not listRoot)
    renderMatchList(pageRoot, seasonId, out.matches || []);

    // Prefetch details for speed
    prefetchOpenMatchDetails(out.matches || []);

    toastSuccess("Open matches updated.");
  };

  const op = listRoot.querySelector("#metaOpenBtn");
  if (op) op.onclick = () => {
    location.hash = `#/match?code=${encodeURIComponent(next.latestCode)}`;
  };
}


function renderMatchList(root, seasonId, openMatches) {
  const list = root.querySelector("#matchListView");
  const detail = root.querySelector("#matchDetailView");
  list.style.display = "block";
  detail.style.display = "none";

  const latestCode = getLatestOpenCode(openMatches);

  const open = (openMatches || []).slice().sort((a, b) => {
    const ak = openMatchSortKey(a);
    const bk = openMatchSortKey(b);

    if (ak.type === "created" && bk.type === "created") return bk.v - ak.v;
    if (ak.type === "created" && bk.type !== "created") return -1;
    if (ak.type !== "created" && bk.type === "created") return 1;

    return ak.v - bk.v;
  });

  list.innerHTML = `
    <div class="card">
      <div class="h1">Matches</div>
      <div class="small">Open matches load from cache. Refresh your browser to fetch the latest (or tap Update in the banner).</div>

      <div id="seasonBlock"></div>

      <div id="banner" style="margin-top:10px"></div>
    </div>

    <div class="card">
      <div class="h1">Open matches</div>
      ${
        open.length
          ? open.map(m=>`
            <div style="padding:10px 0; border-bottom:1px solid rgba(11,18,32,0.10)">
              <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
                <div style="font-weight:950">${m.title}</div>
                ${m.publicCode === latestCode ? `<span class="badge" style="background:#16a34a;color:#fff">LATEST</span>` : ""}
              </div>
              <div class="small">${formatHumanDateTime(m.date,m.time)} • ${m.type} • ${m.status}</div>
              <div class="row" style="margin-top:8px">
                <button class="btn primary" data-open="${m.publicCode}">Open</button>
              </div>
            </div>
          `).join("")
          : `<div class="small">No open matches.</div>`
      }
    </div>

    <details class="card" id="pastSection">
      <summary style="font-weight:950">Past matches</summary>
      <div class="small" style="margin-top:8px">Past matches only load when you tap Refresh Past.</div>
      <div class="row" style="margin-top:10px; gap:10px; flex-wrap:wrap">
        <button class="btn primary" id="refreshPast">Refresh Past</button>
      </div>
      <div id="pastArea" style="margin-top:10px"></div>
    </details>
  `;

  list.querySelectorAll("[data-open]").forEach(btn=>{
    btn.onclick=()=>{ location.hash = `#/match?code=${encodeURIComponent(btn.getAttribute("data-open"))}`; };
  });

  // Per requirement: no Refresh Open / Clear cache buttons here.
  // Latest open matches are fetched only on browser reload (or via meta banner Update).

  list.querySelector("#refreshPast").onclick = async () => {
    const btn = list.querySelector("#refreshPast");
    setDisabled(btn,true,"Refreshing…");
    const res = await API.publicPastMatches(seasonId, 1, 20);
    setDisabled(btn,false);
    if (!res.ok) return toastError(res.error||"Failed");
    lsSet(pastKey(seasonId), { ts: now(), ...res });
    renderPastArea(root, seasonId);
    toastSuccess("Past matches refreshed.");
  };

  renderPastArea(root, seasonId);

  if (SUPPRESS_META_ONCE) {
    SUPPRESS_META_ONCE = false;
    renderBanner(list, ""); // ensure banner disappears after update
  } else {
    checkMetaAndShowBanner(root, seasonId).catch(()=>{});

  }
}

function renderPastArea(root, seasonId) {
  const pastArea = root.querySelector("#pastArea");
  if (!pastArea) return;

  const cache = lsGet(pastKey(seasonId));
  const items = cache?.matches || [];
  pastArea.innerHTML = items.length
    ? items.map(m=>`
        <div style="padding:10px 0; border-bottom:1px solid rgba(11,18,32,0.10)">
          <div style="font-weight:950">${m.title}</div>
          <div class="small">${formatHumanDateTime(m.date,m.time)} • ${m.type} • ${m.status}</div>
          <div class="row" style="margin-top:8px">
            <button class="btn gray" data-open="${m.publicCode}">View</button>
          </div>
        </div>
      `).join("")
    : `<div class="small">No past matches cached yet.</div>`;

  pastArea.querySelectorAll("[data-open]").forEach(btn=>{
    btn.onclick=()=>{ location.hash = `#/match?code=${encodeURIComponent(btn.getAttribute("data-open"))}`; };
  });
}

async function renderMatchDetail(root, code) {
  const detail = root.querySelector("#matchDetailView");
  const list = root.querySelector("#matchListView");
  list.style.display = "none";
  detail.style.display = "block";

  const cached = lsGet(detailKey(code))?.data;
  let data = cached;

  const shouldFetch = isReloadForMatchCode(code) || !data?.ok;

  if (shouldFetch) {
    if (!data?.ok) {
      detail.innerHTML = `<div class="card"><div class="h1">Loading…</div><div class="small">Fetching match…</div></div>`;
    }

    const res = await API.getPublicMatch(code);
    if (!res.ok) {
      detail.innerHTML = `<div class="card"><div class="h1">Error</div><div class="small">${res.error}</div></div>`;
      return toastError(res.error||"Failed");
    }
    data = res;
    lsSet(detailKey(code), { ts: now(), data });
  }

  const m = data.match;
  const when = formatHumanDateTime(m.date, m.time);
  const status = String(m.status||"").toUpperCase();

  let availability = (data.availability || []).map(a=>({
    playerName: String(a.playerName||"").trim(),
    availability: String(a.availability||"").toUpperCase()
  })).filter(x=>x.playerName);

  function renderAvailLists() {
    const g = availabilityGroups(availability);
    detail.querySelector("#yesList").innerHTML = g.yes.map(p=>`<li>${p}</li>`).join("") || "<li>-</li>";
    detail.querySelector("#noList").innerHTML = g.no.map(p=>`<li>${p}</li>`).join("") || "<li>-</li>";
    detail.querySelector("#maybeList").innerHTML = g.maybe.map(p=>`<li>${p}</li>`).join("") || "<li>-</li>";
  }

  detail.innerHTML = `
    <div class="card">
      <div style="font-weight:950; font-size:18px">${m.title}</div>
      <div class="small" style="margin-top:6px">${when} • ${m.type} • ${m.status}</div>
      <div class="small" id="detailMsg" style="margin-top:10px">Refresh your browser to reload match details from the server.</div>
    </div>

    <div class="card">
      <div class="row" style="justify-content:space-between; align-items:center">
        <div class="h1">Availability</div>
        <div class="row" style="gap:10px; align-items:center">
          <button class="btn primary" id="shareBtn">Share</button>
          <button class="btn gray" id="refreshNamesBtn" title="Refresh names" style="padding:8px 10px;border-radius:12px">Refresh Players ↻</button>
        </div>
      </div>

      ${
        status === "OPEN"
          ? `
            <div class="small">Search your name, then select it from the list (only registered players are allowed).</div>
            <div style="position:relative; margin-top:10px">
              <input id="playerSearch" class="input"
                autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
                placeholder="Type to search players…" />
              <div id="playerDropdown"
                style="position:absolute; left:0; right:0; top:46px; z-index:50; display:none; max-height:220px; overflow:auto; border:1px solid rgba(11,18,32,0.12); background:#fff; border-radius:12px; box-shadow:0 10px 25px rgba(0,0,0,0.08)"></div>
            </div>


            <div class="row" style="margin-top:12px; gap:10px; flex-wrap:wrap">
              <button class="btn good" id="btnYes" disabled>YES</button>
              <button class="btn bad" id="btnNo" disabled>NO</button>
              <button class="btn warn" id="btnMaybe" disabled>MAYBE</button>
            </div>

            <div class="small" id="saveMsg" style="margin-top:10px"></div>
          `
          : `<div class="small">This match is not open.</div>`
      }

      <div class="hr"></div>

      <div class="small"><b>Available</b></div>
      <ol id="yesList" class="list"></ol>

      <div class="small" style="margin-top:10px"><b>Not available</b></div>
      <ol id="noList" class="list"></ol>

      <div class="small" style="margin-top:10px"><b>Maybe</b></div>
      <ol id="maybeList" class="list"></ol>
    </div>
  `;

  detail.querySelector("#shareBtn").onclick = () => {
    const msg = whatsappAvailabilityMessage(m, availability);
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, "_blank");
    toastInfo("WhatsApp opened.");
  };


renderAvailLists();
  const playerSearch = detail.querySelector("#playerSearch");
  const playerDropdown = detail.querySelector("#playerDropdown");
  const refreshNamesBtn = detail.querySelector("#refreshNamesBtn");

  let allPlayers = await getPlayersCached();
  let selectedPlayer = "";

  const esc = (s) => String(s || "")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#39;");

  function isValidPlayerName(name) {
    const n = String(name || "").trim();
    if (!n) return false;
    return (allPlayers || []).some(p => String(p).toLowerCase() === n.toLowerCase());
  }

  function setVoteEnabled(enabled) {
    const y = detail.querySelector("#btnYes");
    const n = detail.querySelector("#btnNo");
    const mb = detail.querySelector("#btnMaybe");
    if (y) y.disabled = !enabled;
    if (n) n.disabled = !enabled;
    if (mb) mb.disabled = !enabled;
  }

  function hideDropdown() {
    if (playerDropdown) playerDropdown.style.display = "none";
  }

  function showDropdown() {
    if (playerDropdown) playerDropdown.style.display = "block";
  }

  function renderDropdown(filterText) {
    if (!playerDropdown) return;
    const q = String(filterText || "").trim().toLowerCase();
    const items = (allPlayers || [])
      .filter(n => !q || String(n).toLowerCase().includes(q))
      .slice(0, 30);

    if (!items.length) {
      playerDropdown.innerHTML = `<div style="padding:10px" class="small">No matching players.</div>`;
      showDropdown();
      return;
    }

    playerDropdown.innerHTML = items.map(n => `
      <div class="playerOption" data-name="${esc(n)}"
           style="padding:10px; cursor:pointer; border-bottom:1px solid rgba(11,18,32,0.08)">
        ${esc(n)}
      </div>
    `).join("");

    playerDropdown.querySelectorAll(".playerOption").forEach(el => {
      el.onclick = () => {
        const name = el.getAttribute("data-name") || "";
        selectedPlayer = name;
        if (playerSearch) playerSearch.value = name;
        hideDropdown();
        setVoteEnabled(true);
      };
    });

    showDropdown();
  }

  // Disable until a valid selection is made
  setVoteEnabled(false);

  if (playerSearch) {
    playerSearch.addEventListener("focus", () => {
      renderDropdown(playerSearch.value);
    });

    playerSearch.addEventListener("input", () => {
      selectedPlayer = "";
      setVoteEnabled(false);

      const v = playerSearch.value || "";
      renderDropdown(v);

      // If exact match typed, accept it (still from list)
      if (isValidPlayerName(v)) {
        selectedPlayer =
          (allPlayers || []).find(p => String(p).toLowerCase() === String(v).trim().toLowerCase()) || v;
        setVoteEnabled(true);
      }
    });

    playerSearch.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const v = String(playerSearch.value || "").trim();
        if (isValidPlayerName(v)) {
          selectedPlayer = (allPlayers || []).find(p => String(p).toLowerCase() === v.toLowerCase()) || v;
          hideDropdown();
          setVoteEnabled(true);
        } else {
          toastWarn("Please choose a name from the list.");
        }
      }
      if (e.key === "Escape") hideDropdown();
    });

    // Close dropdown when clicking outside
    document.addEventListener("click", (e) => {
      const t = e.target;
      if (!t) return;
      const inside =
        playerSearch.contains(t) ||
        (playerDropdown && playerDropdown.contains(t));
      if (!inside) hideDropdown();
    }, { capture: true });
  }

  // Small refresh button near availability (requested)
  if (refreshNamesBtn) refreshNamesBtn.onclick = async () => {
    refreshNamesBtn.disabled = true;
    const fresh = await refreshPlayersCache();
    refreshNamesBtn.disabled = false;
    if (fresh && fresh.length) {
      allPlayers = fresh;

      const v = String(playerSearch?.value || "").trim();
      if (isValidPlayerName(v)) {
        selectedPlayer = (allPlayers || []).find(p => String(p).toLowerCase() === v.toLowerCase()) || v;
        setVoteEnabled(true);
      } else {
        selectedPlayer = "";
        setVoteEnabled(false);
      }

      if (playerSearch) renderDropdown(playerSearch.value);
      toastSuccess("Players list updated.");
    }
  };

  if (status !== "OPEN") return;


  async function submit(choice) {
    const playerName = String(selectedPlayer || playerSearch?.value || "").trim();
    if (!playerName) return toastWarn("Please select your name.");
    if (!isValidPlayerName(playerName)) return toastWarn("Please choose a name from the list.");

    const y = detail.querySelector("#btnYes");
    const n = detail.querySelector("#btnNo");
    const mb = detail.querySelector("#btnMaybe");
    y.disabled = true; n.disabled = true; mb.disabled = true;

    const saveMsg = detail.querySelector("#saveMsg");
    saveMsg.textContent = "Saving…";

    const res = await API.setAvailability(code, playerName, choice);

    if (!res.ok) {
      saveMsg.textContent = res.error || "Failed";
      toastError(res.error || "Failed to post availability");
      y.disabled = false; n.disabled = false; mb.disabled = false;
      return;
    }

    // Only update UI lists after backend save succeeds.
// Reload list from server so we always reflect latest (others may submit at the same time).
if (Array.isArray(res.availability)) {
  availability = res.availability.map(a=>({
    playerName: String(a.playerName||"").trim(),
    availability: String(a.availability||"").toUpperCase()
  })).filter(x=>x.playerName);
} else {
  // Fallback: keep local behavior if backend didn't return list
  const idx = availability.findIndex(a => a.playerName.toLowerCase() === playerName.toLowerCase());
  if (idx >= 0) availability[idx].availability = choice;
  else availability.push({ playerName, availability: choice });
}
renderAvailLists();


    saveMsg.textContent = "Saved ✅";
    toastSuccess(`Saved: ${choice}`);

    const merged = { ...data, availability };
    lsSet(detailKey(code), { ts: now(), data: merged });

    // const msg = whatsappAvailabilityMessage(m, availability);
    // window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, "_blank");
    // toastInfo("WhatsApp opened (tap Send).");

    setTimeout(()=>{ y.disabled=false; n.disabled=false; mb.disabled=false; }, 900);
  }

  detail.querySelector("#btnYes").onclick = () => submit("YES");
  detail.querySelector("#btnNo").onclick = () => submit("NO");
  detail.querySelector("#btnMaybe").onclick = () => submit("MAYBE");
}

export async function renderMatchPage(root, query) {
  ensureMatchMetaActivationListeners();
  renderShell(root);

  const code = query.get("code");
  if (code) {
    await renderMatchDetail(root, code);
    return;
  }

  const seasonsRes = await loadSeasons();
  if (!seasonsRes.ok) {
    toastError(seasonsRes.error || "Failed to load seasons");
    return;
  }

  const { seasons, selected } = pickSelectedSeason(seasonsRes);
  const seasonId = selected;

  const openCached = lsGet(openKey(seasonId));
  const openMatches = openCached?.matches || [];

  // Render immediately from cache.
  renderMatchList(root, seasonId, openMatches);

  // Re-fetch open matches ONLY when the user does a browser reload.
  // (Or when cache is empty for the first time.)
  const needInitial = !openMatches.length;
  // Reload open matches from API ONLY if the browser reload happened on the list view
  // (not when navigating back from a match detail).
  const shouldReloadFetch = isReloadForMatchList() || needInitial;
  if (shouldReloadFetch) {
    // If we already rendered cached data, refresh in the background.
    // If no cache, this will populate the list once it returns.
    API.publicOpenMatches(seasonId)
      .then(res => {
        if (!res?.ok) return;
        lsSet(openKey(seasonId), { ts: now(), matches: res.matches || [] });
        // Only update UI if we're still on list view for this season.
        if (!isMatchRouteActive()) return;
        const currentListVisible = root.querySelector("#matchListView")?.style?.display !== "none";
        const currentSeason = ACTIVE_MATCH?.seasonId || seasonId;
        if (currentListVisible && currentSeason === seasonId) {
          renderMatchList(root, seasonId, res.matches || []);
          prefetchOpenMatchDetails(res.matches || []);
        }
      })
      .catch(() => {});
  }

  // Save active refs for activation meta checks
  ACTIVE_MATCH.pageRoot = root;
  ACTIVE_MATCH.listRoot = root.querySelector('#matchListView');
  ACTIVE_MATCH.seasonId = seasonId;
  // Meta check only on initial load / tab enter (backend-friendly)
  setTimeout(() => scheduleMatchMetaCheck("load"), 0);

  // Prefetch details for all cached open matches immediately (background)
  prefetchOpenMatchDetails(openMatches);

  // inject season selector
  const seasonBlock = root.querySelector("#seasonBlock");
  seasonBlock.innerHTML = seasonsSelectHtml(seasons, seasonId);

  root.querySelector("#seasonSelect").onchange = () => {
    const sid = root.querySelector("#seasonSelect").value;
    localStorage.setItem(LS_SELECTED_SEASON, sid);
    const c = lsGet(openKey(sid));
    renderMatchList(root, sid, c?.matches || []);
    prefetchOpenMatchDetails(c?.matches || []);
    root.querySelector("#seasonBlock").innerHTML = seasonsSelectHtml(seasons, sid);

    // Update active season and run a single meta check for the new season.
    ACTIVE_MATCH.seasonId = sid;
    ACTIVE_MATCH.listRoot = root.querySelector('#matchListView');
    setTimeout(() => scheduleMatchMetaCheck("load"), 0);

    // If this season has no cached open matches yet, fetch once to populate.
    if (!(c?.matches && c.matches.length)) {
      API.publicOpenMatches(sid)
        .then(res => {
          if (!res?.ok) return;
          lsSet(openKey(sid), { ts: now(), matches: res.matches || [] });
          if (isMatchRouteActive() && ACTIVE_MATCH.seasonId === sid) {
            renderMatchList(root, sid, res.matches || []);
            prefetchOpenMatchDetails(res.matches || []);
          }
        })
        .catch(() => {});
    }
  };
}