import { API } from "../api/endpoints.js";
import { toastSuccess, toastError, toastInfo, toastWarn } from "../ui/toast.js";

const LS_ADMIN_KEY = "mlfc_adminKey";

// Cache: matches list (admin)
const SS_MATCHES_CACHE_KEY = "mlfc_admin_matches_cache_v6"; // { ts, matches[] }
// Cache: manage match details
const SS_MANAGE_CACHE_PREFIX = "mlfc_admin_manage_cache_v6:"; // + publicCode => { ts, data }

// No auto reload unless Refresh button (or browser reload clears sessionStorage)
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

function now() { return Date.now(); }

function uniqueSorted(arr) {
  return [...new Set(arr)].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function setDisabled(btn, disabled, busyText) {
  if (!btn) return;
  btn.disabled = disabled;
  if (busyText) {
    if (!btn.dataset.origText) btn.dataset.origText = btn.textContent;
    btn.textContent = disabled ? busyText : btn.dataset.origText;
  }
}

function getQueryFromHash() {
  const hash = location.hash || "#/admin";
  const [, qs] = hash.split("?");
  return new URLSearchParams(qs || "");
}

function isPastView(query) {
  return String(query.get("view") || "").toLowerCase() === "past";
}

function getPage(query) {
  const p = Number(query.get("page") || 1);
  return Number.isFinite(p) && p > 0 ? p : 1;
}

function manageCacheKey(code) {
  return `${SS_MANAGE_CACHE_PREFIX}${code}`;
}

function readManageCache(code) {
  const obj = readSessionJson(manageCacheKey(code));
  return obj?.data?.ok ? obj.data : null;
}

function writeManageCache(code, data) {
  writeSessionJson(manageCacheKey(code), { ts: now(), data });
}

function loadCachedMatches() {
  const c = readSessionJson(SS_MATCHES_CACHE_KEY);
  return Array.isArray(c?.matches) ? c.matches : [];
}

function saveCachedMatches(matches) {
  writeSessionJson(SS_MATCHES_CACHE_KEY, { ts: now(), matches });
}

function normalizeStatus(m) {
  return String(m.status || "").toUpperCase();
}

function sortByDateDesc(matches) {
  // uses date+time strings; OK for ordering most recent if formatted YYYY-MM-DD / HH:MM
  return [...matches].sort((a, b) => {
    const ad = `${a.date || ""}T${a.time || ""}`;
    const bd = `${b.date || ""}T${b.time || ""}`;
    return bd.localeCompare(ad);
  });
}

function filterOpen(matches) {
  return matches.filter(m => normalizeStatus(m) === "OPEN");
}

function filterPast(matches) {
  return matches.filter(m => normalizeStatus(m) !== "OPEN");
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
    toastInfo("Admin key cleared.");
    msgEl.textContent = "Cleared.";
  };

  root.querySelector("#login").onclick = async () => {
    const btn = root.querySelector("#login");
    setDisabled(btn, true, "Logging in…");
    msgEl.textContent = "Logging in…";

    const adminKey = keyEl.value.trim();
    const res = await API.adminListMatches(adminKey);

    setDisabled(btn, false);

    if (!res.ok) {
      msgEl.textContent = res.error || "Unauthorized";
      toastError(res.error || "Unauthorized");
      return;
    }

    localStorage.setItem(LS_ADMIN_KEY, adminKey);
    saveCachedMatches(res.matches || []);
    toastSuccess("Logged in.");
    renderAdminShell(root);
  };
}

