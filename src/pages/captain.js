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
  // Default roster = YES + MAYBE (people likely to play)
  const yes = avail.filter(a => a.availability === "YES").map(a => a.playerName);
  const maybe = avail.filter(a => a.availability === "MAYBE").map(a => a.playerName);
  return uniqueSorted([...yes, ...maybe]);
}



function normalizeNameForCompare(s) {
  return String(s || "").trim().toLowerCase();
}

function inferCaptainTeamFromMatch(data, captainName) {
  // For INTERNAL matches: captains.captain1 = Blue captain, captains.captain2 = Orange captain (per admin setup)
  try {
    const cap = normalizeNameForCompare(captainName);
    const c1 = normalizeNameForCompare(data?.captains?.captain1);
    const c2 = normalizeNameForCompare(data?.captains?.captain2);
    if (cap && c1 && cap == c1) return "BLUE";
    if (cap && c2 && cap == c2) return "ORANGE";
  } catch {}
  return "";
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
  const captainTeam = (type === "INTERNAL") ? inferCaptainTeamFromMatch(data, captain) : "";
  const when = formatHumanDateTime(m.date, m.time);

  if (locked || status === "COMPLETED") {
    root.innerHTML = `
      <div class="card">
        <div class="h1">${m.title}</div>
        <div class="small">${when} • ${m.type}</div>
        <div class="small" style="margin-top:10px">Ratings are locked.</div>
      </div>
    `;
    return;
  }

  const avail = normalizeAvail(data.availability || []);
  const postedPlayers = uniqueSorted(avail.map(a => a.playerName)); // all who posted (YES/NO/MAYBE)

  // Load global players list for "Add player"
  const playersRes = await API.players();
  const allPlayers = playersRes.ok ? uniqueSorted((playersRes.players || []).map(p => p.name)) : [];

  // Roster cache (captain-specific)
  const cachedRoster = lsGet(rosterKey(code, captain));
  let roster = cachedRoster?.roster && Array.isArray(cachedRoster.roster)
    ? uniqueSorted(cachedRoster.roster)
    : initialRosterFromAvailability(avail);

  // Team map cache (shared by match)
  const cachedTeams = lsGet(teamsKey(code));
  let teamMap = (cachedTeams?.teamMap && typeof cachedTeams.teamMap === "object") ? cachedTeams.teamMap : {};

  // If server has teams (internal) prefer them initially
  (data.teams || []).forEach(t => {
    const p = String(t.playerName || "").trim();
    const tm = String(t.team || "").toUpperCase();
    if (p && (tm === "BLUE" || tm === "ORANGE")) teamMap[p] = tm;
  });

  // For any roster player missing team, set defaults
  roster.forEach(p => {
    if (!teamMap[p]) teamMap[p] = "BLUE";
  });

  function saveRosterLocal() {
    lsSet(rosterKey(code, captain), { ts: Date.now(), roster });
  }
  function saveTeamsLocal() {
    lsSet(teamsKey(code), { ts: Date.now(), teamMap });
  }

  saveRosterLocal();
  saveTeamsLocal();

  root.innerHTML = `
    <div class="card">
      <div class="h1">${m.title}</div>
      <div class="row">
        <span class="badge">${m.type}</span>
        <span class="badge">${m.status}</span>
      </div>
      <div class="small" style="margin-top:10px">${when}</div>
      <div class="small" style="margin-top:6px"><b>Captain:</b> ${captain}</div>
      <div class="row" style="margin-top:12px">
        <button class="btn gray" id="openMatch">Open match</button>
      </div>
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
      ${type === "INTERNAL" && captainTeam ? `<div class="small" style="margin-top:8px"><b>Rule:</b> You can only rate <b>${captainTeam === "BLUE" ? "Orange" : "Blue"}</b> players. Swap players between teams if needed.</div>` : ""}

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

      <div style="margin-top:12px; overflow:auto; border-radius:14px; border:1px solid rgba(11,18,32,0.10)">
        <table style="width:100%; border-collapse:collapse; min-width:680px">
          <thead>
            <tr style="background: rgba(11,18,32,0.04)">
              <th style="text-align:left; padding:10px; font-size:12px; color:rgba(11,18,32,0.72)">Player</th>
              <th style="text-align:center; padding:10px; font-size:12px; color:rgba(11,18,32,0.72)">Team</th>
              <th style="text-align:center; padding:10px; font-size:12px; color:rgba(11,18,32,0.72)">Rating</th>
              <th style="text-align:center; padding:10px; font-size:12px; color:rgba(11,18,32,0.72)">Remove</th>
            </tr>
          </thead>
          <tbody id="body"></tbody>
        </table>
      </div>

      <div class="row" style="margin-top:12px">
        <button class="btn primary" id="submitRatings">Submit ratings</button>
      </div>
      <div class="small" id="rateMsg" style="margin-top:10px"></div>
    </div>
  `;

  root.querySelector("#openMatch").onclick = () => {
    location.hash = `#/match?code=${encodeURIComponent(code)}`;
  };

  // Score
  root.querySelector("#submitScore").onclick = async () => {
    const btn = root.querySelector("#submitScore");
    const msg = root.querySelector("#scoreMsg");
    const a = Number(root.querySelector("#scoreA").value || 0);
    const b = Number(root.querySelector("#scoreB").value || 0);

    setDisabled(btn, true, "Submitting…");
    msg.textContent = "Submitting…";

    // For internal, treat A=Blue, B=Orange
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
  const searchEl = root.querySelector("#search");

  function renderRows() {
    const f = String(searchEl.value || "").trim().toLowerCase();
    const list = f ? roster.filter(p => p.toLowerCase().includes(f)) : roster;

    bodyEl.innerHTML = list.map(p => {
      const tm = (teamMap[p] || "BLUE").toUpperCase();
      const canRate = !(type === "INTERNAL" && captainTeam && tm === captainTeam);
      return `
        <tr style="border-top:1px solid rgba(11,18,32,0.06)">
          <td style="padding:10px; font-weight:950">${p}</td>

          <td style="padding:10px; text-align:center">
            <div class="row" style="gap:8px; justify-content:center">
              <button class="btn good compactBtn" data-team="BLUE" data-p="${encodeURIComponent(p)}" ${tm==="BLUE"?"disabled":""}>Blue</button>
              <button class="btn warn compactBtn" data-team="ORANGE" data-p="${encodeURIComponent(p)}" ${tm==="ORANGE"?"disabled":""}>Orange</button>
            </div>
          </td>

          <td style="padding:10px; text-align:center">
            <input class="input" data-rating="${encodeURIComponent(p)}" type="number" min="1" max="10"
              ${type === "INTERNAL" && captainTeam && tm === captainTeam ? 'disabled title="You can only rate opponent team"' : ''}
              placeholder="${type === "INTERNAL" && captainTeam && tm === captainTeam ? 'Opponent only' : '1-10'}"
              style="width:110px; text-align:center" />
          </td>

          <td style="padding:10px; text-align:center">
            <button class="btn gray" data-remove="${encodeURIComponent(p)}" style="padding:8px 10px; border-radius:12px">Remove</button>
          </td>
        </tr>
      `;
    }).join("") || `<tr><td colspan="4" class="small" style="padding:12px">No players in roster.</td></tr>`;

    bodyEl.querySelectorAll("[data-team]").forEach(btn => {
      btn.onclick = () => {
        const team = btn.getAttribute("data-team");
        const p = decodeURIComponent(btn.getAttribute("data-p"));
        teamMap[p] = team;
        saveTeamsLocal();
        renderRows();
      };
    });

    bodyEl.querySelectorAll("[data-remove]").forEach(btn => {
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

  // Submit ratings (batch)
  root.querySelector("#submitRatings").onclick = async () => {
    const btn = root.querySelector("#submitRatings");
    const msg = root.querySelector("#rateMsg");

    const inputs = root.querySelectorAll("[data-rating]");
    const rows = [];
    const invalid = [];

    inputs.forEach(inp => {
      const p = decodeURIComponent(inp.getAttribute("data-rating"));
      const val = Number(inp.value || 0);
      if (!(val >= 1 && val <= 10)) return;

      // INTERNAL rule: captains can only rate opponent team players
      const tm = String(teamMap[p] || "").toUpperCase();
      if (type === "INTERNAL" && captainTeam && tm === captainTeam) {
        invalid.push(p);
        return;
      }

      rows.push({ playerName: p, rating: val, teamAtMatch: teamMap[p] || "" });
    });

    if (!rows.length) return toastWarn("Enter at least one rating (1–10).");

    if (invalid.length) {
      return toastWarn(
        `You can only rate ${captainTeam === "BLUE" ? "Orange" : "Blue"} players for an internal match. Clear ratings for: ${invalid.join(", ")}`
      );
    }


    setDisabled(btn, true, "Submitting…");
    msg.textContent = "Submitting…";

    // This endpoint should store ratings AND (ideally) store teamAtMatch for the match
    const out = await API.captainSubmitRatingsBatch(code, captain, rows);

    setDisabled(btn, false);

    if (!out.ok) {
      msg.textContent = out.error || "Failed";
      toastError(out.error || "Ratings submit failed");
      return;
    }

    // Persist teamMap locally anyway (so reload shows captain’s changes)
    saveTeamsLocal();
    msg.textContent = "Submitted ✅";
    toastSuccess("Ratings submitted.");
  };

  toastInfo("Captain roster uses availability + local cache. No auto refresh.");
}