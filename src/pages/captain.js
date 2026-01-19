import { API } from "../api/endpoints.js";
import { toastSuccess, toastError, toastInfo, toastWarn } from "../ui/toast.js";

function baseUrl() {
  return location.href.split("#")[0];
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
    root.innerHTML = `<div class="card"><div class="h1">Error</div><div>${data.error}</div></div>`;
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

  const availYes = (data.availability || []).filter(a => a.availability === "YES").map(a => a.playerName);
  const uniqueYes = [...new Set(availYes)].sort();

  const teams = data.teams || [];
  const bluePlayers = teams.filter(t => t.team === "BLUE").map(t => t.playerName).sort();
  const orangePlayers = teams.filter(t => t.team === "ORANGE").map(t => t.playerName).sort();

  let ratingTargets = [];
  let ratingTitle = "";

  if (type === "INTERNAL") {
    if (captainTeam === "BLUE") {
      ratingTargets = orangePlayers;
      ratingTitle = "Rate ORANGE players (opponents)";
    } else if (captainTeam === "ORANGE") {
      ratingTargets = bluePlayers;
      ratingTitle = "Rate BLUE players (opponents)";
    } else {
      ratingTargets = [];
      ratingTitle = "You are not set as a captain for this match.";
    }
  } else {
    // OPPONENT: rate OUR players
    ratingTargets = uniqueYes;
    ratingTitle = "Rate OUR players";
    captainTeam = "MLFC";
  }

  function ratingsFormHtml() {
    if (!ratingTargets.length) {
      return `<div class="small">No rating targets available (check teams/captains/availability).</div>`;
    }

    return `
      <div class="small" style="margin-top:6px">Enter ratings (1–10) and submit once.</div>
      <div style="margin-top:10px">
        ${ratingTargets.map(p => `
          <div class="row" style="align-items:center; margin-top:8px">
            <div style="flex:1"><b>${p}</b></div>
            <input class="input" data-player="${encodeURIComponent(p)}" type="number" min="1" max="10"
                   placeholder="1-10" style="width:110px" />
          </div>
        `).join("")}
      </div>
      <button id="submitAllRatings" class="btn primary" style="margin-top:12px">Submit all ratings</button>
      <div id="rtMsg" class="small" style="margin-top:8px"></div>
    `;
  }

  root.innerHTML = `
    <div class="card">
      <div class="h1">Captain Panel</div>
      <div class="small"><b>${captain}</b> — ${m.title} (${m.date} ${m.time})</div>
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
          For INTERNAL: both captains must submit before final score is saved.
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

    <div class="card">
      <div class="h1">${ratingTitle}</div>
      ${locked ? `<div class="small">Locked by admin.</div>` : ratingsFormHtml()}
    </div>
  `;

  if (locked) {
    toastInfo("Ratings are locked for this match.");
    return;
  }

  // score submit
  const scoreBtn = root.querySelector("#submitScore");
  if (scoreBtn) {
    scoreBtn.onclick = async () => {
      const scoreFor = Number(root.querySelector("#scoreFor").value);
      const scoreAgainst = Number(root.querySelector("#scoreAgainst").value);

      if (Number.isNaN(scoreFor) || Number.isNaN(scoreAgainst)) {
        toastWarn("Enter valid scores.");
        return;
      }

      const out = await API.captainSubmitScore(code, captain, captainTeam || "", scoreFor, scoreAgainst);
      root.querySelector("#scMsg").textContent = out.ok ? "Score submitted ✅" : (out.error || "Failed");

      if (!out.ok) toastError(out.error || "Failed to submit score");
      else toastSuccess("Score submitted.");
    };
  }

  // ratings submit batch
  const btn = root.querySelector("#submitAllRatings");
  if (btn) {
    btn.onclick = async () => {
      const inputs = [...root.querySelectorAll("input[data-player]")];
      const ratings = inputs.map(i => ({
        playerName: decodeURIComponent(i.getAttribute("data-player")),
        rating: Number(i.value)
      })).filter(x => x.rating >= 1 && x.rating <= 10);

      if (!ratings.length) {
        toastWarn("Enter at least one rating (1–10).");
        return;
      }

      const out = await API.captainSubmitRatingsBatch(code, captain, ratings);
      root.querySelector("#rtMsg").textContent = out.ok ? "Ratings submitted ✅" : (out.error || "Failed");

      if (!out.ok) toastError(out.error || "Failed to submit ratings");
      else toastSuccess("Ratings submitted.");
    };
  }
}