function renderAdminShell(root) {
  const query = getQueryFromHash();
  const past = isPastView(query);

  root.innerHTML = `
    <div class="card">
      <div class="h1">Admin</div>
      <div class="row" style="margin-top:10px">
        <button id="refresh" class="btn primary">Refresh</button>
        <button id="toggleView" class="btn gray">${past ? "Open matches" : "Past matches"}</button>
        <button id="logout" class="btn gray">Logout</button>
      </div>
      <div id="msg" class="small" style="margin-top:10px"></div>
    </div>

    <div id="adminArea"></div>
  `;

  const adminArea = root.querySelector("#adminArea");

  root.querySelector("#logout").onclick = () => {
    localStorage.removeItem(LS_ADMIN_KEY);
    toastInfo("Logged out.");
    renderLogin(root);
  };

  root.querySelector("#toggleView").onclick = () => {
    if (past) {
      location.hash = "#/admin";
    } else {
      location.hash = "#/admin?view=past&page=1";
    }
  };

  root.querySelector("#refresh").onclick = async () => {
    const btn = root.querySelector("#refresh");
    const msgEl = root.querySelector("#msg");
    setDisabled(btn, true, "Refreshing…");
    msgEl.textContent = "Refreshing…";

    const adminKey = localStorage.getItem(LS_ADMIN_KEY);
    const res = await API.adminListMatches(adminKey);

    setDisabled(btn, false);
    msgEl.textContent = "";

    if (!res.ok) {
      toastError(res.error || "Failed to refresh");
      return;
    }

    saveCachedMatches(res.matches || []);
    toastSuccess("Refreshed.");
    renderAdminArea(adminArea); // uses cached only
  };

  renderAdminArea(adminArea);
}

function renderAdminArea(adminArea) {
  const query = getQueryFromHash();
  const past = isPastView(query);
  const page = getPage(query);
  const matches = loadCachedMatches();

  if (!matches.length) {
    adminArea.innerHTML = `
      <div class="card">
        <div class="h1">${past ? "Past matches" : "Open matches"}</div>
        <div class="small">No cached matches. Tap Refresh to load.</div>
      </div>
      <div id="manageArea"></div>
    `;
    return;
  }

  if (!past) {
    renderOpenMatchesView(adminArea, matches);
  } else {
    renderPastMatchesView(adminArea, matches, page);
  }
}

function renderOpenMatchesView(adminArea, matches) {
  const open = sortByDateDesc(filterOpen(matches));
  const latestOpen = open[0];

  adminArea.innerHTML = `
    <div class="card" id="createCard">
      <div class="h1">Create match</div>
      <input id="title" class="input" placeholder="Title" />
      <input id="date" class="input" type="date" style="margin-top:10px" />
      <input id="time" class="input" type="time" style="margin-top:10px" value="19:00" />
      <select id="type" class="input" style="margin-top:10px">
        <option value="INTERNAL" selected>Internal (Blue vs Orange)</option>
        <option value="OPPONENT">Against opponents (1 captain)</option>
      </select>
      <button id="create" class="btn primary" style="margin-top:10px">Create</button>
      <div id="created" class="small" style="margin-top:10px"></div>
    </div>

    <div class="card">
      <div class="h1">Open matches</div>
      ${
        latestOpen
          ? `<div class="small">Latest open match shown first.</div>`
          : `<div class="small">No OPEN matches. Create one above.</div>`
      }
      <div id="openList" style="margin-top:10px"></div>
    </div>

    <div id="manageArea"></div>
  `;

  // Defaults: INTERNAL, 19:00 already set
  // Create match
  adminArea.querySelector("#create").onclick = async () => {
    const btn = adminArea.querySelector("#create");
    const created = adminArea.querySelector("#created");
    setDisabled(btn, true, "Creating…");

    const adminKey = localStorage.getItem(LS_ADMIN_KEY);

    const payload = {
      title: adminArea.querySelector("#title").value.trim() || "Weekly Match",
      date: adminArea.querySelector("#date").value,
      time: adminArea.querySelector("#time").value || "19:00",
      type: adminArea.querySelector("#type").value
    };

    const out = await API.adminCreateMatch(adminKey, payload);

    setDisabled(btn, false);

    if (!out.ok) {
      created.textContent = out.error || "Failed";
      toastError(out.error || "Failed to create");
      return;
    }

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

    toastSuccess("Match created. Tap Refresh to see it in list.");
  };

  // Render open list (latest at top)
  const openList = adminArea.querySelector("#openList");
   open = sortByDateDesc(filterOpen(matches));

  openList.innerHTML = open.map(m => {
    const locked = String(m.ratingsLocked || "").toUpperCase() === "TRUE";
    return `
      <div style="padding:10px 0; border-bottom:1px solid #eee">
        <div class="row" style="justify-content:space-between">
          <div style="min-width:0">
            <div style="font-weight:950; color: rgba(11,18,32,0.92)">${m.title}</div>
            <div class="small">${m.date} ${m.time} • ${m.type}</div>
          </div>
          <div class="row" style="gap:6px">
            <span class="badge badge--good">OPEN</span>
            ${locked ? `<span class="badge badge--bad">LOCKED</span>` : ""}
          </div>
        </div>

        <div class="row" style="margin-top:8px">
          <button class="btn primary" data-manage="${m.publicCode}">Manage</button>
          <button class="btn gray" data-close="${m.matchId}">Close availability</button>
          <button class="btn gray" data-lock="${m.matchId}">Lock ratings</button>
        </div>
      </div>
    `;
  }).join("") || `<div class="small">No open matches.</div>`;

  bindOpenActions(adminArea);
}

