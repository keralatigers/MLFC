import { API } from "../api/endpoints.js";
import { toastSuccess, toastError, toastInfo, toastWarn } from "../ui/toast.js";
import { cleanupCaches } from "../cache_cleanup.js";

const LS_ADMIN_KEY = "mlfc_adminKey";
const LS_ADMIN_MATCHES_CACHE = "mlfc_admin_matches_cache_ls_v1";
const LS_MANAGE_CACHE_PREFIX = "mlfc_manage_cache_ls_v1:";

const PAGE_SIZE = 20;

let MEM = {
  adminKey: null,
  matches: [],
  matchesTs: 0,
  lastManagedCode: null,
  lastManageData: null,
  lastManageTs: 0
};

function now() { return Date.now(); }
function baseUrl() { return location.href.split("#")[0]; }
function matchLink(publicCode) { return `${baseUrl()}#/match?code=${publicCode}`; }
function captainLink(publicCode, captainName) {
  return `${baseUrl()}#/captain?code=${publicCode}&captain=${encodeURIComponent(captainName)}`;
}
function waOpenPrefill(text) {
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
}

function lsGet(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}
function manageKey(code) { return `${LS_MANAGE_CACHE_PREFIX}${code}`; }
function getManageCache(code) {
  const obj = lsGet(manageKey(code));
  return obj?.data || null;
}
function setManageCache(code, data) {
  lsSet(manageKey(code), { ts: now(), data });
}

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

function getViewParams(query) {
  const view = (query.get("view") || "open").toLowerCase(); // open | past
  const page = Math.max(1, Number(query.get("page") || "1"));
  return { view, page };
}

function loadMatchesFromLocal() {
  const cached = lsGet(LS_ADMIN_MATCHES_CACHE);
  if (cached?.matches && Array.isArray(cached.matches)) {
    MEM.matches = cached.matches;
    MEM.matchesTs = cached.ts || 0;
  }
}

async function refreshMatchesFromApi() {
  const adminKey = MEM.adminKey || localStorage.getItem(LS_ADMIN_KEY);
  if (!adminKey) return { ok: false, error: "Missing admin key" };
  MEM.adminKey = adminKey;

  const res = await API.adminListMatches(adminKey);
  if (!res.ok) return res;

  MEM.matches = res.matches || [];
  MEM.matchesTs = now();
  lsSet(LS_ADMIN_MATCHES_CACHE, { ts: MEM.matchesTs, matches: MEM.matches });
  return { ok: true, matches: MEM.matches };
}

function formatAdminMatches(matches, view) {
  const open = (matches || []).filter(m => String(m.status || "").toUpperCase() === "OPEN");
  open.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));

  const past = (matches || []).filter(m => String(m.status || "").toUpperCase() !== "OPEN");
  past.sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));

  return view === "past" ? past : open;
}

function adminNavHtml(view) {
  const openActive = view === "open" ? "primary" : "gray";
  const pastActive = view === "past" ? "primary" : "gray";
  return `
    <div class="row" style="margin-top:10px">
      <button class="btn ${openActive}" id="goOpen">Open matches</button>
      <button class="btn ${pastActive}" id="goPast">Past matches</button>
    </div>
  `;
}

