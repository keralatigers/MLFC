import { API } from "../api/endpoints.js";
import { toastSuccess, toastError, toastInfo, toastWarn } from "../ui/toast.js";

function baseUrl() { return location.href.split("#")[0]; }
function matchLink(publicCode) { return `${baseUrl()}#/match?code=${publicCode}`; }

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
  const d = new Date(`${dateStr}T${timeStr}:00`);
  return d.toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function normalizeTeams(teamsRows) {
  const map = {};
  (teamsRows || []).forEach(t => {
    const p = String(t.playerName || "").trim();
    const team = String(t.team || "").toUpperCase();
    if (p) map[p] = team;
  });
  return map;
}

function ratingsTargetsForCaptain(matchType, captainName, captainsRow, teamMap, allPlayers) {
  const type = String(matchType || "").toUpperCase();
  const cap1 = String(captainsRow?.captain1 || "").trim().toLowerCase();
  const cap2 = String(captainsRow?.captain2 || "").trim().toLowerCase();
  const me = String(captainName || "").trim().toLowerCase();

  // Opponent match: captain rates OUR players => everyone available/registered; but we’ll rate those in teams if exist; fallback to allPlayers
  if (type === "OPPONENT") {
    return allPlayers.slice();
  }

  // Internal match: captain typically rates "their own team" (per your earlier rule)
  // We’ll interpret: captain rates players who are currently assigned to their team (but captain can flip team toggle).
  // Determine which team "I am" based on captains row:
  const myTeam = (me === cap1) ? "BLUE" : (me === cap2) ? "ORANGE" : "";

  // Default list: players whose team matches myTeam
  const targets = allPlayers.filter(p => (teamMap[p] || "") === myTeam);
  return { myTeam, targets };
}

function buildInitialTeamMap(allPlayers, savedTeamMap) {
  // ensure all players exist in map; if missing, default to BLUE
  const map = {};
  allPlayers.forEach(p => {
    map[p] = savedTeamMap[p] ? String(savedTeamMap[p]).toUpperCase() : "BLUE";
  });
  return map;
}

