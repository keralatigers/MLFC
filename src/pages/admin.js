import { API } from "../api/endpoints.js";
import { toastSuccess, toastError, toastInfo, toastWarn } from "../ui/toast.js";

const LS_ADMIN_KEY = "mlfc_adminKey";

// In-memory state (persists while app stays open)
let MEM = {
  adminKey: null,
  matches: [],
  matchesTs: 0,
  lastManagedCode: null,
  lastManageData: null,
  lastManageTs: 0
};

const SS_MATCHES_CACHE_KEY = "mlfc_admin_matches_cache_v5";
const SS_MANAGE_CACHE_PREFIX = "mlfc_manage_cache_v5:";
const MATCHES_TTL_MS = 20 * 1000;  // only used when switching tabs; manual Refresh exists
const MANAGE_TTL_MS = 30 * 1000;

function now() { return Date.now(); }

function baseUrl() {
  return location.href.split("#")[0];
}
function matchLink(publicCode) {
  return `${baseUrl()}#/match?code=${publicCode}`;
}
function captainLink(publicCode, captainName) {
  return `${baseUrl()}#/captain?code=${publicCode}&captain=${encodeURIComponent(captainName)}`;
}
function waOpenPrefill(text) {
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
}
function uniqueSorted(arr) {
  return [...new Set(arr)].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function readSessionJson(key) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function writeSessionJson(key, obj) {
  try { sessionStorage.setItem(key, JSON.stringify(obj)); } catch {}
}

function manageCacheKey(code) {
  return `${SS_MANAGE_CACHE_PREFIX}${code}`;
}
function readManageCache(code) {
  const obj = readSessionJson(manageCacheKey(code));
  if (!obj || !obj.ts || !obj.data) return null;
  if ((now() - obj.ts) > MANAGE_TTL_MS) return null;
  return obj.data;
}
function writeManageCache(code, data) {
  writeSessionJson(manageCacheKey(code), { ts: now(), data });
}

function setDisabled(el, disabled, labelWhileDisabled) {
  if (!el) return;
  el.disabled = disabled;
  if (labelWhileDisabled) {
    if (!el.dataset.origText) el.dataset.origText = el.textContent;
    el.textContent = disabled ? labelWhileDisabled : el.dataset.origText;
  }
}

async function fetchMatches(force) {
  const adminKey = MEM.adminKey || localStorage.getItem(LS_ADMIN_KEY);
  if (!adminKey) return null;
  MEM.adminKey = adminKey;

  // cache used only to avoid re-fetch when switching tabs quickly
  if (!force && MEM.matches.length && (now() - MEM.matchesTs) < MATCHES_TTL_MS) {
    return { ok: true, matches: MEM.matches };
  }

  const res = await API.adminListMatches(adminKey);
  if (!res.ok) return res;

  MEM.matches = res.matches || [];
  MEM.matchesTs = now();
  writeSessionJson(SS_MATCHES_CACHE_KEY, { ts: MEM.matchesTs, matches: MEM.matches });

  return { ok: true, matches: MEM.matches };
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
    sessionStorage.removeItem(SS_MATCHES_CACHE_KEY);
    MEM = { adminKey: null, matches: [], matchesTs: 0, lastManagedCode: null, lastManageData: null, lastManageTs: 0 };
    toastInfo("Admin key cleared.");
    msgEl.textContent = "Cleared.";
  };

  root.querySelector("#login").onclick = async () => {
    const adminKey = keyEl.value.trim();
    msgEl.textContent = "Logging in…";
    setDisabled(root.querySelector("#login"), true, "Logging in…");

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
    writeSessionJson(SS_MATCHES_CACHE_KEY, { ts: MEM.matchesTs, matches: MEM.matches });

    toastSuccess("Logged in.");
    renderAdminShell(root);
  };
}

