import { API } from "../api/endpoints.js";
import { toastSuccess, toastError, toastInfo, toastWarn } from "../ui/toast.js";

function baseUrl() {
  return location.href.split("#")[0];
}

function setDisabled(btn, disabled, busyText) {
  if (!btn) return;
  btn.disabled = disabled;
  if (busyText) {
    if (!btn.dataset.origText) btn.dataset.origText = btn.textContent;
    btn.textContent = disabled ? busyText : btn.dataset.origText;
  }
}

function normalizeTeams(teams) {
  const map = {};
  (teams || []).forEach(t => {
    const p = String(t.playerName || "").trim();
    const team = String(t.team || "").toUpperCase();
    if (!p) return;
    if (team === "BLUE" || team === "ORANGE") map[p] = team;
  });
  return map;
}

export async function renderCaptainPage(root, query) {
  const code = query.get("code");
  const captain = (query.get("captain") || "").trim();

  if (!code) {
    root.innerHTML = `<div class="card"><div class="h1">Captain</div><div class="small">Missing match code.</div></div>`;
    toastWarn("Missing match code.");
    return;
  }
  if (!captain) {
    root.innerHTML = `<div class="card"><div class="h1">Captain</div><div class="small">Missing captain name in link.</div></div>`;
    toastWarn("Missing captain name in link.");
    return;
  }

  const data = await API.getPublicMatch(code);
  if (!data.ok) {
    root.innerHTML = `<div class="card"><div class="h1">Error</div><div class="small">${data.error}</div></div>`;
    toastError(data.error || "Failed to load match");
    return;
  }

  const m = data.match;
  const locked = String(m.ratingsLocked || "").toUpperCase() === "TRUE";
  const type = String(m.type || "").toUpperCase();

  const captains = data.captains || {};
  const capName = captain.toLowerCase();

  // Determine captain team for INTERNAL
  let captainTeam = null; // BLUE | ORANGE | MLFC
  if (String(captains.captain1 || "").trim().toLowerCase() === capName) {
    captainTeam = String(captains.captain1Team || "MLFC").toUpperCase();
  }
  if (String(captains.captain2 || "").trim().toLowerCase() === capName) {
    captainTeam = String(captains.captain2Team || "").toUpperCase();
  }

  // Our available players
  const availYes = (data.availability || [])
    .filter(a => String(a.availability || "").toUpperCase() === "YES")
    .map(a => String(a.playerName || "").trim())
    .filter(Boolean);
  const uniqueYes = [...new Set(availYes)].sort();

  // Internal teams (from admin)
  const teamMap = normalizeTeams(data.teams || {});
  // For internal, we want all players who are part of either team (if present)
  const allInternalPlayers = [...new Set(Object.keys(teamMap))].sort();

  // UI state: for INTERNAL, allow editing the team assignment locally
  // Start with admin-assigned teamMap; captains can change per player.
  const uiTeam = { ...teamMap };

  function computeOpponents() {
    if (type !== "INTERNAL") return [];
    if (captainTeam !== "BLUE" && captainTeam !== "ORANGE") return [];
    return allInternalPlayers.filter(p => {
      const t = uiTeam[p] || "";
      return t && t !== captainTeam; // opponents only
    }).sort();
  }

  function computeMyTeam() {
    if (type !== "INTERNAL") return [];
    if (captainTeam !== "BLUE" && captainTeam !== "ORANGE") return [];
    return allInternalPlayers.filter(p => (uiTeam[p] || "") === captainTeam).sort();
  }

  // For OPPONENT, captain rates OUR players (YES list)
  const opponentTargets = uniqueYes;

  root.innerHTML = `
    <div class="card">
      <div class="h1">Captain Panel</div>
      <div class="small"><b>${captain}</b> — ${m.title}</div>
      <div class="row" style="margin-top:10px">
        <span class="badge">${m.type}</span>
        <span class="badge">${locked ? "RATINGS LOCKED" : "RATINGS OPEN"}</span>
      </div>
      <div class="small" style="margin-top:8px">Match link: ${baseUrl()}#/match?code=${m.publicCode}</div>
    </div>

    <div class="card">
      <div class="h1">Submit Score</div>
      ${locked ? `<div class="small">Locked by admin.</div>` : `
        <div class="small">
          INTERNAL: both captains must submit and scores must match to confirm (recommended backend behavior).
        </div>
        <div class="row" style="margin-top:10px">
          <input id="scoreFor" class="input" type="number" min="0"
            placeholder="${type === "INTERNAL" ? (captainTeam === "ORANGE" ? "Orange goals" : "Blue goals") : "Manor Lakes goals"}"
            style="flex:1" />
          <input id="scoreAgainst" class="input" type="number" min="0"
            placeholder="${type === "INTERNAL" ? (captainTeam === "ORANGE" ? "Blue goals" : "Orange goals") : "Opponent goals"}"
            style="flex:1" />
        </div>
        <button id="submitScore" class="btn primary" style="margin-top:10px">Submit score</button>
        <div id="scMsg" class="small" style="margin-top:8px"></div>
      `}
    </div>

    ${
      type === "INTERNAL"
        ? `
          <div class="card">
            <div class="h1">Team adjustments</div>
            <div class="small">
              If players swapped teams during the match, update their team here before rating.
              Ratings will apply to the opponents list based on these selections.
            </div>

            <div id="teamAdjust" style="margin-top:12px"></div>
          </div>

          <div class="card">
            <div class="h1">Rate opponents</div>
            ${locked ? `<div class="small">Locked by admin.</div>` : `
              <div class="small">Only opponents are shown (based on team selection above).</div>
              <div id="ratingsArea" style="margin-top:12px"></div>
              <button id="submitAllRatings" class="btn primary" style="margin-top:12px">Submit all ratings</button>
              <div id="rtMsg" class="small" style="margin-top:8px"></div>
            `}
          </div>
        `
        : `
          <div class="card">
            <div class="h1">Rate our players</div>
            ${locked ? `<div class="small">Locked by admin.</div>` : `
              <div class="small">Enter ratings (1–10) and submit once.</div>
              <div id="ratingsArea" style="margin-top:12px"></div>
              <button id="submitAllRatings" class="btn primary" style="margin-top:12px">Submit all ratings</button>
              <div id="rtMsg" class="small" style="margin-top:8px"></div>
            `}
          </div>
        `
    }
  `;

  if (locked) {
    toastInfo("Ratings are locked for this match.");
    return;
  }

  // Score submit
  const scoreBtn = root.querySelector("#submitScore");
  if (scoreBtn) {
    scoreBtn.onclick = async () => {
      const scoreFor = Number(root.querySelector("#scoreFor").value);
      const scoreAgainst = Number(root.querySelector("#scoreAgainst").value);

      if (!Number.isFinite(scoreFor) || !Number.isFinite(scoreAgainst)) {
        toastWarn("Enter valid scores.");
        return;
      }

      setDisabled(scoreBtn, true, "Submitting…");
      const out = await API.captainSubmitScore(code, captain, captainTeam || "", scoreFor, scoreAgainst);
      setDisabled(scoreBtn, false);

      root.querySelector("#scMsg").textContent = out.ok ? "Score submitted ✅" : (out.error || "Failed");
      if (!out.ok) toastError(out.error || "Failed to submit score");
      else toastSuccess("Score submitted.");
    };
  }

  // Render internal team adjustment UI
  if (type === "INTERNAL") {
    const teamAdjustEl = root.querySelector("#teamAdjust");

    if (captainTeam !== "BLUE" && captainTeam !== "ORANGE") {
      teamAdjustEl.innerHTML = `<div class="small">You are not recognized as a captain for this match.</div>`;
    } else if (!allInternalPlayers.length) {
      teamAdjustEl.innerHTML = `<div class="small">Teams are not set yet by admin.</div>`;
    } else {
      teamAdjustEl.innerHTML = allInternalPlayers.map(p => {
        const t = uiTeam[p] || "";
        return `
          <div class="row" style="align-items:center; margin-top:8px">
            <div style="flex:1"><b>${p}</b></div>
            <select class="input" data-team-player="${encodeURIComponent(p)}" style="width:140px">
              <option value="">(none)</option>
              <option value="BLUE" ${t === "BLUE" ? "selected" : ""}>Blue</option>
              <option value="ORANGE" ${t === "ORANGE" ? "selected" : ""}>Orange</option>
            </select>
          </div>
        `;
      }).join("");

      teamAdjustEl.querySelectorAll("[data-team-player]").forEach(sel => {
        sel.onchange = () => {
          const p = decodeURIComponent(sel.getAttribute("data-team-player"));
          const v = sel.value;
          uiTeam[p] = v;
          renderRatingsArea(); // update opponents list instantly
        };
      });

      // Add small summary of current split
      const summary = document.createElement("div");
      summary.className = "note";
      summary.style.marginTop = "12px";
      teamAdjustEl.appendChild(summary);

      function updateSummary() {
        const mine = computeMyTeam();
        const opp = computeOpponents();
        summary.innerHTML = `
          <b>Your team (${captainTeam})</b>: ${mine.length ? mine.join(", ") : "-"}<br/>
          <b>Opponents</b>: ${opp.length ? opp.join(", ") : "-"}
        `;
      }

      function renderRatingsArea() {
        const targets = computeOpponents();
        const area = root.querySelector("#ratingsArea");
        if (!area) return;

        updateSummary();

        if (!targets.length) {
          area.innerHTML = `<div class="small">No opponents found. Update team assignments above.</div>`;
          return;
        }

        area.innerHTML = targets.map(p => `
          <div class="row" style="align-items:center; margin-top:8px">
            <div style="flex:1"><b>${p}</b></div>
            <input class="input" data-player="${encodeURIComponent(p)}" type="number" min="1" max="10"
                   placeholder="1-10" style="width:110px" />
          </div>
        `).join("");
      }

      // initial render
      var renderRatingsArea = renderRatingsArea; // keep function in scope for onchange
      renderRatingsArea();
    }
  }

  // Render ratings area for OPPONENT
  if (type !== "INTERNAL") {
    const area = root.querySelector("#ratingsArea");
    if (!opponentTargets.length) {
      area.innerHTML = `<div class="small">No YES players found. Ask players to submit availability first.</div>`;
    } else {
      area.innerHTML = opponentTargets.map(p => `
        <div class="row" style="align-items:center; margin-top:8px">
          <div style="flex:1"><b>${p}</b></div>
          <input class="input" data-player="${encodeURIComponent(p)}" type="number" min="1" max="10"
                 placeholder="1-10" style="width:110px" />
        </div>
      `).join("");
    }
  }

  // Submit all ratings
  const submitRatingsBtn = root.querySelector("#submitAllRatings");
  if (submitRatingsBtn) {
    submitRatingsBtn.onclick = async () => {
      const inputs = [...root.querySelectorAll("input[data-player]")];
      const ratings = inputs.map(i => ({
        playerName: decodeURIComponent(i.getAttribute("data-player")),
        rating: Number(i.value)
      })).filter(x => x.rating >= 1 && x.rating <= 10);

      if (!ratings.length) {
        toastWarn("Enter at least one rating (1–10).");
        return;
      }

      setDisabled(submitRatingsBtn, true, "Submitting…");
      const out = await API.captainSubmitRatingsBatch(code, captain, ratings);
      setDisabled(submitRatingsBtn, false);

      const msg = root.querySelector("#rtMsg");
      if (msg) msg.textContent = out.ok ? "Ratings submitted ✅" : (out.error || "Failed");

      if (!out.ok) toastError(out.error || "Failed to submit ratings");
      else toastSuccess("Ratings submitted.");
    };
  }
}