function renderLogin(root) {
  root.innerHTML = `
    <div class="card">
      <div class="h1">Admin</div>
      <div class="small">Enter admin key once. It will be remembered on this device.</div>
      <input id="key" class="input" placeholder="Admin key" style="margin-top:10px" />
      <div class="row" style="margin-top:10px">
        <button id="login" class="btn primary">Login</button>
        <button id="clear" class="btn gray">Clear key</button>
      </div>
      <div id="msg" class="small" style="margin-top:10px"></div>
    </div>
  `;

  const keyEl = root.querySelector("#key");
  const msgEl = root.querySelector("#msg");
  keyEl.value = localStorage.getItem(LS_ADMIN_KEY) || "";

  root.querySelector("#clear").onclick = () => {
    localStorage.removeItem(LS_ADMIN_KEY);
    localStorage.removeItem(LS_ADMIN_MATCHES_CACHE);
    toastInfo("Admin key cleared.");
    msgEl.textContent = "Cleared.";
  };

  root.querySelector("#login").onclick = async () => {
    const adminKey = keyEl.value.trim();
    if (!adminKey) { toastWarn("Enter admin key"); return; }
    setDisabled(root.querySelector("#login"), true, "Logging…");
    msgEl.textContent = "Logging in…";

    const res = await API.adminListMatches(adminKey);
    setDisabled(root.querySelector("#login"), false);

    if (!res.ok) {
      msgEl.textContent = res.error || "Unauthorized";
      toastError(res.error || "Unauthorized");
      return;
    }

    localStorage.setItem(LS_ADMIN_KEY, adminKey);
    MEM.adminKey = adminKey;
    MEM.matches = res.matches || [];
    MEM.matchesTs = now();
    lsSet(LS_ADMIN_MATCHES_CACHE, { ts: MEM.matchesTs, matches: MEM.matches });

    toastSuccess("Logged in.");
    renderAdminShell(root);
  };
}

function renderAdminShell(root) {
  const query = new URLSearchParams(location.hash.split("?")[1] || "");
  const { view, page } = getViewParams(query);

  root.innerHTML = `
    <div class="card">
      <div class="h1">Admin</div>
      <div class="row" style="margin-top:10px">
        <button id="refresh" class="btn primary">Refresh</button>
        <button id="logout" class="btn gray">Logout</button>
      </div>
      ${adminNavHtml(view)}
      <div class="small" id="msg" style="margin-top:10px"></div>
    </div>
    <div id="adminArea"></div>
  `;

  root.querySelector("#logout").onclick = () => {
    localStorage.removeItem(LS_ADMIN_KEY);
    toastInfo("Logged out.");
    renderLogin(root);
  };

  root.querySelector("#refresh").onclick = async () => {
    const btn = root.querySelector("#refresh");
    const msg = root.querySelector("#msg");
    setDisabled(btn, true, "Refreshing…");
    msg.textContent = "Refreshing…";

    const res = await refreshMatchesFromApi();

    setDisabled(btn, false);
    msg.textContent = "";

    if (!res.ok) {
      toastError(res.error || "Failed to refresh");
      return;
    }

    toastSuccess("Refreshed.");
    renderAdminArea(root.querySelector("#adminArea"), view, page);
  };

  root.querySelector("#goOpen").onclick = () => { location.hash = "#/admin"; };
  root.querySelector("#goPast").onclick = () => { location.hash = "#/admin?view=past&page=1"; };

  renderAdminArea(root.querySelector("#adminArea"), view, page);
}

function createMatchHtml() {
  return `
    <div class="card" id="createCard">
      <div class="h1">Create match</div>
      <input id="title" class="input" placeholder="Title" />
      <input id="date" class="input" type="date" style="margin-top:10px" />
      <input id="time" class="input" type="time" value="19:00" style="margin-top:10px" />
      <select id="type" class="input" style="margin-top:10px">
        <option value="INTERNAL" selected>Internal (Blue vs Orange)</option>
        <option value="OPPONENT">Against opponents (1 captain)</option>
      </select>
      <button id="create" class="btn primary" style="margin-top:10px">Create</button>
      <div id="created" class="small" style="margin-top:10px"></div>
    </div>
  `;
}

function pastPagerHtml(page, hasMore, total) {
  const prevDisabled = page <= 1 ? "disabled" : "";
  const nextDisabled = !hasMore ? "disabled" : "";
  return `
    <div class="row" style="margin-top:12px">
      <button class="btn gray" id="prevPage" ${prevDisabled}>Prev</button>
      <button class="btn gray" id="nextPage" ${nextDisabled}>Next</button>
    </div>
    <div class="small" style="margin-top:8px">Page ${page} • Total ${total}</div>
  `;
}

