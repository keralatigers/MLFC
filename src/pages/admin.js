import { API } from "../api/endpoints.js";
import { toastSuccess, toastError, toastInfo, toastWarn } from "../ui/toast.js";

const LS_ADMIN_KEY = "mlfc_adminKey";
const SS_ADMIN_MATCHES_CACHE = "mlfc_admin_matches_cache_v6";
const SS_MANAGE_CACHE_PREFIX = "mlfc_manage_cache_v6:";

const PAGE_SIZE = 20;

let MEM = {
  adminKey: null,
  matches: [],
  matchesTs: 0,
  // manage cache in memory
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

function readSessionJson(key) {
  try { return JSON.parse(sessionStorage.getItem(key) || "null"); } catch { return null; }
}
function writeSessionJson(key, obj) {
  try { sessionStorage.setItem(key, JSON.stringify(obj)); } catch {}
}

function manageKey(code) { return `${SS_MANAGE_CACHE_PREFIX}${code}`; }

function readManageCache(code) {
  const obj = readSessionJson(manageKey(code));
  if (!obj?.data) return null;
  return obj.data;
}
function writeManageCache(code, data) {
  writeSessionJson(manageKey(code), { ts: now(), data });
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

async function apiRefreshMatches() {
  const adminKey = MEM.adminKey || localStorage.getItem(LS_ADMIN_KEY);
  if (!adminKey) return { ok: false, error: "Missing admin key" };
  MEM.adminKey = adminKey;

  const res = await API.adminListMatches(adminKey);
  if (!res.ok) return res;

  MEM.matches = res.matches || [];
  MEM.matchesTs = now();
  writeSessionJson(SS_ADMIN_MATCHES_CACHE, { ts: MEM.matchesTs, matches: MEM.matches });
  return { ok: true, matches: MEM.matches };
}

function loadMatchesFromCache() {
  const ss = readSessionJson(SS_ADMIN_MATCHES_CACHE);
  if (ss?.matches && Array.isArray(ss.matches)) {
    MEM.matches = ss.matches;
    MEM.matchesTs = ss.ts || 0;
  }
}

function formatAdminMatches(matches, view) {
  const open = (matches || []).filter(m => String(m.status || "").toUpperCase() === "OPEN");
  // latest open on top = by soonest time (or you can use createdAt)
  open.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));

  const past = (matches || []).filter(m => String(m.status || "").toUpperCase() !== "OPEN");
  // most recent past first
  past.sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));

  return view === "past" ? past : open;
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
    sessionStorage.removeItem(SS_ADMIN_MATCHES_CACHE);
    MEM = { adminKey: null, matches: [], matchesTs: 0, lastManagedCode: null, lastManageData: null, lastManageTs: 0 };
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
    writeSessionJson(SS_ADMIN_MATCHES_CACHE, { ts: MEM.matchesTs, matches: MEM.matches });

    toastSuccess("Logged in.");
    renderAdminShell(root);
  };
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

function renderAdminShell(root) {
  const url = new URL(location.href);
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
    const msgEl = root.querySelector("#msg");
    setDisabled(btn, true, "Refreshing…");
    msgEl.textContent = "Refreshing…";

    const res = await apiRefreshMatches();

    setDisabled(btn, false);
    msgEl.textContent = "";

    if (!res.ok) {
      toastError(res.error || "Failed to refresh");
      return;
    }
    toastSuccess("Refreshed.");
    renderAdminArea(root.querySelector("#adminArea"), view, page);
  };

  root.querySelector("#goOpen").onclick = () => {
    location.hash = "#/admin";
  };
  root.querySelector("#goPast").onclick = () => {
    location.hash = "#/admin?view=past&page=1";
  };

  renderAdminArea(root.querySelector("#adminArea"), view, page);
}

function renderAdminArea(adminArea, view, page) {
  // No API calls here unless user clicks Refresh / action buttons
  const matches = formatAdminMatches(MEM.matches, view);

  // pagination for past
  const total = matches.length;
  const start = (page - 1) * PAGE_SIZE;
  const items = matches.slice(start, start + PAGE_SIZE);
  const hasMore = (start + PAGE_SIZE) < total;

  const showCreate = (view === "open");

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
  bindMatchRowButtons(adminArea);

  // restore manage view if opened
  if (MEM.lastManagedCode) {
    const manageArea = adminArea.querySelector("#manageArea");
    const cached = readManageCache(MEM.lastManagedCode) || MEM.lastManageData;
    if (cached) renderManageView(manageArea, cached);
  }
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

function createMatchHtml() {
  // INTERNAL selected by default, time default 19:00
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
      toastInfo("WhatsApp opened with match link.");
    };

    // Refresh matches in cache immediately after creation (explicit action)
    const res = await apiRefreshMatches();
    if (!res.ok) toastError(res.error || "Could not refresh matches");
    // Stay in open view
    renderAdminArea(adminArea, "open", 1);
  };
}