function renderAdminShell(root) {
  root.innerHTML = `
    <div class="card">
      <div class="h1">Admin</div>
      <div class="row" style="margin-top:10px">
        <button id="refresh" class="btn primary">Refresh</button>
        <button id="logout" class="btn gray">Logout</button>
      </div>
      <div id="msg" class="small" style="margin-top:10px"></div>
    </div>

    <div id="adminArea"></div>
  `;

  root.querySelector("#logout").onclick = () => {
    localStorage.removeItem(LS_ADMIN_KEY);
    sessionStorage.removeItem(SS_MATCHES_CACHE_KEY);
    MEM = { adminKey: null, matches: [], matchesTs: 0, lastManagedCode: null, lastManageData: null, lastManageTs: 0 };
    toastInfo("Logged out.");
    renderLogin(root);
  };

  root.querySelector("#refresh").onclick = async () => {
    const msgEl = root.querySelector("#msg");
    msgEl.textContent = "Refreshing…";
    setDisabled(root.querySelector("#refresh"), true, "Refreshing…");

    const res = await fetchMatches(true);

    setDisabled(root.querySelector("#refresh"), false);
    msgEl.textContent = "";

    if (!res || !res.ok) {
      toastError(res?.error || "Failed to refresh");
      return;
    }

    toastSuccess("Matches refreshed.");
    updateMatchesList(root.querySelector("#adminArea"), MEM.matches);
  };

  renderAdminArea(root.querySelector("#adminArea"));
}

function createMatchesListHtml(matches) {
  const items = (matches || []).slice(0, 20).map(m => {
    const status = String(m.status || "").toUpperCase();
    const canClose = status === "OPEN";
    const locked = String(m.ratingsLocked || "").toUpperCase() === "TRUE";
    const lockedBadge = locked ? `<span class="badge badge--bad">LOCKED</span>` : "";

    return `
      <div style="padding:10px 0; border-bottom:1px solid #eee">
        <div class="row" style="justify-content:space-between">
          <div style="min-width:0">
            <div style="font-weight:950; color: rgba(11,18,32,0.92)">${m.title}</div>
            <div class="small">${m.date} ${m.time} • ${m.type}</div>
          </div>
          <div class="row" style="gap:6px">
            <span class="badge">${m.status}</span>
            ${lockedBadge}
          </div>
        </div>

        <div class="row" style="margin-top:8px">
          <button class="btn gray" data-manage="${m.publicCode}">Manage</button>
          ${canClose ? `<button class="btn gray" data-close="${m.matchId}">Close availability</button>` : `<span class="badge">Availability closed</span>`}
          <button class="btn gray" data-lock="${m.matchId}">Lock ratings</button>
        </div>
      </div>
    `;
  }).join("");

  return `
    <div class="card" id="matchesCard">
      <div class="h1">Matches (latest)</div>
      <div id="matchesList">
        ${items || `<div class="small">No matches yet.</div>`}
      </div>
    </div>
  `;
}