function matchRowHtml(m) {
  const status = String(m.status || "").toUpperCase();
  const locked = String(m.ratingsLocked || "").toUpperCase() === "TRUE";

  const isOpen = status === "OPEN";
  const isCompleted = status === "COMPLETED";
  const isEditLocked = locked || status === "CLOSED" || isCompleted;

  // Rules you requested
  const disableManage = isEditLocked;
  const disableLock = locked || isCompleted;

  return `
    <div style="padding:10px 0; border-bottom:1px solid #eee">
      <div class="row" style="justify-content:space-between">
        <div style="min-width:0">
          <div style="font-weight:950; color: rgba(11,18,32,0.92)">
            ${m.title}
          </div>
          <div class="small">${m.date} ${m.time} • ${m.type}</div>
        </div>
        <div class="row" style="gap:6px">
          <span class="badge">${m.status}</span>
          ${locked ? `<span class="badge badge--bad">LOCKED</span>` : ""}
        </div>
      </div>

      <div class="row" style="margin-top:8px; flex-wrap:wrap">
        <button
          class="btn gray"
          data-manage="${m.publicCode}"
          ${disableManage ? "disabled" : ""}
        >
          Manage
        </button>

        ${
          /* ONLY show for OPEN matches */
          isOpen
            ? `<button class="btn gray" data-close="${m.matchId}">
                 Close availability
               </button>`
            : ""
        }

        <button
          class="btn gray"
          data-lock="${m.matchId}"
          ${disableLock ? "disabled" : ""}
        >
          Lock ratings
        </button>

        ${
          isEditLocked
            ? `<button class="btn gray" data-unlock="${m.matchId}">
                 Unlock match
               </button>`
            : ""
        }
      </div>
    </div>
  `;
}



function renderAdminArea(adminArea, view, page) {
  const showCreate = (view === "open");
  const matches = formatAdminMatches(MEM.matches, view);

  const total = matches.length;
  const start = (page - 1) * PAGE_SIZE;
  const items = matches.slice(start, start + PAGE_SIZE);
  const hasMore = (start + PAGE_SIZE) < total;

  adminArea.innerHTML = `
    ${showCreate ? createMatchHtml() : ""}

    <div class="card">
      <div class="h1">${view === "past" ? "Past matches" : "Open matches"}</div>
      <div class="small">${view === "past" ? "Manage old matches here." : "Only matches seeking availability are shown here."}</div>

      <div id="matchesList" style="margin-top:10px">
        ${items.length ? items.map(m => matchRowHtml(m)).join("") : `<div class="small" style="margin-top:10px">No matches.</div>`}
      </div>

      ${view === "past" ? pastPagerHtml(page, hasMore, total) : ""}
    </div>

    <div id="manageArea"></div>
  `;

  if (showCreate) bindCreateMatch(adminArea);

  bindListButtons(adminArea);

  // restore manage if cached
  if (MEM.lastManagedCode) {
    const manageArea = adminArea.querySelector("#manageArea");
    const cached = getManageCache(MEM.lastManagedCode) || MEM.lastManageData;
    if (cached) renderManageView(manageArea, cached);
  }
}

function bindCreateMatch(adminArea) {
  adminArea.querySelector("#create").onclick = async () => {
    const btn = adminArea.querySelector("#create");
    setDisabled(btn, true, "Creating…");

    const payload = {
      title: adminArea.querySelector("#title").value.trim() || "Weekly Match",
      date: adminArea.querySelector("#date").value,
      time: adminArea.querySelector("#time").value || "19:00",
      type: adminArea.querySelector("#type").value
    };

    const out = await API.adminCreateMatch(MEM.adminKey, payload);
    setDisabled(btn, false);

    const created = adminArea.querySelector("#created");
    if (!out.ok) {
      created.textContent = out.error || "Failed";
      toastError(out.error || "Failed to create match");
      return;
    }

    toastSuccess("Match created.");
    const link = matchLink(out.publicCode);

    created.innerHTML = `
      Created ✅<br/>
      <div class="small">Public match link:</div>
      <div style="word-break:break-all">${link}</div>
      <button class="btn primary" id="shareNew" style="margin-top:10px">Share to WhatsApp</button>
    `;

    adminArea.querySelector("#shareNew").onclick = () => {
      waOpenPrefill(`Manor Lakes FC match link:\n${link}`);
      toastInfo("WhatsApp opened.");
    };

    // Explicit action => refresh cache from API
    const res = await refreshMatchesFromApi();
    if (!res.ok) toastError(res.error || "Refresh failed");
    renderAdminArea(adminArea, "open", 1);
  };
}

