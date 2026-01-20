// src/pages/captain.js
import { API } from "../api/endpoints.js";
import { toastSuccess, toastError, toastInfo, toastWarn } from "../ui/toast.js";

const LS_CAPTAIN_ROSTER_PREFIX = "mlfc_captain_roster_v1:"; // + code + captain
const LS_CAPTAIN_TEAMS_PREFIX = "mlfc_captain_teams_v1:";   // + code

function lsGet(k){ try{return JSON.parse(localStorage.getItem(k)||"null");}catch{return null;} }
function lsSet(k,v){ try{localStorage.setItem(k,JSON.stringify(v));}catch{} }

function rosterKey(code, captain){ return `${LS_CAPTAIN_ROSTER_PREFIX}${code}:${captain.toLowerCase()}`; }
function teamsKey(code){ return `${LS_CAPTAIN_TEAMS_PREFIX}${code}`; }

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

function formatHumanDateTime(dateStr, timeStr) {
  const d = String(dateStr || "").trim();
  const t = String(timeStr || "").trim();
  if (!d || !t) return `${d || "Unknown date"} ${t || ""}`.trim();
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  const hhmm = m ? `${String(m[1]).padStart(2, "0")}:${m[2]}` : t;
  const dt = new Date(`${d}T${hhmm}:00`);
  if (Number.isNaN(dt.getTime())) return `${d} ${hhmm}`;
  return dt.toLocaleString(undefined, {
    weekday:"short", year:"numeric", month:"short", day:"numeric",
    hour:"numeric", minute:"2-digit"
  });
}

function normalizeAvail(list) {
  return (list || []).map(a => ({
    playerName: String(a.playerName || "").trim(),
    availability: String(a.availability || "").toUpperCase()
  })).filter(x => x.playerName);
}

function initialRosterFromAvailability(avail) {
  const yes = avail.filter(a => a.availability === "YES").map(a => a.playerName);
  const maybe = avail.filter(a => a.availability === "MAYBE").map(a => a.playerName);
  return uniqueSorted([...yes, ...maybe]);
}

function clampInt(x, min=0, max=999) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  const v = Math.floor(n);
  if (v < min || v > max) return null;
  return v;
}