export async function renderCaptainPage(root, query) {
  const code = query.get("code");
  const captain = query.get("captain");

  if (!code || !captain) {
    root.innerHTML = `
      <div class="card">
        <div class="h1">Captain</div>
        <div class="small">Missing code or captain name.</div>
      </div>
    `;
    return;
  }

  root.innerHTML = `
    <div class="card">
      <div class="h1">Loading…</div>
      <div class="small">Fetching match…</div>
    </div>
  `;

  const data = await API.getPublicMatch(code);
  if (!data.ok) {
    root.innerHTML = `<div class="card"><div class="h1">Error</div><div class="small">${data.error}</div></div>`;
    toastError(data.error || "Failed to load match");
    return;
  }

  const m = data.match;
  const matchType = String(m.type || "").toUpperCase();
  const status = String(m.status || "").toUpperCase();
  const locked = String(m.ratingsLocked || "").toUpperCase() === "TRUE";

  if (locked || status === "COMPLETED") {
    root.innerHTML = `
      <div class="card">
        <div class="h1">${m.title}</div>
        <div class="small">Ratings are locked for this match.</div>
        <div class="small" style="margin-top:10px">Match link: ${matchLink(m.publicCode)}</div>
      </div>
    `;
    toastWarn("Ratings are locked.");
    return;
  }

  // Load players list
  const playersRes = await API.players();
  if (!playersRes.ok) {
    root.innerHTML = `<div class="card"><div class="h1">Error</div><div class="small">${playersRes.error}</div></div>`;
    toastError(playersRes.error || "Failed to load players");
    return;
  }

  const allPlayers = uniqueSorted((playersRes.players || []).map(p => p.name));
  const savedTeamMap = normalizeTeams(data.teams || []);
  let teamMap = buildInitialTeamMap(allPlayers, savedTeamMap);

  const capRow = data.captains || {};
  const myName = String(captain);

  // Determine defaults
  let myTeam = "";
  let defaultTargets = allPlayers.slice();

  if (matchType === "INTERNAL") {
    const res = ratingsTargetsForCaptain(matchType, myName, capRow, savedTeamMap, allPlayers);
    myTeam = res.myTeam;
    defaultTargets = res.targets.length ? res.targets : allPlayers.slice();
  } else {
    defaultTargets = allPlayers.slice();
  }

  // We'll render a single table:
  // - For INTERNAL: each row has Team toggle + Rating input
  // - For OPPONENT: team toggle hidden (not needed)
  const when = formatHumanDateTime(m.date, m.time);

  root.innerHTML = `
    <div class="card">
      <div class="h1">${m.title}</div>
      <div class="row">
        <span class="badge">${m.type}</span>
        <span class="badge">${m.status}</span>
      </div>
      <div class="small" style="margin-top:10px">${when}</div>
      <div class="small" style="margin-top:6px"><b>Captain:</b> ${myName}</div>
      ${matchType === "INTERNAL" ? `<div class="small" style="margin-top:6px"><b>Your team:</b> ${myTeam || "(unknown)"} (you can change players team below)</div>` : ""}

      <div class="row" style="margin-top:12px">
        <button class="btn gray" id="openMatch">Open match page</button>
      </div>
    </div>

    <div class="card">
      <div class="h1">Submit score</div>
      <div class="small">Internal: each captain submits. Score finalization handled by admin/logic.</div>

      <div class="row" style="margin-top:10px">
        <input id="scoreFor" class="input" type="number" min="0" placeholder="Score For" style="flex:1" />
        <input id="scoreAgainst" class="input" type="number" min="0" placeholder="Score Against" style="flex:1" />
      </div>

      <div class="row" style="margin-top:10px">
        <button class="btn primary" id="submitScore">Submit score</button>
      </div>
      <div class="small" id="scoreMsg" style="margin-top:10px"></div>
    </div>

    <div class="card">
      <div class="h1">Ratings</div>
      <div class="small">Fill ratings (1–10) and submit once.</div>

      <input id="search" class="input" placeholder="Search player…" style="margin-top:10px" />

      <div style="margin-top:12px; overflow:auto; border-radius:14px; border:1px solid rgba(11,18,32,0.10)">
        <table style="width:100%; border-collapse:collapse; min-width:${matchType === "INTERNAL" ? "640px" : "520px"}">
          <thead>
            <tr style="background: rgba(11,18,32,0.04)">
              <th style="text-align:left; padding:10px; font-size:12px; color:rgba(11,18,32,0.72)">Player</th>
              ${matchType === "INTERNAL" ? `<th style="text-align:center; padding:10px; font-size:12px; color:rgba(11,18,32,0.72)">Team</th>` : ""}
              <th style="text-align:center; padding:10px; font-size:12px; color:rgba(11,18,32,0.72)">Rating</th>
            </tr>
          </thead>
          <tbody id="ratingsBody"></tbody>
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

  // Score submit
  root.querySelector("#submitScore").onclick = async () => {
    const btn = root.querySelector("#submitScore");
    const msg = root.querySelector("#scoreMsg");

    const scoreFor = Number(root.querySelector("#scoreFor").value || 0);
    const scoreAgainst = Number(root.querySelector("#scoreAgainst").value || 0);

    // Team param: internal -> my team; opponent -> MLFC
    const team = matchType === "INTERNAL" ? (myTeam || "BLUE") : "MLFC";

    setDisabled(btn, true, "Submitting…");
    msg.textContent = "Submitting…";

    const out = await API.captainSubmitScore(code, myName, team, scoreFor, scoreAgainst);

    setDisabled(btn, false);

    if (!out.ok) {
      msg.textContent = out.error || "Failed";
      toastError(out.error || "Score submit failed");
      return;
    }

    msg.textContent = "Submitted ✅";
    toastSuccess("Score submitted.");
  };

  // Ratings table render
  const body = root.querySelector("#ratingsBody");
  const search = root.querySelector("#search");

  // Default display list:
  // - INTERNAL: show all players (because you want ability to move players between teams while rating)
  // - OPPONENT: show all players
  let displayList = allPlayers.slice();

  function renderRows(filterText = "") {
    const f = filterText.trim().toLowerCase();
    const list = f ? displayList.filter(p => p.toLowerCase().includes(f)) : displayList;

    body.innerHTML = list.map(p => {
      const t = (teamMap[p] || "BLUE").toUpperCase();
      return `
        <tr style="border-top:1px solid rgba(11,18,32,0.06)">
          <td style="padding:10px; font-weight:900; color: rgba(11,18,32,0.90)">${p}</td>

          ${matchType === "INTERNAL" ? `
            <td style="padding:10px; text-align:center">
              <div class="row" style="gap:8px; justify-content:center">
                <button class="btn good compactBtn" data-team="BLUE" data-player="${encodeURIComponent(p)}" ${t === "BLUE" ? "disabled" : ""}>Blue</button>
                <button class="btn warn compactBtn" data-team="ORANGE" data-player="${encodeURIComponent(p)}" ${t === "ORANGE" ? "disabled" : ""}>Orange</button>
              </div>
            </td>
          ` : ""}

          <td style="padding:10px; text-align:center">
            <input class="input" data-rating="${encodeURIComponent(p)}" type="number" min="1" max="10" placeholder="1-10" style="width:110px; text-align:center" />
          </td>
        </tr>
      `;
    }).join("");

    // bind team toggle
    if (matchType === "INTERNAL") {
      body.querySelectorAll("[data-team]").forEach(btn => {
        btn.onclick = () => {
          const team = btn.getAttribute("data-team");
          const p = decodeURIComponent(btn.getAttribute("data-player"));
          teamMap[p] = team;
          renderRows(search.value);
        };
      });
    }
  }

  renderRows();
  search.addEventListener("input", () => renderRows(search.value));

  // Submit ratings batch
  root.querySelector("#submitRatings").onclick = async () => {
    const btn = root.querySelector("#submitRatings");
    const msg = root.querySelector("#rateMsg");

    // Collect all ratings from currently rendered inputs AND also from non-rendered if user searched:
    // simplest: scan whole page for [data-rating]
    const inputs = root.querySelectorAll("[data-rating]");
    const rows = [];

    inputs.forEach(inp => {
      const p = decodeURIComponent(inp.getAttribute("data-rating"));
      const val = Number(inp.value || 0);
      if (!(val >= 1 && val <= 10)) return;
      rows.push({ playerName: p, rating: val, teamAtMatch: (teamMap[p] || "") });
    });

    if (!rows.length) {
      toastWarn("Enter at least one rating (1–10).");
      return;
    }

    setDisabled(btn, true, "Submitting…");
    msg.textContent = "Submitting…";

    // Backend currently ignores teamAtMatch unless you add that column; safe to send anyway.
    const out = await API.captainSubmitRatingsBatch(code, myName, rows);

    setDisabled(btn, false);

    if (!out.ok) {
      msg.textContent = out.error || "Failed";
      toastError(out.error || "Ratings submit failed");
      return;
    }

    msg.textContent = "Submitted ✅";
    toastSuccess("Ratings submitted.");
  };

  toastInfo("Captain page loaded. No auto refresh.");
}