function renderPastMatchesView(adminArea, matches, page) {
  const past = sortByDateDesc(filterPast(matches));
  const total = past.length;
  const totalPages = Math.max(1, Math.ceil(total / 20));
  const p = Math.min(Math.max(page, 1), totalPages);

  const start = (p - 1) * 20;
  const slice = past.slice(start, start + 20);

  adminArea.innerHTML = `
    <div class="card">
      <div class="h1">Past matches</div>
      <div class="small">CLOSED + COMPLETED matches. Page ${p} of ${totalPages}.</div>

      <div class="row" style="margin-top:10px">
        <button class="btn gray" id="prev" ${p <= 1 ? "disabled" : ""}>Prev</button>
        <button class="btn gray" id="next" ${p >= totalPages ? "disabled" : ""}>Next</button>
      </div>
    </div>

    <div class="card">
      <div class="h1">Past list</div>
      <div id="pastList" style="margin-top:10px"></div>
    </div>

    <div id="manageArea"></div>
  `;

  adminArea.querySelector("#prev").onclick = () => {
    location.hash = `#/admin?view=past&page=${p - 1}`;
  };
  adminArea.querySelector("#next").onclick = () => {
    location.hash = `#/admin?view=past&page=${p + 1}`;
  };

  const pastList = adminArea.querySelector("#pastList");
  pastList.innerHTML = slice.map(m => {
    const status = String(m.status || "").toUpperCase();
    const locked = String(m.ratingsLocked || "").toUpperCase() === "TRUE";
    return `
      <div style="padding:10px 0; border-bottom:1px solid #eee">
        <div class="row" style="justify-content:space-between">
          <div style="min-width:0">
            <div style="font-weight:950; color: rgba(11,18,32,0.92)">${m.title}</div>
            <div class="small">${m.date} ${m.time} • ${m.type}</div>
          </div>
          <div class="row" style="gap:6px">
            <span class="badge">${status}</span>
            ${locked ? `<span class="badge badge--bad">LOCKED</span>` : ""}
          </div>
        </div>

        <div class="row" style="margin-top:8px">
          <button class="btn primary" data-manage="${m.publicCode}">Manage</button>
        </div>
      </div>
    `;
  }).join("") || `<div class="small">No past matches.</div>`;

  // Only manage loads (no close/lock here)
  adminArea.querySelectorAll("[data-manage]").forEach(btn => {
    btn.onclick = () => openManage(adminArea, btn, btn.getAttribute("data-manage"));
  });
}

function bindOpenActions(adminArea) {
  // Manage
  adminArea.querySelectorAll("[data-manage]").forEach(btn => {
    btn.onclick = () => openManage(adminArea, btn, btn.getAttribute("data-manage"));
  });

  // Close availability
  adminArea.querySelectorAll("[data-close]").forEach(btn => {
    btn.onclick = async () => {
      const adminKey = localStorage.getItem(LS_ADMIN_KEY);
      const matchId = btn.getAttribute("data-close");

      setDisabled(btn, true, "Closing…");
      const out = await API.adminCloseMatch(adminKey, matchId);
      setDisabled(btn, false);

      if (!out.ok) {
        toastError(out.error || "Failed to close availability");
        return;
      }
      toastSuccess("Availability closed.");
      toastInfo("Tap Refresh to update list.");
    };
  });

  // Lock ratings
  adminArea.querySelectorAll("[data-lock]").forEach(btn => {
    btn.onclick = async () => {
      const adminKey = localStorage.getItem(LS_ADMIN_KEY);
      const matchId = btn.getAttribute("data-lock");

      setDisabled(btn, true, "Locking…");
      const out = await API.adminLockRatings(adminKey, matchId);
      setDisabled(btn, false);

      if (!out.ok) {
        toastError(out.error || "Failed to lock ratings");
        return;
      }
      toastSuccess("Ratings locked.");
      toastInfo("Tap Refresh to update list.");
    };
  });
}