export async function renderCaptainPage(root, query) {
  const code = query.get("code");
  const captain = (query.get("captain") || "").trim();

  if (!code || !captain) {
    root.innerHTML = `<div class="card"><div class="h1">Captain</div><div class="small">Missing code/captain.</div></div>`;
    return;
  }

  root.innerHTML = `<div class="card"><div class="h1">Loading…</div><div class="small">Fetching match…</div></div>`;

  const data = await API.getPublicMatch(code);
  if (!data.ok) {
    root.innerHTML = `<div class="card"><div class="h1">Error</div><div class="small">${data.error}</div></div>`;
    toastError(data.error || "Failed to load match");
    return;
  }

  const m = data.match;
  const type = String(m.type || "").toUpperCase();
  const status = String(m.status || "").toUpperCase();
  const locked = String(m.ratingsLocked || "").toUpperCase() === "TRUE";
  const when = formatHumanDateTime(m.date, m.time);

  if (locked || status === "COMPLETED") {
    root.innerHTML = `
    <style>
      /* responsive roster */
      @media (max-width: 640px){
        #rosterTableWrap{display:none !important;}
        #rosterMobileWrap{display:block !important;}
      }
      @media (min-width: 641px){
        #rosterMobileWrap{display:none !important;}
      }
      .capCard{border:1px solid rgba(11,18,32,0.10); border-radius:14px; padding:12px; margin-top:10px;}
      .capRow{display:flex; gap:10px; align-items:center; flex-wrap:wrap;}
      .capPill{padding:8px 12px; border-radius:999px;}
      .capInputs{display:flex; gap:10px;}
      .capInputs .input{flex:1; min-width:80px;}
    </style>
      <div class="card">
        <div class="h1">${m.title}</div>
        <div class="small">${when} • ${m.type}</div>
        <div class="small" style="margin-top:10px">Ratings are locked.</div>
      </div>
    `;
    return;
  }

  const avail = normalizeAvail(data.availability || []);
  const postedPlayers = uniqueSorted(avail.map(a => a.playerName));

  // players list (for Add)
  const playersRes = await API.players();
  const allPlayers = playersRes.ok ? uniqueSorted((playersRes.players || []).map(p => p.name)) : [];

  // roster (captain-specific)
  const cachedRoster = lsGet(rosterKey(code, captain));
  let roster = cachedRoster?.roster && Array.isArray(cachedRoster.roster)
    ? uniqueSorted(cachedRoster.roster)
    : initialRosterFromAvailability(avail);

  // team map (shared per match)
  const cachedTeams = lsGet(teamsKey(code));
  let teamMap = (cachedTeams?.teamMap && typeof cachedTeams.teamMap === "object") ? cachedTeams.teamMap : {};

  // prefer server teams if present
  (data.teams || []).forEach(t => {
    const p = String(t.playerName || "").trim();
    const tm = String(t.team || "").toUpperCase();
    if (p && (tm === "BLUE" || tm === "ORANGE")) teamMap[p] = tm;
  });

  // ensure captain is on roster
  if (!roster.some(x => x.toLowerCase() === captain.toLowerCase())) {
    roster = uniqueSorted([...roster, captain]);
  }

  // defaults
  roster.forEach(p => { if (!teamMap[p]) teamMap[p] = "BLUE"; });

  // determine captain team for INTERNAL matches
  const capt = data.captains || {};
  let captainTeam = "";
  if (type === "INTERNAL") {
    const c1 = String(capt.captain1 || "").trim();
    const c2 = String(capt.captain2 || "").trim();
    if (c1 && c1.toLowerCase() === captain.toLowerCase()) captainTeam = "BLUE";
    else if (c2 && c2.toLowerCase() === captain.toLowerCase()) captainTeam = "ORANGE";
    else {
      const tm = String(teamMap[captain] || "").toUpperCase();
      if (tm === "BLUE" || tm === "ORANGE") captainTeam = tm;
    }
  }

  function isOpponentPlayer(playerName) {
    if (type !== "INTERNAL") return true;
    if (!captainTeam) return true; // fallback
    const tm = String(teamMap[playerName] || "").toUpperCase();
    if (!tm) return true;
    return tm !== captainTeam;
  }

  function saveRosterLocal() { lsSet(rosterKey(code, captain), { ts: Date.now(), roster }); }
  function saveTeamsLocal() { lsSet(teamsKey(code), { ts: Date.now(), teamMap }); }

  saveRosterLocal();
  saveTeamsLocal();

  root.innerHTML = `
    <style>
      /* Mobile roster: cards instead of a wide table */
      #rosterTableWrap { display:block; }
      #rosterMobileWrap { display:none; }
      @media (max-width: 640px) {
        #rosterTableWrap { display:none; }
        #rosterMobileWrap { display:block; }
      }
      .rosterCard {
        border: 1px solid rgba(11,18,32,0.10);
        border-radius: 14px;
        padding: 12px;
        margin-top: 10px;
        background: rgba(255,255,255,0.6);
      }
      .rosterCard .row { align-items:center; }
      .rosterCard .label { font-size:12px; color: rgba(11,18,32,0.65); }
      .rosterGrid { display:grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
      .rosterGrid .input { width:100%; }
      .teamPills { display:flex; gap:8px; justify-content:flex-start; flex-wrap:wrap; }
      .teamPills .btn { padding: 8px 10px; border-radius: 12px; }
    </style>

    <div class="card">
      <div class="h1">${m.title}</div>
      <div class="row">
        <span class="badge">${m.type}</span>
        <span class="badge">${m.status}</span>
      </div>
      <div class="small" style="margin-top:10px">${when}</div>
      <div class="small" style="margin-top:6px"><b>Captain:</b> ${captain}${type === "INTERNAL" && captainTeam ? ` • <b>Your team:</b> ${captainTeam}` : ""}</div>
      ${type === "INTERNAL" && captainTeam ? `<div class="small" style="margin-top:6px">You can only rate/update <b>opponent</b> players.</div>` : ""}
      <div class="row" style="margin-top:12px; gap:10px; flex-wrap:wrap">
        <button class="btn gray" id="openMatch">Open match</button>
        <button class="btn gray" id="refreshMatch">Refresh match data</button>
      </div>
      <div class="small" id="refreshMsg" style="margin-top:10px"></div>
    </div>

    <div class="card">
      <div class="h1">Score</div>
      <div class="small">${type === "INTERNAL" ? "Enter Blue vs Orange score." : "Enter MLFC vs Opponent score."}</div>

      <div class="row" style="margin-top:10px">
        <input id="scoreA" class="input" type="number" min="0" placeholder="${type === "INTERNAL" ? "Blue score" : "MLFC score"}" style="flex:1" />
        <input id="scoreB" class="input" type="number" min="0" placeholder="${type === "INTERNAL" ? "Orange score" : "Opponent score"}" style="flex:1" />
      </div>

      <div class="row" style="margin-top:10px">
        <button class="btn primary" id="submitScore">Submit score</button>
      </div>
      <div class="small" id="scoreMsg" style="margin-top:10px"></div>
    </div>

    <div class="card">
      <div class="h1">Roster</div>
      <div class="small">Roster starts from YES/MAYBE availability. Add more players if someone joins late.</div>

      <details class="card" style="margin-top:10px">
        <summary style="font-weight:950">Players who posted availability (${postedPlayers.length})</summary>
        <div class="small" style="margin-top:8px">
          ${postedPlayers.map(p => `• ${p}`).join("<br/>") || "None"}
        </div>
      </details>

      <div class="row" style="margin-top:10px; gap:10px; flex-wrap:wrap">
        <select id="addFromAll" class="input" style="flex:1">
          <option value="">Add player from full list…</option>
          ${(allPlayers||[]).map(p => `<option value="${p}">${p}</option>`).join("")}
        </select>
        <button class="btn gray" id="addBtn">Add</button>
      </div>

      <div class="row" style="margin-top:10px">
        <input id="search" class="input" placeholder="Search roster…" />
      </div>

      <!-- Desktop table -->
      <div id="rosterTableWrap" style="margin-top:12px; overflow:auto; border-radius:14px; border:1px solid rgba(11,18,32,0.10)">
        <table style="width:100%; border-collapse:collapse; min-width:780px">
          <thead>
            <tr style="background: rgba(11,18,32,0.04)">
              <th style="text-align:left; padding:10px; font-size:12px; color:rgba(11,18,32,0.72)">Player</th>
              <th style="text-align:center; padding:10px; font-size:12px; color:rgba(11,18,32,0.72)">Team</th>
              <th style="text-align:center; padding:10px; font-size:12px; color:rgba(11,18,32,0.72)">Rating</th>
              <th style="text-align:center; padding:10px; font-size:12px; color:rgba(11,18,32,0.72)">Goals</th>
              <th style="text-align:center; padding:10px; font-size:12px; color:rgba(11,18,32,0.72)">Assists</th>
              <th style="text-align:center; padding:10px; font-size:12px; color:rgba(11,18,32,0.72)">Remove</th>
            </tr>
          </thead>
          <tbody id="body"></tbody>
        </table>
      </div>

      <!-- Mobile cards -->
      <div id="rosterMobileWrap" style="margin-top:12px"></div>

      <div class="row" style="margin-top:12px">
        <button class="btn primary" id="submitRatings">Submit ratings</button>
      </div>
      <div class="small" id="rateMsg" style="margin-top:10px"></div>
    </div>
  `;

  root.querySelector("#openMatch").onclick = () => {
    location.hash = `#/match?code=${encodeURIComponent(code)}`;
  };

  // refresh match data (availability/teams/etc)
  root.querySelector("#refreshMatch").onclick = async () => {
    const btn = root.querySelector("#refreshMatch");
    const msg = root.querySelector("#refreshMsg");
    setDisabled(btn, true, "Refreshing…");
    msg.textContent = "Refreshing…";
    const res = await API.getPublicMatch(code);
    setDisabled(btn, false);
    if (!res.ok) {
      msg.textContent = res.error || "Failed";
      toastError(res.error || "Failed to refresh");
      return;
    }
    msg.textContent = "Refreshed ✅";
    toastSuccess("Match refreshed");
    // rerender fully so roster updates to latest availability teams
    await renderCaptainPage(root, query);
  };

  // Score
  root.querySelector("#submitScore").onclick = async () => {
    const btn = root.querySelector("#submitScore");
    const msg = root.querySelector("#scoreMsg");
    const a = Number(root.querySelector("#scoreA").value || 0);
    const b = Number(root.querySelector("#scoreB").value || 0);

    setDisabled(btn, true, "Submitting…");
    msg.textContent = "Submitting…";

    const out = await API.captainSubmitScore(code, captain, type === "INTERNAL" ? "INTERNAL" : "OPPONENT", a, b);

    setDisabled(btn, false);

    if (!out.ok) {
      msg.textContent = out.error || "Failed";
      toastError(out.error || "Score submit failed");
      return;
    }
    msg.textContent = "Submitted ✅";
    toastSuccess("Score submitted.");
  };

  const bodyEl = root.querySelector("#body");
  const mobileWrap = root.querySelector("#rosterMobileWrap");
  const searchEl = root.querySelector("#search");

  function renderRows() {
    const f = String(searchEl.value || "").trim().toLowerCase();
    const list = f ? roster.filter(p => p.toLowerCase().includes(f)) : roster;

    // desktop table
    bodyEl.innerHTML = list.map(p => {
      const tm = (teamMap[p] || "BLUE").toUpperCase();
      const canEdit = isOpponentPlayer(p);
      return `
        <tr style="border-top:1px solid rgba(11,18,32,0.06)">
          <td style="padding:10px; font-weight:950">${p}</td>
          <td style="padding:10px; text-align:center">
            <div class="row" style="gap:8px; justify-content:center; flex-wrap:wrap">
              <button class="btn good compactBtn" data-team="BLUE" data-p="${encodeURIComponent(p)}" ${tm==="BLUE"?"disabled":""}>Blue</button>
              <button class="btn warn compactBtn" data-team="ORANGE" data-p="${encodeURIComponent(p)}" ${tm==="ORANGE"?"disabled":""}>Orange</button>
            </div>
          </td>
          <td style="padding:10px; text-align:center">
            <input class="input" data-rating="${encodeURIComponent(p)}" type="number" min="1" max="10" placeholder="${canEdit ? "1-10" : "Opponent only"}" style="width:110px; text-align:center" ${canEdit ? "" : "disabled"} />
          </td>
          <td style="padding:10px; text-align:center">
            <input class="input" data-goals="${encodeURIComponent(p)}" type="number" min="0" max="99" placeholder="${canEdit ? "0" : "Opponent only"}" style="width:90px; text-align:center" ${canEdit ? "" : "disabled"} />
          </td>
          <td style="padding:10px; text-align:center">
            <input class="input" data-assists="${encodeURIComponent(p)}" type="number" min="0" max="99" placeholder="${canEdit ? "0" : "Opponent only"}" style="width:90px; text-align:center" ${canEdit ? "" : "disabled"} />
          </td>
          <td style="padding:10px; text-align:center">
            <button class="btn gray" data-remove="${encodeURIComponent(p)}" style="padding:8px 10px; border-radius:12px">Remove</button>
          </td>
        </tr>
      `;
    }).join("") || `<tr><td colspan="6" class="small" style="padding:12px">No players in roster.</td></tr>`;

    // mobile cards
    mobileWrap.innerHTML = list.map(p => {
      const tm = (teamMap[p] || "BLUE").toUpperCase();
      const canEdit = isOpponentPlayer(p);
      return `
        <div class="rosterCard">
          <div style="font-weight:950; font-size:16px">${p}</div>
          <div class="label" style="margin-top:6px">Team</div>
          <div class="teamPills" style="margin-top:6px">
            <button class="btn good" data-team="BLUE" data-p="${encodeURIComponent(p)}" ${tm==="BLUE"?"disabled":""}>Blue</button>
            <button class="btn warn" data-team="ORANGE" data-p="${encodeURIComponent(p)}" ${tm==="ORANGE"?"disabled":""}>Orange</button>
            <button class="btn gray" data-remove="${encodeURIComponent(p)}" style="margin-left:auto">Remove</button>
          </div>
          <div class="rosterGrid">
            <div>
              <div class="label">Rating</div>
              <input class="input" data-rating="${encodeURIComponent(p)}" type="number" min="1" max="10" placeholder="${canEdit ? "1-10" : "Opponent only"}" style="text-align:center" ${canEdit ? "" : "disabled"} />
            </div>
            <div>
              <div class="label">Goals</div>
              <input class="input" data-goals="${encodeURIComponent(p)}" type="number" min="0" max="99" placeholder="${canEdit ? "0" : "Opponent only"}" style="text-align:center" ${canEdit ? "" : "disabled"} />
            </div>
            <div>
              <div class="label">Assists</div>
              <input class="input" data-assists="${encodeURIComponent(p)}" type="number" min="0" max="99" placeholder="${canEdit ? "0" : "Opponent only"}" style="text-align:center" ${canEdit ? "" : "disabled"} />
            </div>
          </div>
        </div>
      `;
    }).join("") || `<div class="small">No players in roster.</div>`;

    // handlers (both desktop + mobile use same data attrs)
    root.querySelectorAll("[data-team]").forEach(btn => {
      btn.onclick = () => {
        const team = btn.getAttribute("data-team");
        const p = decodeURIComponent(btn.getAttribute("data-p"));
        teamMap[p] = team;
        saveTeamsLocal();
        renderRows();
      };
    });

    root.querySelectorAll("[data-remove]").forEach(btn => {
      btn.onclick = () => {
        const p = decodeURIComponent(btn.getAttribute("data-remove"));
        roster = roster.filter(x => x !== p);
        saveRosterLocal();
        renderRows();
      };
    });
  }

  renderRows();
  searchEl.addEventListener("input", renderRows);

  // Add from full list
  root.querySelector("#addBtn").onclick = () => {
    const sel = root.querySelector("#addFromAll");
    const p = String(sel.value || "").trim();
    if (!p) return toastWarn("Select a player to add.");
    if (roster.some(x => x.toLowerCase() === p.toLowerCase())) return toastWarn("Already in roster.");
    roster = uniqueSorted([...roster, p]);
    if (!teamMap[p]) teamMap[p] = "BLUE";
    saveRosterLocal();
    saveTeamsLocal();
    sel.value = "";
    renderRows();
    toastSuccess("Player added to roster.");
  };

  // Submit ratings/goals/assists
  root.querySelector("#submitRatings").onclick = async () => {
    const btn = root.querySelector("#submitRatings");
    const msg = root.querySelector("#rateMsg");

    const rowsByPlayer = new Map();

    // rating
    root.querySelectorAll("[data-rating]").forEach(inp => {
      const p = decodeURIComponent(inp.getAttribute("data-rating"));
      const raw = String(inp.value || "").trim();
      if (!raw) return;
      const val = clampInt(raw, 1, 10);
      if (val == null) return;
      if (!rowsByPlayer.has(p)) rowsByPlayer.set(p, { playerName: p });
      rowsByPlayer.get(p).rating = val;
    });

    // goals
    root.querySelectorAll("[data-goals]").forEach(inp => {
      const p = decodeURIComponent(inp.getAttribute("data-goals"));
      const raw = String(inp.value ?? "").trim();
      if (raw === "") return;
      const val = clampInt(raw, 0, 99);
      if (val == null) return;
      if (!rowsByPlayer.has(p)) rowsByPlayer.set(p, { playerName: p });
      rowsByPlayer.get(p).goals = val;
    });

    // assists
    root.querySelectorAll("[data-assists]").forEach(inp => {
      const p = decodeURIComponent(inp.getAttribute("data-assists"));
      const raw = String(inp.value ?? "").trim();
      if (raw === "") return;
      const val = clampInt(raw, 0, 99);
      if (val == null) return;
      if (!rowsByPlayer.has(p)) rowsByPlayer.set(p, { playerName: p });
      rowsByPlayer.get(p).assists = val;
    });

    let rows = Array.from(rowsByPlayer.values()).map(r => ({
      ...r,
      teamAtMatch: teamMap[r.playerName] || "",
    }));

    // INTERNAL restriction: can only rate/update opponent players
    if (type === "INTERNAL" && captainTeam) {
      const bad = rows.find(r => String(r.teamAtMatch || "").toUpperCase() === captainTeam);
      if (bad) {
        return toastWarn(`You can only rate/update opponent players. Remove inputs for: ${bad.playerName}`);
      }
    }

    if (!rows.length) return toastWarn("Enter at least one rating and/or goals/assists.");

    setDisabled(btn, true, "Submitting…");
    msg.textContent = "Submitting…";

    const out = await API.captainSubmitRatingsBatch(code, captain, rows);

    setDisabled(btn, false);

    if (!out.ok) {
      msg.textContent = out.error || "Failed";
      toastError(out.error || "Submit failed");
      return;
    }

    saveTeamsLocal();

    // Force leaderboard to reload next time (client cache)
    try {
      const seasonId = String(m.seasonId || "");
      if (seasonId) localStorage.removeItem(`mlfc_leaderboard_v2:${seasonId}`);
    } catch {}

    msg.textContent = "Submitted ✅";
    toastSuccess("Submitted.");
    toastInfo("Leaderboard cache cleared. Open Leaderboard and tap Refresh.");
  };
}