function renderAdminArea(adminArea) {
  // bootstrap from session cache if any
  const ss = readSessionJson(SS_MATCHES_CACHE_KEY);
  if (ss && Array.isArray(ss.matches) && (!MEM.matches.length || (now() - MEM.matchesTs) > MATCHES_TTL_MS)) {
    MEM.matches = ss.matches;
    MEM.matchesTs = ss.ts || 0;
  }

  adminArea.innerHTML = `
    <div class="card" id="createCard">
      <div class="h1">Create match</div>
      <input id="title" class="input" placeholder="Title" />
      <input id="date" class="input" type="date" style="margin-top:10px" />
      <input id="time" class="input" type="time" style="margin-top:10px" />
      <select id="type" class="input" style="margin-top:10px">
        <option value="OPPONENT">Against opponents (1 captain)</option>
        <option value="INTERNAL">Internal (Blue vs Orange)</option>
      </select>
      <button id="create" class="btn primary" style="margin-top:10px">Create</button>
      <div id="created" class="small" style="margin-top:10px"></div>
    </div>

    ${createMatchesListHtml(MEM.matches)}

    <div id="manageArea"></div>
  `;

  // create match
  adminArea.querySelector("#create").onclick = async () => {
    const btn = adminArea.querySelector("#create");
    setDisabled(btn, true, "Creating…");

    const payload = {
      title: adminArea.querySelector("#title").value.trim() || "Weekly Match",
      date: adminArea.querySelector("#date").value,
      time: adminArea.querySelector("#time").value,
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

    const res = await fetchMatches(true);
    if (res?.ok) updateMatchesList(adminArea, MEM.matches);
  };

  bindMatchesButtons(adminArea);

  // restore manage view if it was open
  if (MEM.lastManagedCode) {
    const manageArea = adminArea.querySelector("#manageArea");
    const cached = readManageCache(MEM.lastManagedCode) || MEM.lastManageData;
    if (cached) renderManageView(manageArea, cached);
  }

  // do a light fetch if no matches loaded yet
  if (!MEM.matches.length) {
    fetchMatches(false).then(res => {
      if (res?.ok) updateMatchesList(adminArea, MEM.matches);
    }).catch(() => {});
  }
}

function updateMatchesList(adminArea, matches) {
  const list = adminArea.querySelector("#matchesList");
  if (!list) return;

  list.innerHTML = (matches || []).slice(0, 20).map(m => {
    const status = String(m.status || "").toUpperCase();
    const canClose = status === "OPEN";
    const locked = String(m.ratingsLocked || "").toUpperCase() === "TRUE";
    const lockedBadge = locked ? `<span class="badge badge--bad">LOCKED</span>` : "";

    return `
      <div style="padding:10px 0; border-bottom:1px solid #eee">
        <div class="row" style="justify-content:space-between">
          <div style="min-width:0">
            <div style="font-weight:950; color: rgba(11,18,32,0.92)">${m.title}</div>
            <div class="small">${m.date} ${m.time} • ${m.type}</div>
          </div>
          <div class="row" style="gap:6px">
            <span class="badge">${m.status}</span>
            ${lockedBadge}
          </div>
        </div>

        <div class="row" style="margin-top:8px">
          <button class="btn gray" data-manage="${m.publicCode}">Manage</button>
          ${canClose ? `<button class="btn gray" data-close="${m.matchId}">Close availability</button>` : `<span class="badge">Availability closed</span>`}
          <button class="btn gray" data-lock="${m.matchId}">Lock ratings</button>
        </div>
      </div>
    `;
  }).join("") || `<div class="small">No matches yet.</div>`;

  bindMatchesButtons(adminArea);

  // keep manage view visible if open
  if (MEM.lastManagedCode) {
    const manageArea = adminArea.querySelector("#manageArea");
    const cached = readManageCache(MEM.lastManagedCode) || MEM.lastManageData;
    if (cached) renderManageView(manageArea, cached);
  }
}

function bindMatchesButtons(adminArea) {
  // manage
  adminArea.querySelectorAll("[data-manage]").forEach(btn => {
    btn.onclick = async () => {
      const code = btn.getAttribute("data-manage");
      const manageArea = adminArea.querySelector("#manageArea");
      MEM.lastManagedCode = code;

      // disable to prevent double clicks
      setDisabled(btn, true, "Opening…");
      setTimeout(() => setDisabled(btn, false), 800);

      const cached = readManageCache(code) ||
        (MEM.lastManageData && MEM.lastManagedCode === code && (now() - MEM.lastManageTs) < MANAGE_TTL_MS ? MEM.lastManageData : null);

      if (cached) {
        renderManageView(manageArea, cached);
      } else {
        manageArea.innerHTML = `<div class="card"><div class="h1">Loading match…</div></div>`;
      }

      const fresh = await API.getPublicMatch(code);
      if (fresh.ok) {
        writeManageCache(code, fresh);
        MEM.lastManageData = fresh;
        MEM.lastManageTs = now();
        renderManageView(manageArea, fresh);
      } else {
        if (!cached) manageArea.innerHTML = `<div class="card"><div class="h1">Error</div><div class="small">${fresh.error}</div></div>`;
        toastError(fresh.error || "Failed to load match");
      }
    };
  });

  // close availability
  adminArea.querySelectorAll("[data-close]").forEach(btn => {
    btn.onclick = async () => {
      const matchId = btn.getAttribute("data-close");
      setDisabled(btn, true, "Closing…");
      const out = await API.adminCloseMatch(MEM.adminKey, matchId);
      setDisabled(btn, false);

      if (!out.ok) {
        toastError(out.error || "Failed to close availability");
        return;
      }
      toastSuccess("Availability closed.");
      const res = await fetchMatches(true);
      if (res?.ok) updateMatchesList(adminArea, MEM.matches);
    };
  });

  // lock ratings
  adminArea.querySelectorAll("[data-lock]").forEach(btn => {
    btn.onclick = async () => {
      const matchId = btn.getAttribute("data-lock");
      setDisabled(btn, true, "Locking…");
      const out = await API.adminLockRatings(MEM.adminKey, matchId);
      setDisabled(btn, false);

      if (!out.ok) {
        toastError(out.error || "Failed to lock ratings");
        return;
      }
      toastSuccess("Ratings locked.");
      const res = await fetchMatches(true);
      if (res?.ok) updateMatchesList(adminArea, MEM.matches);
    };
  });
}

function renderManageView(manageArea, data) {
  const m = data.match;
  const status = String(m.status || "").toUpperCase();
  const locked = String(m.ratingsLocked || "").toUpperCase() === "TRUE";
  const isEditLocked = locked || status === "CLOSED" || status === "COMPLETED";
  const type = String(m.type || "").toUpperCase();

  const avail = data.availability || [];
  const yesPlayers = uniqueSorted(avail.filter(a => String(a.availability).toUpperCase() === "YES").map(a => a.playerName));

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
      <div class="small" style="margin-top:10px">Code link: ${matchLink(m.publicCode)}</div>

      <div class="row" style="margin-top:10px">
        <button class="btn primary" id="shareMatch">Share match link</button>
        <button class="btn gray" id="unlockBtn" ${isEditLocked ? "" : "disabled"}>Unlock match</button>
      </div>
      <div class="small" style="margin-top:10px">
        ${isEditLocked ? "Edits are locked (availability closed or ratings locked). Unlock to edit." : "Edits are allowed."}
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
        <div class="small">Captain enters ratings for OUR players after match.</div>

        <select id="captainSel" class="input" style="margin-top:10px" ${isEditLocked ? "disabled" : ""}>
          <option value="">Select captain</option>
          ${opts}
        </select>

        <div class="row" style="margin-top:10px">
          <button id="saveCap" class="btn primary" ${isEditLocked ? "disabled" : ""}>Save captain</button>
        </div>

        <div class="hr"></div>

        <div class="h1">Captain link</div>
        ${cap ? `
          <div class="row" style="justify-content:space-between; align-items:center">
            <div class="small" style="word-break:break-all; flex:1">${capUrl}</div>
            <button class="btn primary" id="shareCapLink">Share</button>
          </div>
        ` : `<div class="small">No captain set yet.</div>`}

        <div class="row" style="margin-top:12px">
          <button id="lockRatings" class="btn primary" ${locked ? "disabled" : ""}>Lock ratings</button>
        </div>
        <div id="msg" class="small" style="margin-top:10px"></div>
      </div>
    `;

    // header buttons
    manageArea.querySelector("#shareMatch").onclick = () => {
      waOpenPrefill(`Manor Lakes FC match link:\n${matchLink(m.publicCode)}`);
      toastInfo("WhatsApp opened with match link.");
    };

    manageArea.querySelector("#unlockBtn").onclick = async () => {
      const btn = manageArea.querySelector("#unlockBtn");
      setDisabled(btn, true, "Unlocking…");
      const out = await API.adminUnlockMatch(MEM.adminKey, m.matchId);
      setDisabled(btn, false);
      if (!out.ok) {
        toastError(out.error || "Failed to unlock match");
        return;
      }
      toastSuccess("Match unlocked.");
      // Reload manage data
      const fresh = await API.getPublicMatch(m.publicCode);
      if (fresh.ok) {
        writeManageCache(m.publicCode, fresh);
        MEM.lastManageData = fresh;
        MEM.lastManageTs = now();
        renderManageView(manageArea, fresh);
      }
    };

    const capSel = manageArea.querySelector("#captainSel");
    capSel.value = cap || "";

    manageArea.querySelector("#saveCap").onclick = async () => {
      const btn = manageArea.querySelector("#saveCap");
      const msg = manageArea.querySelector("#msg");
      const sel = capSel.value.trim();
      if (!sel) { toastWarn("Select a captain."); return; }

      setDisabled(btn, true, "Saving…");
      msg.textContent = "Saving…";
      const out = await API.adminSetupOpponent(MEM.adminKey, { matchId: m.matchId, captain: sel });
      setDisabled(btn, false);

      if (!out.ok) {
        msg.textContent = out.error || "Failed";
        toastError(out.error || "Failed to save captain");
        return;
      }
      msg.textContent = "Saved ✅";
      toastSuccess("Captain saved.");

      const fresh = await API.getPublicMatch(m.publicCode);
      if (fresh.ok) {
        writeManageCache(m.publicCode, fresh);
        MEM.lastManageData = fresh;
        MEM.lastManageTs = now();
        renderManageView(manageArea, fresh);
      }
    };

    const shareBtn = manageArea.querySelector("#shareCapLink");
    if (shareBtn) {
      shareBtn.onclick = () => {
        waOpenPrefill(`Captain link:\n${capUrl}`);
        toastInfo("WhatsApp opened with captain link.");
      };
    }

    manageArea.querySelector("#lockRatings").onclick = async () => {
      const btn = manageArea.querySelector("#lockRatings");
      setDisabled(btn, true, "Locking…");
      const out = await API.adminLockRatings(MEM.adminKey, m.matchId);
      setDisabled(btn, false);
      if (!out.ok) {
        toastError(out.error || "Failed to lock ratings");
        return;
      }
      toastSuccess("Ratings locked.");
      const fresh = await API.getPublicMatch(m.publicCode);
      if (fresh.ok) {
        writeManageCache(m.publicCode, fresh);
        MEM.lastManageData = fresh;
        MEM.lastManageTs = now();
        renderManageView(manageArea, fresh);
      }
    };

    return;
  }

  // INTERNAL
  let blue = uniqueSorted(teams.filter(t => t.team === "BLUE").map(t => t.playerName));
  let orange = uniqueSorted(teams.filter(t => t.team === "ORANGE").map(t => t.playerName));
  let captainBlue = String(captains.captain1 || "");
  let captainOrange = String(captains.captain2 || "");

  const capBlueUrl = captainBlue ? captainLink(m.publicCode, captainBlue) : "";
  const capOrangeUrl = captainOrange ? captainLink(m.publicCode, captainOrange) : "";

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

  manageArea.innerHTML = `
    ${header}

    <div class="card">
      <div class="h1">Captain links</div>

      <div class="row" style="align-items:flex-start; justify-content:space-between">
        <div style="flex:1; min-width:0">
          <div class="small"><b>Blue captain:</b> ${captainBlue || "-"}</div>
          <div class="small" style="word-break:break-all">${capBlueUrl || ""}</div>
        </div>
        <button class="btn primary" id="shareBlueCap" ${captainBlue ? "" : "disabled"}>Share</button>
      </div>

      <div class="hr"></div>

      <div class="row" style="align-items:flex-start; justify-content:space-between">
        <div style="flex:1; min-width:0">
          <div class="small"><b>Orange captain:</b> ${captainOrange || "-"}</div>
          <div class="small" style="word-break:break-all">${capOrangeUrl || ""}</div>
        </div>
        <button class="btn primary" id="shareOrangeCap" ${captainOrange ? "" : "disabled"}>Share</button>
      </div>

      <div class="row" style="margin-top:12px">
        <button id="lockRatings" class="btn primary" ${locked ? "disabled" : ""}>Lock ratings</button>
      </div>

      <div id="capMsg" class="small" style="margin-top:10px"></div>
    </div>

    <div class="card">
      <div class="h1">Internal Setup</div>
      <div class="small">Tap Blue/Orange per player. Smaller buttons for mobile.</div>

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

      <!-- Save/Share AFTER the lists (as requested) -->
      <div class="row" style="margin-top:14px">
        <button class="btn primary" id="saveSetup" ${isEditLocked ? "disabled" : ""}>Save setup</button>
        <button class="btn primary" id="shareTeams" ${(!blue.length && !orange.length) ? "disabled" : ""}>Share teams</button>
      </div>

      <div id="setupMsg" class="small" style="margin-top:10px"></div>
    </div>
  `;

  // header buttons
  manageArea.querySelector("#shareMatch").onclick = () => {
    waOpenPrefill(`Manor Lakes FC match link:\n${matchLink(m.publicCode)}`);
    toastInfo("WhatsApp opened with match link.");
  };

  manageArea.querySelector("#unlockBtn").onclick = async () => {
    const btn = manageArea.querySelector("#unlockBtn");
    setDisabled(btn, true, "Unlocking…");
    const out = await API.adminUnlockMatch(MEM.adminKey, m.matchId);
    setDisabled(btn, false);

    if (!out.ok) {
      toastError(out.error || "Failed to unlock match");
      return;
    }
    toastSuccess("Match unlocked.");
    const fresh = await API.getPublicMatch(m.publicCode);
    if (fresh.ok) {
      writeManageCache(m.publicCode, fresh);
      MEM.lastManageData = fresh;
      MEM.lastManageTs = now();
      renderManageView(manageArea, fresh);
    }
  };

  // share captain link buttons
  manageArea.querySelector("#shareBlueCap").onclick = () => {
    waOpenPrefill(`Blue captain link:\n${capBlueUrl}`);
    toastInfo("WhatsApp opened with Blue captain link.");
  };
  manageArea.querySelector("#shareOrangeCap").onclick = () => {
    waOpenPrefill(`Orange captain link:\n${capOrangeUrl}`);
    toastInfo("WhatsApp opened with Orange captain link.");
  };

  // lock ratings
  manageArea.querySelector("#lockRatings").onclick = async () => {
    const btn = manageArea.querySelector("#lockRatings");
    setDisabled(btn, true, "Locking…");
    const out = await API.adminLockRatings(MEM.adminKey, m.matchId);
    setDisabled(btn, false);

    if (!out.ok) {
      toastError(out.error || "Failed to lock ratings");
      return;
    }
    toastSuccess("Ratings locked.");
    const fresh = await API.getPublicMatch(m.publicCode);
    if (fresh.ok) {
      writeManageCache(m.publicCode, fresh);
      MEM.lastManageData = fresh;
      MEM.lastManageTs = now();
      renderManageView(manageArea, fresh);
    }
  };

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
          <td style="padding:8px; text-align:center">
            <span class="badge">${statusText}</span>
          </td>
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
                  <input type="checkbox" data-cap="${teamName}" data-player="${encodeURIComponent(p)}" ${isCap ? "checked" : ""} ${disabled} />
                  Captain
                </label>
              </div>
              <button class="btn gray" data-remove-player="${encodeURIComponent(p)}" style="padding:8px 10px; border-radius:12px" ${disabled}>
                Remove
              </button>
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
    // enable shareTeams only if there are players
    const shareTeamsBtn = manageArea.querySelector("#shareTeams");
    if (shareTeamsBtn) shareTeamsBtn.disabled = (!blue.length && !orange.length);
  }

  renderAll();

  // Save setup (disabled while action)
  manageArea.querySelector("#saveSetup").onclick = async () => {
    if (isEditLocked) {
      toastWarn("Match is locked. Unlock to edit.");
      return;
    }

    const msg = manageArea.querySelector("#setupMsg");

    if (!captainBlue || !captainOrange) {
      msg.textContent = "Select captains for BOTH Blue and Orange.";
      toastWarn("Select captains for both teams.");
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
    toastSuccess("Teams + captains saved.");

    // reload manage data to get saved captains/teams from backend
    const fresh = await API.getPublicMatch(m.publicCode);
    if (fresh.ok) {
      writeManageCache(m.publicCode, fresh);
      MEM.lastManageData = fresh;
      MEM.lastManageTs = now();
      renderManageView(manageArea, fresh);
    }
  };

  // Share teams (disabled while action)
  manageArea.querySelector("#shareTeams").onclick = () => {
    const btn = manageArea.querySelector("#shareTeams");
    setDisabled(btn, true, "Opening…");

    const link = matchLink(m.publicCode);
    const lines = [];
    lines.push(`Match: ${m.title}`);
    lines.push(`Type: INTERNAL`);
    lines.push(`Link: ${link}`);
    lines.push("");
    lines.push(`BLUE Captain: ${captainBlue || "-"}`);
    blue.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
    if (!blue.length) lines.push("1. -");
    lines.push("");
    lines.push(`ORANGE Captain: ${captainOrange || "-"}`);
    orange.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
    if (!orange.length) lines.push("1. -");
    lines.push("");
    lines.push(`Blue Captain Link: ${capBlueUrl || ""}`);
    lines.push(`Orange Captain Link: ${capOrangeUrl || ""}`);

    waOpenPrefill(lines.join("\n"));
    toastInfo("WhatsApp opened with teams.");

    // re-enable shortly to prevent double-tap
    setTimeout(() => setDisabled(btn, false), 900);
  };
}

export async function renderAdminPage(root) {
  const key = localStorage.getItem(LS_ADMIN_KEY);
  if (!key) {
    renderLogin(root);
    return;
  }

  MEM.adminKey = key;

  // bootstrap matches from session cache
  const ss = readSessionJson(SS_MATCHES_CACHE_KEY);
  if (ss && Array.isArray(ss.matches) && (!MEM.matches.length || (now() - MEM.matchesTs) > MATCHES_TTL_MS)) {
    MEM.matches = ss.matches;
    MEM.matchesTs = ss.ts || 0;
  }

  renderAdminShell(root);

  // optional: light refresh if stale (does not re-render create form; only list)
  if (!MEM.matches.length || (now() - MEM.matchesTs) > MATCHES_TTL_MS) {
    const res = await fetchMatches(false);
    if (res?.ok) updateMatchesList(root.querySelector("#adminArea"), MEM.matches);
  }
}