function bindListButtons(adminArea) {
  const query = new URLSearchParams(location.hash.split("?")[1] || "");
  const { view, page } = getViewParams(query);

  // pager
  if (view === "past") {
    const prev = adminArea.querySelector("#prevPage");
    const next = adminArea.querySelector("#nextPage");
    if (prev) prev.onclick = () => location.hash = `#/admin?view=past&page=${Math.max(1, page - 1)}`;
    if (next) next.onclick = () => location.hash = `#/admin?view=past&page=${page + 1}`;
  }

  // manage
 adminArea.querySelectorAll("[data-manage]:not([disabled])").forEach(btn => {
    btn.onclick = async () => {
      const code = btn.getAttribute("data-manage");
      const manageArea = adminArea.querySelector("#manageArea");
      MEM.lastManagedCode = code;

      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Opening…";

      try {
        const cached = getManageCache(code) || MEM.lastManageData;
        if (cached) renderManageView(manageArea, cached);
        else manageArea.innerHTML = `<div class="card"><div class="h1">Loading match…</div></div>`;

        const fresh = await API.getPublicMatch(code);
        if (!fresh.ok) {
          toastError(fresh.error || "Failed to load match");
          if (!cached) manageArea.innerHTML = `<div class="card"><div class="h1">Error</div><div class="small">${fresh.error}</div></div>`;
          return;
        }

        setManageCache(code, fresh);
        MEM.lastManageData = fresh;
        MEM.lastManageTs = now();
        renderManageView(manageArea, fresh);
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    };
  });

  // close/lock/unlock
  adminArea.querySelectorAll("[data-close]").forEach(btn => {
    btn.onclick = async () => {
      const matchId = btn.getAttribute("data-close");
      setDisabled(btn, true, "Closing…");
      const out = await API.adminCloseMatch(MEM.adminKey, matchId);
      setDisabled(btn, false);
      if (!out.ok) { toastError(out.error || "Failed"); return; }
      toastSuccess("Availability closed.");
      const res = await refreshMatchesFromApi();
      if (!res.ok) toastError(res.error || "Refresh failed");
      renderAdminArea(adminArea, view, page);
    };
  });

  adminArea.querySelectorAll("[data-lock]:not([disabled])").forEach(btn => {
    btn.onclick = async () => {
      const matchId = btn.getAttribute("data-lock");
      setDisabled(btn, true, "Locking…");
      const out = await API.adminLockRatings(MEM.adminKey, matchId);
      setDisabled(btn, false);
      if (!out.ok) { toastError(out.error || "Failed"); return; }
      toastSuccess("Ratings locked.");
      const res = await refreshMatchesFromApi();
      if (!res.ok) toastError(res.error || "Refresh failed");
      renderAdminArea(adminArea, view, page);
    };
  });

  adminArea.querySelectorAll("[data-unlock]").forEach(btn => {
    btn.onclick = async () => {
      const matchId = btn.getAttribute("data-unlock");
      setDisabled(btn, true, "Unlocking…");
      const out = await API.adminUnlockMatch(MEM.adminKey, matchId);
      setDisabled(btn, false);
      if (!out.ok) { toastError(out.error || "Failed"); return; }
      toastSuccess("Match unlocked.");
      const res = await refreshMatchesFromApi();
      if (!res.ok) toastError(res.error || "Refresh failed");
      renderAdminArea(adminArea, view, page);
    };
  });
}

/* Minimal manage renderer: reuse your existing internal/opponent logic from earlier versions if desired.
   For brevity, this one shows the same behavior you requested: captain links only after saving setup.
*/
function renderManageView(manageArea, data) {
  const m = data.match;
  const status = String(m.status || "").toUpperCase();
  const locked = String(m.ratingsLocked || "").toUpperCase() === "TRUE";
  const isEditLocked = locked || status === "CLOSED" || status === "COMPLETED";
  const type = String(m.type || "").toUpperCase();

  const availability = data.availability || [];
  const yesPlayers = uniqueSorted(availability.filter(a => String(a.availability).toUpperCase() === "YES").map(a => a.playerName));
  const captains = data.captains || {};
  const teams = data.teams || [];

  const header = `
    <div class="card">
      <div class="h1">Manage: ${m.title}</div>
      <div class="row">
        <span class="badge">${m.type}</span>
        <span class="badge">${m.status}</span>
        ${locked ? `<span class="badge badge--bad">LOCKED</span>` : `<span class="badge badge--good">EDITABLE</span>`}
      </div>
      <div class="small" style="margin-top:10px">Match link:</div>
      <div class="small" style="word-break:break-all">${matchLink(m.publicCode)}</div>

      <div class="row" style="margin-top:12px">
        <button class="btn primary" id="shareMatch">Share match link</button>
        ${isEditLocked ? `<button class="btn gray" id="unlockBtn">Unlock match</button>` : ""}
      </div>
    </div>
  `;

  if (type === "OPPONENT") {
    const cap = String(captains.captain1 || "");
    const opts = yesPlayers.map(p => `<option value="${p}">${p}</option>`).join("");
    const capUrl = cap ? captainLink(m.publicCode, cap) : "";

    manageArea.innerHTML = `
      ${header}
      <div class="card">
        <div class="h1">Captain</div>
        <select id="captainSel" class="input" ${isEditLocked ? "disabled" : ""}>
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

        <div class="row" style="margin-top:12px">
          <button class="btn primary" id="lockRatings" ${locked ? "disabled" : ""}>Lock ratings</button>
        </div>
        <div class="small" id="msg" style="margin-top:10px"></div>
      </div>
    `;

    manageArea.querySelector("#shareMatch").onclick = () => {
      waOpenPrefill(`Manor Lakes FC match link:\n${matchLink(m.publicCode)}`);
      toastInfo("WhatsApp opened.");
    };

    if (isEditLocked) {
      manageArea.querySelector("#unlockBtn").onclick = async () => {
        const btn = manageArea.querySelector("#unlockBtn");
        setDisabled(btn, true, "Unlocking…");
        const out = await API.adminUnlockMatch(MEM.adminKey, m.matchId);
        setDisabled(btn, false);
        if (!out.ok) { toastError(out.error || "Failed"); return; }
        toastSuccess("Unlocked.");
        const fresh = await API.getPublicMatch(m.publicCode);
        if (fresh.ok) {
          setManageCache(m.publicCode, fresh);
          MEM.lastManageData = fresh;
          renderManageView(manageArea, fresh);
        }
      };
    }

    const capSel = manageArea.querySelector("#captainSel");
    capSel.value = cap || "";

    manageArea.querySelector("#saveCap").onclick = async () => {
      const btn = manageArea.querySelector("#saveCap");
      const msg = manageArea.querySelector("#msg");
      const sel = capSel.value.trim();
      if (!sel) { toastWarn("Select a captain"); return; }

      setDisabled(btn, true, "Saving…");
      msg.textContent = "Saving…";
      const out = await API.adminSetupOpponent(MEM.adminKey, { matchId: m.matchId, captain: sel });
      setDisabled(btn, false);

      if (!out.ok) { msg.textContent = out.error || "Failed"; toastError(out.error || "Failed"); return; }
      msg.textContent = "Saved ✅";
      toastSuccess("Captain saved.");

      const fresh = await API.getPublicMatch(m.publicCode);
      if (fresh.ok) {
        setManageCache(m.publicCode, fresh);
        MEM.lastManageData = fresh;
        renderManageView(manageArea, fresh);
      }
    };

    const shareBtn = manageArea.querySelector("#shareCap");
    if (shareBtn) {
      shareBtn.onclick = () => {
        waOpenPrefill(`Captain link:\n${capUrl}`);
        toastInfo("WhatsApp opened.");
      };
    }

    manageArea.querySelector("#lockRatings").onclick = async () => {
      const btn = manageArea.querySelector("#lockRatings");
      setDisabled(btn, true, "Locking…");
      const out = await API.adminLockRatings(MEM.adminKey, m.matchId);
      setDisabled(btn, false);
      if (!out.ok) { toastError(out.error || "Failed"); return; }
      toastSuccess("Ratings locked.");
      const res = await refreshMatchesFromApi();
      if (!res.ok) toastError(res.error || "Refresh failed");

      const fresh = await API.getPublicMatch(m.publicCode);
      if (fresh.ok) {
        setManageCache(m.publicCode, fresh);
        MEM.lastManageData = fresh;
        renderManageView(manageArea, fresh);
      }
    };

    return;
  }

  // INTERNAL minimal: show save => then show captain links after save
  let blue = uniqueSorted(teams.filter(t => t.team === "BLUE").map(t => t.playerName));
  let orange = uniqueSorted(teams.filter(t => t.team === "ORANGE").map(t => t.playerName));
  let captainBlue = String(captains.captain1 || "");
  let captainOrange = String(captains.captain2 || "");

  const hasSavedSetup = (blue.length + orange.length) > 0 && !!captainBlue && !!captainOrange;
  const blueUrl = hasSavedSetup ? captainLink(m.publicCode, captainBlue) : "";
  const orangeUrl = hasSavedSetup ? captainLink(m.publicCode, captainOrange) : "";

  manageArea.innerHTML = `
    ${header}
    <div class="card">
      <div class="h1">Internal setup</div>
      <div class="small">Use your existing internal team UI here (table + lists).</div>
      <div class="small">This admin.js stores caches in Application Storage now.</div>

      <div class="hr"></div>

      <div class="h1">Captain links</div>
      ${
        hasSavedSetup
          ? `
            <div class="row" style="justify-content:space-between; align-items:flex-start">
              <div style="flex:1; min-width:0">
                <div class="small"><b>Blue:</b> ${captainBlue}</div>
                <div class="small" style="word-break:break-all">${blueUrl}</div>
              </div>
              <button class="btn primary" id="shareBlue">Share</button>
            </div>
            <div class="hr"></div>
            <div class="row" style="justify-content:space-between; align-items:flex-start">
              <div style="flex:1; min-width:0">
                <div class="small"><b>Orange:</b> ${captainOrange}</div>
                <div class="small" style="word-break:break-all">${orangeUrl}</div>
              </div>
              <button class="btn primary" id="shareOrange">Share</button>
            </div>
          `
          : `<div class="small">Save setup to generate captain links.</div>`
      }
    </div>
  `;

  manageArea.querySelector("#shareMatch").onclick = () => {
    waOpenPrefill(`Manor Lakes FC match link:\n${matchLink(m.publicCode)}`);
    toastInfo("WhatsApp opened.");
  };

  if (isEditLocked) {
    manageArea.querySelector("#unlockBtn").onclick = async () => {
      const btn = manageArea.querySelector("#unlockBtn");
      setDisabled(btn, true, "Unlocking…");
      const out = await API.adminUnlockMatch(MEM.adminKey, m.matchId);
      setDisabled(btn, false);
      if (!out.ok) { toastError(out.error || "Failed"); return; }
      toastSuccess("Unlocked.");
      const fresh = await API.getPublicMatch(m.publicCode);
      if (fresh.ok) {
        setManageCache(m.publicCode, fresh);
        MEM.lastManageData = fresh;
        renderManageView(manageArea, fresh);
      }
    };
  }

  const shareBlue = manageArea.querySelector("#shareBlue");
  if (shareBlue) shareBlue.onclick = () => { waOpenPrefill(`Blue captain link:\n${blueUrl}`); toastInfo("WhatsApp opened."); };

  const shareOrange = manageArea.querySelector("#shareOrange");
  if (shareOrange) shareOrange.onclick = () => { waOpenPrefill(`Orange captain link:\n${orangeUrl}`); toastInfo("WhatsApp opened."); };
}

export async function renderAdminPage(root) {
  cleanupCaches();

  const key = localStorage.getItem(LS_ADMIN_KEY);
  if (!key) {
    renderLogin(root);
    return;
  }
  MEM.adminKey = key;

  // Load cached matches from localStorage once; no API call unless Refresh/action
  if (!MEM.matches.length) loadMatchesFromLocal();

  renderAdminShell(root);
}