function matchRowHtml(m) {
  const status = String(m.status || "").toUpperCase();
  const locked = String(m.ratingsLocked || "").toUpperCase() === "TRUE";
  const canClose = status === "OPEN";
  const isEditLocked = locked || status === "CLOSED" || status === "COMPLETED";

  return `
    <div style="padding:10px 0; border-bottom:1px solid #eee">
      <div class="row" style="justify-content:space-between">
        <div style="min-width:0">
          <div style="font-weight:950; color: rgba(11,18,32,0.92)">${m.title}</div>
          <div class="small">${m.date} ${m.time} • ${m.type}</div>
        </div>
        <div class="row" style="gap:6px">
          <span class="badge">${m.status}</span>
          ${locked ? `<span class="badge badge--bad">LOCKED</span>` : ""}
        </div>
      </div>

      <div class="row" style="margin-top:8px">
        <button class="btn gray" data-manage="${m.publicCode}">Manage</button>
        ${canClose ? `<button class="btn gray" data-close="${m.matchId}">Close availability</button>` : `<span class="badge">Availability closed</span>`}
        <button class="btn gray" data-lock="${m.matchId}">Lock ratings</button>
        ${isEditLocked ? `<button class="btn gray" data-unlock="${m.matchId}">Unlock match</button>` : ""}
      </div>
    </div>
  `;
}

