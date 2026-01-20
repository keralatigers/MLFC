// src/pages/match.js
import { API } from "../api/endpoints.js";
import { toastSuccess, toastError, toastInfo, toastWarn } from "../ui/toast.js";

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

function scheduleMatchMetaCheck() {
  // throttle to avoid hammering slow API
  const t = now();
  if (t - MATCH_META_LAST_CHECK < 3000) return;
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

  // Runs when user navigates back to #/match (even if router skips re-render)
  window.addEventListener("hashchange", () => {
    setTimeout(scheduleMatchMetaCheck, 0);
  });
  // Runs when user switches back to the app/tab
  window.addEventListener("focus", () => setTimeout(scheduleMatchMetaCheck, 0));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) setTimeout(scheduleMatchMetaCheck, 0);
  });

  // Fallback: if your tab UI only hides/shows containers (no hash change),
  // this periodic check ensures we still detect new matches.
  setInterval(() => {
    if (isMatchRouteActive()) scheduleMatchMetaCheck();
  }, 4000);
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

async function checkMetaAndShowBanner(root, seasonId) {
  const prev = lsGet(metaKey(seasonId));
  const res = await API.publicMatchesMeta(seasonId);

  if (!res || res.ok !== true) {
    renderBanner(root, "");
    return;
  }

  const next = { ts: now(), fingerprint: res.fingerprint || "", latestCode: res.latestCode || "" };
  lsSet(metaKey(seasonId), next);

  if (!next.fingerprint) { renderBanner(root, ""); return; }

  const openCache = lsGet(openKey(seasonId));
  const openCodes = (openCache?.matches || []).map(m => m.publicCode);
  const missingLatest = next.latestCode && !openCodes.includes(next.latestCode);

  const changed = !prev || prev.fingerprint !== next.fingerprint;
  if (!changed && !missingLatest) {
    renderBanner(root, "");
    return;
  }

  renderBanner(root, `
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

  const up = root.querySelector("#metaUpdateBtn");
  if (up) up.onclick = async () => {
    up.disabled = true; up.textContent = "Updating…";

    // Prevent meta loop
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

    // Refresh UI
    renderMatchList(root, seasonId, out.matches || []);

    // Prefetch details for speed
    prefetchOpenMatchDetails(out.matches || []);

    toastSuccess("Open matches updated.");
  };

  const op = root.querySelector("#metaOpenBtn");
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
      <div class="small">Open matches load from cache. Tap Refresh if needed.</div>

      <div id="seasonBlock"></div>

      <div class="row" style="margin-top:10px; gap:10px; flex-wrap:wrap">
        <button class="btn primary" id="refreshOpen">Refresh Open</button>
        <button class="btn gray" id="clearMatchCache">Clear cache</button>
      </div>

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
      <div class="small" style="margin-top:8px">Cached after refresh.</div>
      <div class="row" style="margin-top:10px; gap:10px; flex-wrap:wrap">
        <button class="btn primary" id="refreshPast">Refresh Past</button>
      </div>
      <div id="pastArea" style="margin-top:10px"></div>
    </details>
  `;

  list.querySelectorAll("[data-open]").forEach(btn=>{
    btn.onclick=()=>{ location.hash = `#/match?code=${encodeURIComponent(btn.getAttribute("data-open"))}`; };
  });

  list.querySelector("#clearMatchCache").onclick = () => {
    lsDel(openKey(seasonId));
    lsDel(pastKey(seasonId));
    toastInfo("Match list cache cleared.");
    renderMatchList(root, seasonId, []);
  };

  list.querySelector("#refreshOpen").onclick = async () => {


    const btn = list.querySelector("#refreshOpen");
    setDisabled(btn,true,"Refreshing…");

    const res = await API.publicOpenMatches(seasonId);

    setDisabled(btn,false);
    if (!res.ok) return toastError(res.error||"Failed");

    lsSet(openKey(seasonId), { ts: now(), matches: res.matches||[] });

    renderMatchList(root, seasonId, res.matches||[]);

    prefetchOpenMatchDetails(res.matches || []);

    toastSuccess("Open matches refreshed.");
  };

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
    checkMetaAndShowBanner(list, seasonId).catch(()=>{});
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

  if (!data?.ok) {
    detail.innerHTML = `<div class="card"><div class="h1">Loading…</div><div class="small">Fetching match…</div></div>`;
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

      <div class="row" style="margin-top:12px; gap:10px; flex-wrap:wrap">
        <button class="btn gray" id="backBtn">Back</button>
        <button class="btn gray" id="refreshMatchBtn">Refresh match</button>
      </div>

      <div class="small" id="detailMsg" style="margin-top:10px"></div>
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
            <div class="small">Search and select your name, then tap YES / NO / MAYBE.</div>
            <div style="position:relative; margin-top:10px">
              <input id="playerNameInput" class="input" placeholder="Type your name..." autocomplete="off" />
              <div id="playerNameDropdown" style="position:absolute; left:0; right:0; top:calc(100% + 6px); max-height:240px; overflow:auto; background:#fff; border:1px solid rgba(11,18,32,0.12); border-radius:14px; box-shadow:0 10px 30px rgba(11,18,32,0.08); display:none; z-index:50"></div>
            </div>

            <div class="row" style="margin-top:12px; gap:10px; flex-wrap:wrap">
              <button class="btn good" id="btnYes">YES</button>
              <button class="btn bad" id="btnNo">NO</button>
              <button class="btn warn" id="btnMaybe">MAYBE</button>
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

  detail.querySelector("#backBtn").onclick = () => { location.hash = "#/match"; };

  detail.querySelector("#shareBtn").onclick = () => {
    const msg = whatsappAvailabilityMessage(m, availability);
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, "_blank");
    toastInfo("WhatsApp opened.");
  };

  detail.querySelector("#refreshMatchBtn").onclick = async () => {
    const msg = detail.querySelector("#detailMsg");
    msg.textContent = "Refreshing…";
    const res = await API.getPublicMatch(code);
    if (!res.ok) { msg.textContent = res.error || "Failed"; return toastError(res.error||"Failed"); }
    lsSet(detailKey(code), { ts: now(), data: res });
    toastSuccess("Match refreshed.");
    await renderMatchDetail(root, code);
  };

  renderAvailLists();
  const nameInput = detail.querySelector("#playerNameInput");
  const dropdown = detail.querySelector("#playerNameDropdown");
  const refreshNamesBtn = detail.querySelector("#refreshNamesBtn");

  let allPlayers = await getPlayersCached();

  function renderDropdown(filter="") {
    if (!dropdown) return;
    const f = String(filter||"").trim().toLowerCase();
    const list = (f ? allPlayers.filter(n=>n.toLowerCase().includes(f)) : allPlayers).slice(0, 40);
    if (!list.length) {
      dropdown.innerHTML = `<div class="small" style="padding:10px">No matches</div>`;
    } else {
      dropdown.innerHTML = list.map(n =>
        `<div data-p="${encodeURIComponent(n)}" style="padding:12px 12px; border-top:1px solid rgba(11,18,32,0.06); cursor:pointer">${n}</div>`
      ).join("");
      // remove first border
      const first = dropdown.firstElementChild;
      if (first) first.style.borderTop = "none";
    }
    dropdown.style.display = "block";

    dropdown.querySelectorAll("[data-p]").forEach(el => {
      el.onclick = () => {
        const val = decodeURIComponent(el.getAttribute("data-p"));
        if (nameInput) nameInput.value = val;
        dropdown.style.display = "none";
      };
    });
  }

  function hideDropdownSoon() {
    // delay so click can register
    setTimeout(() => { if (dropdown) dropdown.style.display = "none"; }, 160);
  }

  if (nameInput) {
    nameInput.addEventListener("focus", () => renderDropdown(nameInput.value));
    nameInput.addEventListener("input", () => renderDropdown(nameInput.value));
    nameInput.addEventListener("blur", hideDropdownSoon);
  }


  // Small refresh button near availability (requested)
  if (refreshNamesBtn) refreshNamesBtn.onclick = async () => {
    refreshNamesBtn.disabled = true;
    const fresh = await refreshPlayersCache();
    refreshNamesBtn.disabled = false;
    if (fresh && fresh.length) {
      allPlayers = fresh;
      renderDropdown(nameInput?.value || "");
    }
  };

  if (status !== "OPEN") return;

  async function submit(choice) {
    const playerName = String(nameInput?.value || "").trim();
    if (!playerName) return toastWarn("Type and select your name.");

    const y = detail.querySelector("#btnYes");
    const n = detail.querySelector("#btnNo");
    const mb = detail.querySelector("#btnMaybe");
    y.disabled = true; n.disabled = true; mb.disabled = true;

    const saveMsg = detail.querySelector("#saveMsg");
    saveMsg.textContent = "Saving…";

    const idx = availability.findIndex(a => a.playerName.toLowerCase() === playerName.toLowerCase());
    if (idx >= 0) availability[idx].availability = choice;
    else availability.push({ playerName, availability: choice });
    renderAvailLists();

    const res = await API.setAvailability(code, playerName, choice);

    if (!res.ok) {
      saveMsg.textContent = res.error || "Failed";
      toastError(res.error || "Failed to post availability");
      y.disabled = false; n.disabled = false; mb.disabled = false;
      return;
    }

    saveMsg.textContent = "Saved ✅";
    toastSuccess(`Saved: ${choice}`);

    const merged = { ...data, availability };
    lsSet(detailKey(code), { ts: now(), data: merged });

    const msg = whatsappAvailabilityMessage(m, availability);
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, "_blank");
    toastInfo("WhatsApp opened (tap Send).");

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

  renderMatchList(root, seasonId, openMatches);

  // Save active refs for activation meta checks
  ACTIVE_MATCH.pageRoot = root;
  ACTIVE_MATCH.listRoot = root.querySelector('#matchListView');
  ACTIVE_MATCH.seasonId = seasonId;
  // immediate check
  setTimeout(scheduleMatchMetaCheck, 0);

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
  };
}