function openManage(adminArea, btn, code) {
  const manageArea = adminArea.querySelector("#manageArea");
  if (!manageArea) return;

  // clear "Opening…" quickly (don’t leave stuck)
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Opening…";

  // render from cache if exists (no auto API call unless not cached)
  const cached = readManageCache(code);
  if (cached) {
    renderManageView(manageArea, cached);
    btn.disabled = false;
    btn.textContent = orig;
    toastInfo("Opened from cache. (No auto refresh)");
    return;
  }

  // fetch once only if not cached
  API.getPublicMatch(code).then(res => {
    btn.disabled = false;
    btn.textContent = orig;

    if (!res.ok) {
      toastError(res.error || "Failed to load match");
      manageArea.innerHTML = `<div class="card"><div class="h1">Error</div><div class="small">${res.error}</div></div>`;
      return;
    }

    writeManageCache(code, res);
    renderManageView(manageArea, res);
  }).catch(() => {
    btn.disabled = false;
    btn.textContent = orig;
    toastError("Failed to load match");
  });
}

function renderManageView(manageArea, data) {
  const adminKey = localStorage.getItem(LS_ADMIN_KEY);
  const m = data.match;
  const status = String(m.status || "").toUpperCase();
  const locked = String(m.ratingsLocked || "").toUpperCase() === "TRUE";
  const isEditLocked = locked || status === "CLOSED" || status === "COMPLETED";
  const type = String(m.type || "").toUpperCase();

  const avail = data.availability || [];
  const yesPlayers = uniqueSorted(avail.filter(a => String(a.availability).toUpperCase() === "YES").map(a => a.playerName));

  const captains = data.captains || {};
  const teams = data.teams || [];

  // Header
  manageArea.innerHTML = `
    <div class="card">
      <div class="h1">Manage: ${m.title}</div>
      <div class="row">
        <span class="badge">${m.type}</span>
        <span class="badge">${m.status}</span>
        ${locked ? `<span class="badge badge--bad">LOCKED</span>` : `<span class="badge badge--good">EDITABLE</span>`}
      </div>

      <div class="small" style="margin-top:10px; word-break:break-all">
        Match link: ${matchLink(m.publicCode)}
      </div>

      <div class="row" style="margin-top:12px">
        <button class="btn primary" id="shareMatch">Share match link</button>
        <button class="btn gray" id="unlockBtn" ${isEditLocked ? "" : "disabled"}>Unlock match</button>
      </div>

      <div class="small" style="margin-top:10px">
        ${isEditLocked ? "Edits locked. Unlock match to edit teams/captains." : "Edits allowed."}
      </div>
    </div>

    <div id="manageBody"></div>
  `;

  manageArea.querySelector("#shareMatch").onclick = () => {
    waOpenPrefill(`Manor Lakes FC match link:\n${matchLink(m.publicCode)}`);
    toastInfo("WhatsApp opened with match link.");
  };

  manageArea.querySelector("#unlockBtn").onclick = async () => {
    const btn = manageArea.querySelector("#unlockBtn");
    setDisabled(btn, true, "Unlocking…");
    const out = await API.adminUnlockMatch(adminKey, m.matchId);
    setDisabled(btn, false);

    if (!out.ok) {
      toastError(out.error || "Failed to unlock");
      return;
    }

    toastSuccess("Match unlocked.");
    toastInfo("Tap Refresh to update open/past list if needed.");

    // Refresh this manage view (one call)
    const fresh = await API.getPublicMatch(m.publicCode);
    if (!fresh.ok) {
      toastError(fresh.error || "Failed to reload");
      return;
    }
    writeManageCache(m.publicCode, fresh);
    renderManageView(manageArea, fresh);
  };

  const body = manageArea.querySelector("#manageBody");

  if (type === "OPPONENT") {
    renderOpponentManage(body, data, yesPlayers, isEditLocked);
  } else {
    renderInternalManage(body, data, yesPlayers, teams, captains, isEditLocked);
  }

  // local helpers
  function renderOpponentManage(container, data2, yesPlayers2, isEditLocked2) {
    const m2 = data2.match;
    const cap = String((data2.captains || {}).captain1 || "").trim();
    const capUrl = cap ? captainLink(m2.publicCode, cap) : "";

    container.innerHTML = `
      <div class="card">
        <div class="h1">Opponent match captain</div>
        <div class="small">Captain enters ratings for OUR players.</div>

        <select id="captainSel" class="input" style="margin-top:10px" ${isEditLocked2 ? "disabled" : ""}>
          <option value="">Select captain</option>
          ${yesPlayers2.map(p => `<option value="${p}">${p}</option>`).join("")}
        </select>

        <div class="row" style="margin-top:10px">
          <button class="btn primary" id="saveCap" ${isEditLocked2 ? "disabled" : ""}>Save captain</button>
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
            : `<div class="small">Captain link will appear after saving captain.</div>`
        }

        <div class="row" style="margin-top:14px">
          <button class="btn primary" id="lockRatings" ${String(m2.ratingsLocked).toUpperCase() === "TRUE" ? "disabled" : ""}>Lock ratings</button>
        </div>

        <div class="small" id="msg" style="margin-top:10px"></div>
      </div>
    `;

    const capSel = container.querySelector("#captainSel");
    capSel.value = cap || "";

    container.querySelector("#saveCap").onclick = async () => {
      const btn = container.querySelector("#saveCap");
      const msg = container.querySelector("#msg");
      const sel = capSel.value.trim();
      if (!sel) { toastWarn("Select a captain."); return; }

      setDisabled(btn, true, "Saving…");
      msg.textContent = "Saving…";
      const out = await API.adminSetupOpponent(adminKey, { matchId: m2.matchId, captain: sel });
      setDisabled(btn, false);

      if (!out.ok) {
        msg.textContent = out.error || "Failed";
        toastError(out.error || "Failed to save captain");
        return;
      }

      msg.textContent = "Saved ✅";
      toastSuccess("Captain saved.");

      const fresh = await API.getPublicMatch(m2.publicCode);
      if (fresh.ok) {
        writeManageCache(m2.publicCode, fresh);
        renderManageView(manageArea, fresh);
      }
    };

    const shareCap = container.querySelector("#shareCap");
    if (shareCap) {
      shareCap.onclick = () => {
        waOpenPrefill(`Captain link:\n${capUrl}`);
        toastInfo("WhatsApp opened with captain link.");
      };
    }

    container.querySelector("#lockRatings").onclick = async () => {
      const btn = container.querySelector("#lockRatings");
      setDisabled(btn, true, "Locking…");
      const out = await API.adminLockRatings(adminKey, m2.matchId);
      setDisabled(btn, false);

      if (!out.ok) {
        toastError(out.error || "Failed to lock ratings");
        return;
      }

      toastSuccess("Ratings locked.");
      toastInfo("Tap Refresh to update open/past list.");

      const fresh = await API.getPublicMatch(m2.publicCode);
      if (fresh.ok) {
        writeManageCache(m2.publicCode, fresh);
        renderManageView(manageArea, fresh);
      }
    };
  }

  function renderInternalManage(container, data2, yesPlayers2, teams2, captains2, isEditLocked2) {
    const m2 = data2.match;

    // local state from server
    let blue = uniqueSorted(teams2.filter(t => t.team === "BLUE").map(t => t.playerName));
    let orange = uniqueSorted(teams2.filter(t => t.team === "ORANGE").map(t => t.playerName));
    let captainBlue = String(captains2.captain1 || "").trim();
    let captainOrange = String(captains2.captain2 || "").trim();

    function capLinksReady() {
      return captainBlue && captainOrange && (blue.length + orange.length) > 0;
    }

    container.innerHTML = `
      <div class="card">
        <div class="h1">Internal setup</div>
        <div class="small">
          Team selection is disabled when match is locked/closed/completed. Use Unlock match first.
        </div>

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
          <button class="btn primary" id="saveSetup" ${isEditLocked2 ? "disabled" : ""}>Save setup</button>
          <button class="btn primary" id="shareTeams" ${capLinksReady() ? "" : "disabled"}>Share teams</button>
        </div>

        <div id="setupMsg" class="small" style="margin-top:10px"></div>
      </div>

      <div class="card">
        <div class="h1">Captain links</div>
        ${
          capLinksReady()
            ? `
              <div class="row" style="align-items:flex-start; justify-content:space-between">
                <div style="flex:1; min-width:0">
                  <div class="small"><b>Blue captain:</b> ${captainBlue}</div>
                  <div class="small" style="word-break:break-all">${captainLink(m2.publicCode, captainBlue)}</div>
                </div>
                <button class="btn primary" id="shareBlueCap">Share</button>
              </div>

              <div class="hr"></div>

              <div class="row" style="align-items:flex-start; justify-content:space-between">
                <div style="flex:1; min-width:0">
                  <div class="small"><b>Orange captain:</b> ${captainOrange}</div>
                  <div class="small" style="word-break:break-all">${captainLink(m2.publicCode, captainOrange)}</div>
                </div>
                <button class="btn primary" id="shareOrangeCap">Share</button>
              </div>
            `
            : `<div class="small">Captain links will appear after you Save setup (teams + captains).</div>`
        }

        <div class="row" style="margin-top:14px">
          <button class="btn primary" id="lockRatings" ${String(m2.ratingsLocked).toUpperCase() === "TRUE" ? "disabled" : ""}>
            Lock ratings
          </button>
        </div>
        <div id="capMsg" class="small" style="margin-top:10px"></div>
      </div>
    `;

    // Render functions
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

    function renderTeamTable() {
      const tbody = container.querySelector("#teamTableBody");

      tbody.innerHTML = yesPlayers2.map(p => {
        const a = assignedTeam(p);
        const blueDisabled = (a === "ORANGE") || isEditLocked2;
        const orangeDisabled = (a === "BLUE") || isEditLocked2;
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
      const blueEl = container.querySelector("#blueList");
      const orangeEl = container.querySelector("#orangeList");

      function listHtml(players, teamName) {
        if (!players.length) return `<div class="small">No players yet.</div>`;
        return players.map(p => {
          const isCap = (teamName === "BLUE" ? captainBlue === p : captainOrange === p);
          const disabled = isEditLocked2 ? "disabled" : "";
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

      container.querySelectorAll("[data-cap]").forEach(cb => {
        cb.onchange = () => {
          const teamName = cb.getAttribute("data-cap");
          const p = decodeURIComponent(cb.getAttribute("data-player"));
          if (teamName === "BLUE") captainBlue = cb.checked ? p : "";
          if (teamName === "ORANGE") captainOrange = cb.checked ? p : "";
          renderAll();
        };
      });

      container.querySelectorAll("[data-remove-player]").forEach(btn => {
        btn.onclick = () => {
          const p = decodeURIComponent(btn.getAttribute("data-remove-player"));
          removePlayer(p);
          renderAll();
        };
      });
    }

    function updateButtons() {
      const shareTeams = container.querySelector("#shareTeams");
      if (shareTeams) shareTeams.disabled = !capLinksReady();

      // Captain links share buttons exist only if capLinksReady, but check anyway
      const shareBlue = container.querySelector("#shareBlueCap");
      const shareOrange = container.querySelector("#shareOrangeCap");
      if (shareBlue) shareBlue.disabled = !captainBlue;
      if (shareOrange) shareOrange.disabled = !captainOrange;
    }

    function renderAll() {
      blue = uniqueSorted(blue);
      orange = uniqueSorted(orange);
      renderTeamTable();
      renderLists();
      updateButtons();
    }

    renderAll();

    // Save setup
    container.querySelector("#saveSetup").onclick = async () => {
      if (isEditLocked2) {
        toastWarn("Match is locked. Unlock match to edit.");
        return;
      }

      const msg = container.querySelector("#setupMsg");
      const btn = container.querySelector("#saveSetup");
      setDisabled(btn, true, "Saving…");
      msg.textContent = "Saving…";

      if (!captainBlue || !captainOrange) {
        setDisabled(btn, false);
        msg.textContent = "Select captains for BOTH teams.";
        toastWarn("Select captains for both teams.");
        return;
      }

      const out = await API.adminSetupInternal(adminKey, {
        matchId: m2.matchId,
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

      // Reload manage view (one call) so captain links appear
      const fresh = await API.getPublicMatch(m2.publicCode);
      if (fresh.ok) {
        writeManageCache(m2.publicCode, fresh);
        renderManageView(manageArea, fresh);
      }
    };

    // Share teams
    container.querySelector("#shareTeams").onclick = () => {
      const btn = container.querySelector("#shareTeams");
      setDisabled(btn, true, "Opening…");

      const lines = [];
      lines.push(`Match: ${m2.title}`);
      lines.push(`Type: INTERNAL`);
      lines.push(`Link: ${matchLink(m2.publicCode)}`);
      lines.push("");
      lines.push(`BLUE Captain: ${captainBlue || "-"}`);
      (blue.length ? blue : ["-"]).forEach((p, i) => lines.push(`${i + 1}. ${p}`));
      lines.push("");
      lines.push(`ORANGE Captain: ${captainOrange || "-"}`);
      (orange.length ? orange : ["-"]).forEach((p, i) => lines.push(`${i + 1}. ${p}`));
      lines.push("");
      if (captainBlue) lines.push(`Blue Captain Link: ${captainLink(m2.publicCode, captainBlue)}`);
      if (captainOrange) lines.push(`Orange Captain Link: ${captainLink(m2.publicCode, captainOrange)}`);

      waOpenPrefill(lines.join("\n"));
      toastInfo("WhatsApp opened with teams.");
      setTimeout(() => setDisabled(btn, false), 900);
    };

    // Captain link share buttons (only after save)
    const shareBlueCap = container.querySelector("#shareBlueCap");
    if (shareBlueCap) {
      shareBlueCap.onclick = () => {
        const btn = shareBlueCap;
        setDisabled(btn, true, "Opening…");
        waOpenPrefill(`Blue captain link:\n${captainLink(m2.publicCode, captainBlue)}`);
        toastInfo("WhatsApp opened with Blue captain link.");
        setTimeout(() => setDisabled(btn, false), 900);
      };
    }

    const shareOrangeCap = container.querySelector("#shareOrangeCap");
    if (shareOrangeCap) {
      shareOrangeCap.onclick = () => {
        const btn = shareOrangeCap;
        setDisabled(btn, true, "Opening…");
        waOpenPrefill(`Orange captain link:\n${captainLink(m2.publicCode, captainOrange)}`);
        toastInfo("WhatsApp opened with Orange captain link.");
        setTimeout(() => setDisabled(btn, false), 900);
      };
    }

    // Lock ratings
    container.querySelector("#lockRatings").onclick = async () => {
      const btn = container.querySelector("#lockRatings");
      setDisabled(btn, true, "Locking…");
      const out = await API.adminLockRatings(adminKey, m2.matchId);
      setDisabled(btn, false);

      if (!out.ok) {
        toastError(out.error || "Failed to lock ratings");
        return;
      }

      toastSuccess("Ratings locked.");
      toastInfo("Tap Refresh to update open/past list.");

      const fresh = await API.getPublicMatch(m2.publicCode);
      if (fresh.ok) {
        writeManageCache(m2.publicCode, fresh);
        renderManageView(manageArea, fresh);
      }
    };
  }
}

export async function renderAdminPage(root) {
  const key = localStorage.getItem(LS_ADMIN_KEY);
  if (!key) {
    renderLogin(root);
    return;
  }
  renderAdminShell(root);
}