function bindMatchRowButtons(adminArea) {
  // Past view pager
  const query = new URLSearchParams(location.hash.split("?")[1] || "");
  const { view, page } = getViewParams(query);

  if (view === "past") {
    const prev = adminArea.querySelector("#prevPage");
    const next = adminArea.querySelector("#nextPage");
    if (prev) prev.onclick = () => location.hash = `#/admin?view=past&page=${Math.max(1, page - 1)}`;
    if (next) next.onclick = () => location.hash = `#/admin?view=past&page=${page + 1}`;
  }

  // Manage
  adminArea.querySelectorAll("[data-manage]").forEach(btn => {
    btn.onclick = async () => {
      const code = btn.getAttribute("data-manage");
      const manageArea = adminArea.querySelector("#manageArea");
      MEM.lastManagedCode = code;

      // Disable briefly but always restore (prevents "Opening…" stuck)
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Opening…";

      try {
        const cached = readManageCache(code) || (MEM.lastManageData && MEM.lastManagedCode === code ? MEM.lastManageData : null);
        if (cached) renderManageView(manageArea, cached);
        else manageArea.innerHTML = `<div class="card"><div class="h1">Loading match…</div></div>`;

        // IMPORTANT: do NOT auto reload the match again on tab switch; only load now when clicked
        const fresh = await API.getPublicMatch(code);
        if (!fresh.ok) {
          toastError(fresh.error || "Failed to load match");
          if (!cached) manageArea.innerHTML = `<div class="card"><div class="h1">Error</div><div class="small">${fresh.error}</div></div>`;
          return;
        }

        writeManageCache(code, fresh);
        MEM.lastManageData = fresh;
        MEM.lastManageTs = now();
        renderManageView(manageArea, fresh);
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    };
  });

  // Close availability
  adminArea.querySelectorAll("[data-close]").forEach(btn => {
    btn.onclick = async () => {
      const matchId = btn.getAttribute("data-close");
      setDisabled(btn, true, "Closing…");
      const out = await API.adminCloseMatch(MEM.adminKey, matchId);
      setDisabled(btn, false);

      if (!out.ok) { toastError(out.error || "Failed"); return; }
      toastSuccess("Availability closed.");

      const res = await apiRefreshMatches();
      if (!res.ok) toastError(res.error || "Refresh failed");
      // re-render current view
      const q = new URLSearchParams(location.hash.split("?")[1] || "");
      const { view, page } = getViewParams(q);
      renderAdminArea(adminArea, view, page);
    };
  });

  // Lock ratings
  adminArea.querySelectorAll("[data-lock]").forEach(btn => {
    btn.onclick = async () => {
      const matchId = btn.getAttribute("data-lock");
      setDisabled(btn, true, "Locking…");
      const out = await API.adminLockRatings(MEM.adminKey, matchId);
      setDisabled(btn, false);

      if (!out.ok) { toastError(out.error || "Failed"); return; }
      toastSuccess("Ratings locked.");

      const res = await apiRefreshMatches();
      if (!res.ok) toastError(res.error || "Refresh failed");
      const q = new URLSearchParams(location.hash.split("?")[1] || "");
      const { view, page } = getViewParams(q);
      renderAdminArea(adminArea, view, page);
    };
  });

  // Unlock
  adminArea.querySelectorAll("[data-unlock]").forEach(btn => {
    btn.onclick = async () => {
      const matchId = btn.getAttribute("data-unlock");
      setDisabled(btn, true, "Unlocking…");
      const out = await API.adminUnlockMatch(MEM.adminKey, matchId);
      setDisabled(btn, false);

      if (!out.ok) { toastError(out.error || "Failed"); return; }
      toastSuccess("Match unlocked.");

      const res = await apiRefreshMatches();
      if (!res.ok) toastError(res.error || "Refresh failed");
      const q = new URLSearchParams(location.hash.split("?")[1] || "");
      const { view, page } = getViewParams(q);
      renderAdminArea(adminArea, view, page);
    };
  });
}

/* ---------------- Manage View ---------------- */

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

      <div class="small" style="margin-top:10px">
        ${isEditLocked ? "Edits are locked. Unlock to edit teams/captains." : "Edits allowed."}
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
        <div class="h1">Captain (Opponent match)</div>
        <div class="small">Captain enters ratings for OUR players.</div>

        <select id="captainSel" class="input" style="margin-top:10px" ${isEditLocked ? "disabled" : ""}>
          <option value="">Select captain</option>
          ${opts}
        </select>

        <div class="row" style="margin-top:10px">
          <button id="saveCap" class="btn primary" ${isEditLocked ? "disabled" : ""}>Save captain</button>
        </div>

        <div class="hr"></div>

        <div class="h1">Captain link</div>
        ${
          cap
            ? `
            <div class="row" style="align-items:flex-start; justify-content:space-between">
              <div class="small" style="word-break:break-all; flex:1">${capUrl}</div>
              <button class="btn primary" id="shareCap">Share</button>
            </div>
          `
            : `<div class="small">Save captain to generate link.</div>`
        }

        <div class="row" style="margin-top:12px">
          <button id="closeAvail" class="btn gray" ${status === "OPEN" ? "" : "disabled"}>Close availability</button>
          <button id="lockRatings" class="btn primary" ${locked ? "disabled" : ""}>Lock ratings</button>
        </div>

        <div id="msg" class="small" style="margin-top:10px"></div>
      </div>
    `;

    // actions
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
          writeManageCache(m.publicCode, fresh);
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
        writeManageCache(m.publicCode, fresh);
        MEM.lastManageData = fresh;
        renderManageView(manageArea, fresh);
      }
    };

    const shareCapBtn = manageArea.querySelector("#shareCap");
    if (shareCapBtn) {
      shareCapBtn.onclick = () => {
        waOpenPrefill(`Captain link:\n${capUrl}`);
        toastInfo("WhatsApp opened.");
      };
    }

    manageArea.querySelector("#closeAvail").onclick = async () => {
      const btn = manageArea.querySelector("#closeAvail");
      setDisabled(btn, true, "Closing…");
      const out = await API.adminCloseMatch(MEM.adminKey, m.matchId);
      setDisabled(btn, false);
      if (!out.ok) { toastError(out.error || "Failed"); return; }
      toastSuccess("Availability closed.");
      const res = await apiRefreshMatches();
      if (!res.ok) toastError(res.error || "Refresh failed");
      const fresh = await API.getPublicMatch(m.publicCode);
      if (fresh.ok) {
        writeManageCache(m.publicCode, fresh);
        MEM.lastManageData = fresh;
        renderManageView(manageArea, fresh);
      }
    };

    manageArea.querySelector("#lockRatings").onclick = async () => {
      const btn = manageArea.querySelector("#lockRatings");
      setDisabled(btn, true, "Locking…");
      const out = await API.adminLockRatings(MEM.adminKey, m.matchId);
      setDisabled(btn, false);
      if (!out.ok) { toastError(out.error || "Failed"); return; }
      toastSuccess("Ratings locked.");
      const res = await apiRefreshMatches();
      if (!res.ok) toastError(res.error || "Refresh failed");
      const fresh = await API.getPublicMatch(m.publicCode);
      if (fresh.ok) {
        writeManageCache(m.publicCode, fresh);
        MEM.lastManageData = fresh;
        renderManageView(manageArea, fresh);
      }
    };

    return;
  }

  // INTERNAL setup
  let blue = uniqueSorted(teams.filter(t => t.team === "BLUE").map(t => t.playerName));
  let orange = uniqueSorted(teams.filter(t => t.team === "ORANGE").map(t => t.playerName));
  let captainBlue = String(captains.captain1 || "");
  let captainOrange = String(captains.captain2 || "");

  function assignedTeam(p) {
    if (blue.includes(p)) return "BLUE";
    if (orange.includes(p)) return "ORANGE";
    return "";
  }

  function setTeam(p, team) {
    blue = blue.filter(x => x !== p);
    orange = orange.filter(x => x !== p);
    if (team === "BLUE") blue = uniqueSorted([...blue, p]);
    if (team === "ORANGE") orange = uniqueSorted([...orange, p]);

    if (!blue.includes(captainBlue)) captainBlue = "";
    if (!orange.includes(captainOrange)) captainOrange = "";
  }

  function removePlayer(p) {
    blue = blue.filter(x => x !== p);
    orange = orange.filter(x => x !== p);
    if (captainBlue === p) captainBlue = "";
    if (captainOrange === p) captainOrange = "";
  }

  // Show captain links ONLY if saved teams exist AND both captains exist
  const hasSavedSetup = (blue.length + orange.length) > 0 && !!captainBlue && !!captainOrange;
  const blueCapUrl = hasSavedSetup ? captainLink(m.publicCode, captainBlue) : "";
  const orangeCapUrl = hasSavedSetup ? captainLink(m.publicCode, captainOrange) : "";

  manageArea.innerHTML = `
    ${header}

    <div class="card">
      <div class="h1">Internal Setup</div>
      <div class="small">Choose team for each available player. Compact layout for mobile.</div>

      <div style="margin-top:12px; overflow:auto; border-radius:14px; border:1px solid rgba(11,18,32,0.10)">
        <table style="width:100%; border-collapse:collapse; min-width:520px">
          <thead>
            <tr style="background: rgba(11,18,32,0.04)">
              <th style="text-align:left; padding:8px; font-size:12px; color:rgba(11,18,32,0.72)">Player</th>
              <th style="text-align:center; padding:8px; font-size:12px; color:rgba(11,18,32,0.72)">Blue</th>
              <th style="text-align:center; padding:8px; font-size:12px; color:rgba(11,18,32,0.72)">Orange</th>
              <th style="text-align:center; padding:8px; font-size:12px; color:rgba(11,18,32,0.72)">Status</th>
            </tr>
          </thead>
          <tbody id="teamTableBody"></tbody>
        </table>
      </div>

      <div class="hr"></div>

      <div class="row" style="gap:14px; align-items:flex-start">
        <div style="flex:1; min-width:260px">
          <div class="badge">BLUE</div>
          <div id="blueList" style="margin-top:10px"></div>
        </div>
        <div style="flex:1; min-width:260px">
          <div class="badge">ORANGE</div>
          <div id="orangeList" style="margin-top:10px"></div>
        </div>
      </div>

      <div class="row" style="margin-top:14px">
        <button class="btn primary" id="saveSetup" ${isEditLocked ? "disabled" : ""}>Save setup</button>
        <button class="btn primary" id="shareTeams" ${hasSavedSetup ? "" : "disabled"}>Share teams</button>
      </div>

      <div id="setupMsg" class="small" style="margin-top:10px"></div>
    </div>

    <div class="card">
      <div class="h1">Captain links</div>
      ${
        hasSavedSetup
          ? `
          <div class="row" style="align-items:flex-start; justify-content:space-between">
            <div style="flex:1; min-width:0">
              <div class="small"><b>Blue captain:</b> ${captainBlue}</div>
              <div class="small" style="word-break:break-all">${blueCapUrl}</div>
            </div>
            <button class="btn primary" id="shareBlueCap">Share</button>
          </div>
          <div class="hr"></div>
          <div class="row" style="align-items:flex-start; justify-content:space-between">
            <div style="flex:1; min-width:0">
              <div class="small"><b>Orange captain:</b> ${captainOrange}</div>
              <div class="small" style="word-break:break-all">${orangeCapUrl}</div>
            </div>
            <button class="btn primary" id="shareOrangeCap">Share</button>
          </div>
          `
          : `<div class="small">Save setup to generate captain links.</div>`
      }

      <div class="row" style="margin-top:12px">
        <button id="closeAvail" class="btn gray" ${status === "OPEN" ? "" : "disabled"}>Close availability</button>
        <button id="lockRatings" class="btn primary" ${locked ? "disabled" : ""}>Lock ratings</button>
      </div>
      <div id="capMsg" class="small" style="margin-top:10px"></div>
    </div>
  `;

  // header buttons
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
        writeManageCache(m.publicCode, fresh);
        MEM.lastManageData = fresh;
        renderManageView(manageArea, fresh);
      }
    };
  }

  // build table + lists
  function renderTeamTable() {
    const tbody = manageArea.querySelector("#teamTableBody");
    tbody.innerHTML = yesPlayers.map(p => {
      const a = assignedTeam(p);
      const blueDisabled = (a === "ORANGE") || isEditLocked;
      const orangeDisabled = (a === "BLUE") || isEditLocked;
      const statusText = a || "Unassigned";
      return `
        <tr style="border-top:1px solid rgba(11,18,32,0.06)">
          <td class="compactName" style="padding:8px; color: rgba(11,18,32,0.90)">${p}</td>
          <td style="padding:8px; text-align:center">
            <button class="btn good compactBtn" data-team-btn="BLUE" data-player="${encodeURIComponent(p)}" ${blueDisabled ? "disabled" : ""}>Blue</button>
          </td>
          <td style="padding:8px; text-align:center">
            <button class="btn warn compactBtn" data-team-btn="ORANGE" data-player="${encodeURIComponent(p)}" ${orangeDisabled ? "disabled" : ""}>Orange</button>
          </td>
          <td style="padding:8px; text-align:center"><span class="badge">${statusText}</span></td>
        </tr>
      `;
    }).join("");

    tbody.querySelectorAll("[data-team-btn]").forEach(b => {
      b.onclick = () => {
        const team = b.getAttribute("data-team-btn");
        const p = decodeURIComponent(b.getAttribute("data-player"));
        setTeam(p, team);
        renderAll();
      };
    });
  }

  function renderLists() {
    const blueEl = manageArea.querySelector("#blueList");
    const orangeEl = manageArea.querySelector("#orangeList");

    function listHtml(players, teamName) {
      if (!players.length) return `<div class="small">No players yet.</div>`;
      return players.map(p => {
        const isCap = (teamName === "BLUE" ? captainBlue === p : captainOrange === p);
        const disabled = isEditLocked ? "disabled" : "";
        return `
          <div class="playerRow">
            <div class="playerRow__name">${p}</div>
            <div class="playerRow__actions">
              <div class="playerRow__cap">
                <label>
                  <input type="checkbox" data-cap="${teamName}" data-player="${encodeURIComponent(p)}" ${isCap ? "checked" : ""} ${disabled}/>
                  Captain
                </label>
              </div>
              <button class="btn gray" data-remove-player="${encodeURIComponent(p)}" style="padding:8px 10px; border-radius:12px" ${disabled}>Remove</button>
            </div>
          </div>
        `;
      }).join("");
    }

    blueEl.innerHTML = listHtml(blue, "BLUE");
    orangeEl.innerHTML = listHtml(orange, "ORANGE");

    manageArea.querySelectorAll("[data-cap]").forEach(cb => {
      cb.onchange = () => {
        const teamName = cb.getAttribute("data-cap");
        const p = decodeURIComponent(cb.getAttribute("data-player"));
        if (teamName === "BLUE") captainBlue = cb.checked ? p : "";
        if (teamName === "ORANGE") captainOrange = cb.checked ? p : "";
        renderAll();
      };
    });

    manageArea.querySelectorAll("[data-remove-player]").forEach(btn => {
      btn.onclick = () => {
        const p = decodeURIComponent(btn.getAttribute("data-remove-player"));
        removePlayer(p);
        renderAll();
      };
    });
  }

  function renderAll() {
    blue = uniqueSorted(blue);
    orange = uniqueSorted(orange);
    renderTeamTable();
    renderLists();
  }

  renderAll();

  // Save setup
  manageArea.querySelector("#saveSetup").onclick = async () => {
    if (isEditLocked) { toastWarn("Match locked. Unlock to edit."); return; }

    const msg = manageArea.querySelector("#setupMsg");
    if (!captainBlue || !captainOrange) {
      msg.textContent = "Select captains for BOTH Blue and Orange.";
      toastWarn("Select both captains.");
      return;
    }

    const btn = manageArea.querySelector("#saveSetup");
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
      toastError(out.error || "Failed to save setup");
      return;
    }

    msg.textContent = "Saved ✅";
    toastSuccess("Setup saved.");

    const fresh = await API.getPublicMatch(m.publicCode);
    if (fresh.ok) {
      writeManageCache(m.publicCode, fresh);
      MEM.lastManageData = fresh;
      renderManageView(manageArea, fresh);
    }
  };

  // Share teams (only enabled when saved setup exists)
  const shareTeamsBtn = manageArea.querySelector("#shareTeams");
  if (shareTeamsBtn) {
    shareTeamsBtn.onclick = () => {
      if (!hasSavedSetup) { toastWarn("Save setup first."); return; }
      setDisabled(shareTeamsBtn, true, "Opening…");

      const lines = [];
      lines.push(`Match: ${m.title}`);
      lines.push(`Type: INTERNAL`);
      lines.push(`Link: ${matchLink(m.publicCode)}`);
      lines.push("");
      lines.push(`BLUE Captain: ${captainBlue}`);
      blue.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
      lines.push("");
      lines.push(`ORANGE Captain: ${captainOrange}`);
      orange.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
      lines.push("");
      lines.push(`Blue Captain Link: ${blueCapUrl}`);
      lines.push(`Orange Captain Link: ${orangeCapUrl}`);

      waOpenPrefill(lines.join("\n"));
      toastInfo("WhatsApp opened.");
      setTimeout(() => setDisabled(shareTeamsBtn, false), 900);
    };
  }

  // Share captain links (only if saved)
  const blueBtn = manageArea.querySelector("#shareBlueCap");
  if (blueBtn) {
    blueBtn.onclick = () => {
      setDisabled(blueBtn, true, "Opening…");
      waOpenPrefill(`Blue captain link:\n${blueCapUrl}`);
      toastInfo("WhatsApp opened.");
      setTimeout(() => setDisabled(blueBtn, false), 900);
    };
  }
  const orangeBtn = manageArea.querySelector("#shareOrangeCap");
  if (orangeBtn) {
    orangeBtn.onclick = () => {
      setDisabled(orangeBtn, true, "Opening…");
      waOpenPrefill(`Orange captain link:\n${orangeCapUrl}`);
      toastInfo("WhatsApp opened.");
      setTimeout(() => setDisabled(orangeBtn, false), 900);
    };
  }

  // Close availability
  manageArea.querySelector("#closeAvail").onclick = async () => {
    const btn = manageArea.querySelector("#closeAvail");
    setDisabled(btn, true, "Closing…");
    const out = await API.adminCloseMatch(MEM.adminKey, m.matchId);
    setDisabled(btn, false);
    if (!out.ok) { toastError(out.error || "Failed"); return; }
    toastSuccess("Availability closed.");

    const res = await apiRefreshMatches();
    if (!res.ok) toastError(res.error || "Refresh failed");
    const fresh = await API.getPublicMatch(m.publicCode);
    if (fresh.ok) {
      writeManageCache(m.publicCode, fresh);
      MEM.lastManageData = fresh;
      renderManageView(manageArea, fresh);
    }
  };

  // Lock ratings
  manageArea.querySelector("#lockRatings").onclick = async () => {
    const btn = manageArea.querySelector("#lockRatings");
    setDisabled(btn, true, "Locking…");
    const out = await API.adminLockRatings(MEM.adminKey, m.matchId);
    setDisabled(btn, false);
    if (!out.ok) { toastError(out.error || "Failed"); return; }
    toastSuccess("Ratings locked.");

    const res = await apiRefreshMatches();
    if (!res.ok) toastError(res.error || "Refresh failed");
    const fresh = await API.getPublicMatch(m.publicCode);
    if (fresh.ok) {
      writeManageCache(m.publicCode, fresh);
      MEM.lastManageData = fresh;
      renderManageView(manageArea, fresh);
    }
  };
}

export async function renderAdminPage(root) {
  const key = localStorage.getItem(LS_ADMIN_KEY);
  if (!key) {
    renderLogin(root);
    return;
  }
  MEM.adminKey = key;

  // Load cached matches once; do NOT call API unless refresh or explicit action
  if (!MEM.matches.length) loadMatchesFromCache();

  renderAdminShell(root);
}
