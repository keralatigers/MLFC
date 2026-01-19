import { API } from "../api/endpoints.js";
import { toastSuccess, toastError, toastInfo, toastWarn } from "../ui/toast.js";

const PAGE_SIZE = 20;

// Cache keys
const SS_MATCHES_LIST_KEY = "mlfc_matches_list_cache_v1";     // { ts, page, hasMore, total, items[] }
const SS_MATCH_DETAIL_PREFIX = "mlfc_match_detail_cache_v1:"; // + code => { ts, data }

function now() { return Date.now(); }

function baseUrl() {
  return location.href.split("#")[0];
}

function waOpenPrefill(text) {
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
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
  try {
    sessionStorage.setItem(key, JSON.stringify(obj));
  } catch {
    // ignore
  }
}

function detailKey(code) {
  return `${SS_MATCH_DETAIL_PREFIX}${code}`;
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

function normalizeAvail(list) {
  return (list || []).map(a => ({
    playerName: String(a.playerName || ""),
    availability: String(a.availability || "").toUpperCase(),
    note: String(a.note || "")
  }));
}

function groupAvail(availability) {
  const yes = availability.filter(a => a.availability === "YES").map(a => a.playerName).sort();
  const no = availability.filter(a => a.availability === "NO").map(a => a.playerName).sort();
  const maybe = availability.filter(a => a.availability === "MAYBE").map(a => a.playerName).sort();
  return { yes, no, maybe };
}

function whatsappAvailabilityMessage(match, availability) {
  const { yes, no, maybe } = groupAvail(availability);
  const when = formatHumanDateTime(match.date, match.time);

  const lines = [];
  lines.push(`Match details: ${match.title}`);
  lines.push(`Date/Time: ${when}`);
  lines.push(`Type: ${match.type}`);
  lines.push(`Status: ${match.status}`);
  lines.push("");
  lines.push("Availability");
  (yes.length ? yes : ["-"]).forEach((n, i) => lines.push(`${i + 1}. ${n}`));
  lines.push("");
  lines.push("Not available");
  (no.length ? no : ["-"]).forEach((n, i) => lines.push(`${i + 1}. ${n}`));
  lines.push("");
  lines.push("Maybe");
  (maybe.length ? maybe : ["-"]).forEach((n, i) => lines.push(`${i + 1}. ${n}`));
  lines.push("");
  lines.push(`Link: ${baseUrl()}#/match?code=${match.publicCode}`);

  return lines.join("\n");
}

function summarizeScore(match) {
  const home = match.scoreHome;
  const away = match.scoreAway;
  const has = home !== "" && away !== "" && home != null && away != null;

  if (!has) return "Score: (not submitted yet)";
  if (String(match.type).toUpperCase() === "INTERNAL") return `Score: Blue ${home} - ${away} Orange`;
  return `Score: Manor Lakes ${home} - ${away} Opponent`;
}

function aggregateRatings(ratings) {
  const sum = {};
  const count = {};
  (ratings || []).forEach(r => {
    const p = String(r.playerName || "").trim();
    const v = Number(r.rating || 0);
    if (!p || !(v > 0)) return;
    sum[p] = (sum[p] || 0) + v;
    count[p] = (count[p] || 0) + 1;
  });

  return Object.keys(sum).map(p => ({
    playerName: p,
    avg: sum[p] / count[p],
    n: count[p]
  })).sort((a, b) => b.avg - a.avg);
}

function whatsappMatchDetailsMessage(match, ratingsAgg) {
  const when = formatHumanDateTime(match.date, match.time);
  const scoreLine = summarizeScore(match);

  const lines = [];
  lines.push(`Match details: ${match.title}`);
  lines.push(`Date/Time: ${when}`);
  lines.push(`Type: ${match.type}`);
  lines.push(`Status: ${match.status}`);
  lines.push(scoreLine);
  lines.push("");

  lines.push("Ratings (avg)");
  if (!ratingsAgg.length) {
    lines.push("1. -");
  } else {
    ratingsAgg.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.playerName} - ${r.avg.toFixed(2)} (${r.n})`);
    });
  }

  lines.push("");
  lines.push(`Link: ${baseUrl()}#/match?code=${match.publicCode}`);

  return lines.join("\n");
}

function setDisabled(btn, disabled, busyText) {
  if (!btn) return;
  btn.disabled = disabled;
  if (busyText) {
    if (!btn.dataset.origText) btn.dataset.origText = btn.textContent;
    btn.textContent = disabled ? busyText : btn.dataset.origText;
  }
}

/* -------------------------
   Matches list view (#/match)
-------------------------- */

function renderMatchesListSkeleton(root) {
  root.innerHTML = `
    <div class="card">
      <div class="h1">Matches</div>
      <div class="small">Tap a match to submit availability or view results.</div>

      <div class="row" style="margin-top:10px">
        <button class="btn primary" id="refresh">Refresh</button>
      </div>
      <div class="small" id="msg" style="margin-top:8px"></div>
    </div>

    <div id="matchList"></div>

    <div class="card" id="pagerCard" style="display:none">
      <button class="btn primary" id="loadMore">Load more</button>
      <div class="small" id="pagerInfo" style="margin-top:8px"></div>
    </div>
  `;
}

function renderMatchesListFromCache(root, cacheObj) {
  const listEl = root.querySelector("#matchList");
  const pagerCard = root.querySelector("#pagerCard");
  const pagerInfo = root.querySelector("#pagerInfo");
  const loadMoreBtn = root.querySelector("#loadMore");

  const items = cacheObj.items || [];
  listEl.innerHTML = items.map(m => {
    const status = String(m.status || "").toUpperCase();
    const when = formatHumanDateTime(m.date, m.time);

    const badge =
      status === "OPEN" ? `<span class="badge badge--good">OPEN</span>` :
      status === "CLOSED" ? `<span class="badge badge--warn">CLOSED</span>` :
      `<span class="badge badge--bad">COMPLETED</span>`;

    const scoreLine = status === "COMPLETED" ? summarizeScore(m) : "";

    return `
      <div class="card">
        <div class="row" style="justify-content:space-between; align-items:flex-start">
          <div style="min-width:0">
            <div style="font-weight:950; font-size:16px; color: rgba(11,18,32,0.92);">${m.title}</div>
            <div class="small">${when} • ${m.type}</div>
            ${scoreLine ? `<div class="small" style="margin-top:6px">${scoreLine}</div>` : ""}
          </div>
          ${badge}
        </div>

        <div class="row" style="margin-top:12px">
          <button class="btn primary" data-open="${m.publicCode}">
            ${status === "COMPLETED" ? "View results" : "Open"}
          </button>
        </div>
      </div>
    `;
  }).join("") || `<div class="card"><div class="small">No matches found.</div></div>`;

  // bind open buttons
  listEl.querySelectorAll("[data-open]").forEach(btn => {
    btn.onclick = () => {
      const code = btn.getAttribute("data-open");
      location.hash = `#/match?code=${encodeURIComponent(code)}`;
    };
  });

  // pager
  if (cacheObj.hasMore) {
    pagerCard.style.display = "block";
    pagerInfo.textContent = `Showing ${Math.min(cacheObj.page * PAGE_SIZE, cacheObj.total)} of ${cacheObj.total}`;
    loadMoreBtn.disabled = false;
  } else {
    pagerCard.style.display = "none";
  }
}

async function loadMatchesPage(page) {
  const res = await API.publicMatches(page, PAGE_SIZE);
  return res;
}

async function renderMatchesList(root) {
  renderMatchesListSkeleton(root);

  const msgEl = root.querySelector("#msg");
  const refreshBtn = root.querySelector("#refresh");
  const loadMoreBtn = root.querySelector("#loadMore");

  // 1) render from cache immediately (NO API call)
  const cached = readSessionJson(SS_MATCHES_LIST_KEY);
  if (cached?.items?.length) {
    renderMatchesListFromCache(root, cached);
    msgEl.textContent = "Showing cached list. Tap Refresh if needed.";
  } else {
    msgEl.textContent = "Tap Refresh to load matches.";
  }

  // Refresh does API call
  refreshBtn.onclick = async () => {
    setDisabled(refreshBtn, true, "Refreshing…");
    msgEl.textContent = "Loading matches…";

    const res = await loadMatchesPage(1);

    setDisabled(refreshBtn, false);

    if (!res.ok) {
      toastError(res.error || "Failed to load matches");
      msgEl.textContent = res.error || "Failed";
      return;
    }

    const cacheObj = {
      ts: now(),
      page: res.page,
      hasMore: res.hasMore,
      total: res.total,
      items: res.matches || []
    };
    writeSessionJson(SS_MATCHES_LIST_KEY, cacheObj);
    renderMatchesListFromCache(root, cacheObj);

    toastSuccess("Matches refreshed.");
    msgEl.textContent = "";
  };

  // Load more appends and updates cache (API call)
  loadMoreBtn.onclick = async () => {
    const cached2 = readSessionJson(SS_MATCHES_LIST_KEY);
    if (!cached2?.page) {
      toastWarn("Please refresh first.");
      return;
    }

    setDisabled(loadMoreBtn, true, "Loading…");

    const nextPage = cached2.page + 1;
    const res = await loadMatchesPage(nextPage);

    if (!res.ok) {
      setDisabled(loadMoreBtn, false);
      toastError(res.error || "Failed to load more");
      return;
    }

    const merged = [...(cached2.items || []), ...(res.matches || [])];
    const newCache = {
      ts: now(),
      page: res.page,
      hasMore: res.hasMore,
      total: res.total,
      items: merged
    };
    writeSessionJson(SS_MATCHES_LIST_KEY, newCache);

    // render updated list without re-calling initial API
    renderMatchesListFromCache(root, newCache);

    // keep disabled state correct
    if (newCache.hasMore) setDisabled(loadMoreBtn, false);
  };
}

/* -------------------------
   Match detail view (#/match?code=...)
-------------------------- */

async function getMatchDetailCached(code) {
  const cached = readSessionJson(detailKey(code));
  if (cached?.data?.ok) return cached.data;
  return null;
}

function saveMatchDetailCache(code, data) {
  writeSessionJson(detailKey(code), { ts: now(), data });
}

async function renderCompletedMatch(root, data) {
  const m = data.match;
  const when = formatHumanDateTime(m.date, m.time);
  const scoreLine = summarizeScore(m);
  const ratingsAgg = aggregateRatings(data.ratings || []);

  root.innerHTML = `
    <div class="card">
      <div class="h1">${m.title}</div>
      <div class="row">
        <span class="badge badge--bad">COMPLETED</span>
        <span class="badge">${m.type}</span>
      </div>
      <div class="small" style="margin-top:10px">${when}</div>
      <div class="small" style="margin-top:6px">${scoreLine}</div>

      <div class="row" style="margin-top:12px">
        <button class="btn primary" id="shareMatchDetails">Share match details</button>
        <button class="btn gray" id="back">Back to matches</button>
      </div>
    </div>

    <div class="card">
      <div class="h1">Ratings</div>
      <div class="small">Average rating per player.</div>
      <ul class="list" style="margin-top:10px">
        ${
          ratingsAgg.length
            ? ratingsAgg.map(r => `<li><b>${r.playerName}</b> — ${r.avg.toFixed(2)} <span class="small">(${r.n})</span></li>`).join("")
            : `<li class="small">No ratings submitted.</li>`
        }
      </ul>
    </div>
  `;

  root.querySelector("#back").onclick = () => {
    // IMPORTANT: go back without re-calling matches API (list uses cache)
    location.hash = "#/match";
  };

  root.querySelector("#shareMatchDetails").onclick = () => {
    const btn = root.querySelector("#shareMatchDetails");
    setDisabled(btn, true, "Opening…");
    waOpenPrefill(whatsappMatchDetailsMessage(m, ratingsAgg));
    toastInfo("WhatsApp opened with match details.");
    setTimeout(() => setDisabled(btn, false), 900);
  };
}

async function renderAvailabilityMatch(root, data) {
  const m = data.match;
  const status = String(m.status || "").toUpperCase();
  const when = formatHumanDateTime(m.date, m.time);

  let availability = normalizeAvail(data.availability || []);
  const { yes, no, maybe } = groupAvail(availability);

  root.innerHTML = `
    <div class="card">
      <div class="h1">${m.title}</div>
      <div class="row">
        ${
          status === "OPEN"
            ? `<span class="badge badge--good">OPEN</span>`
            : `<span class="badge badge--warn">CLOSED</span>`
        }
        <span class="badge">${m.type}</span>
      </div>
      <div class="small" style="margin-top:10px">${when}</div>

      <div class="row" style="margin-top:12px">
        <button class="btn primary" id="shareAvail">Share availability</button>
        <button class="btn gray" id="back">Back to matches</button>
      </div>
    </div>

    <div class="card">
      <div class="h1">Submit your availability</div>

      <input id="playerSearch" class="input" placeholder="Search your name..." ${status !== "OPEN" ? "disabled" : ""} />
      <select id="player" class="input" style="margin-top:10px" ${status !== "OPEN" ? "disabled" : ""}>
        <option value="">Loading players…</option>
      </select>

      <input id="note" class="input" placeholder="Note (optional)" style="margin-top:10px" ${status !== "OPEN" ? "disabled" : ""} />

      <div class="row" style="margin-top:12px">
        <button class="btn good" id="yesBtn" ${status !== "OPEN" ? "disabled" : ""}>YES</button>
        <button class="btn bad" id="noBtn" ${status !== "OPEN" ? "disabled" : ""}>NO</button>
        <button class="btn warn" id="maybeBtn" ${status !== "OPEN" ? "disabled" : ""}>MAYBE</button>
      </div>

      <div class="small" id="msg" style="margin-top:10px">
        ${status === "OPEN" ? "Choose your name and tap YES/NO/MAYBE." : "Availability is closed for this match."}
      </div>
    </div>

    <div class="card">
      <div class="h1">Availability</div>

      <div class="small"><b>Available</b></div>
      <ol id="yesList" class="list">${yes.map(n => `<li>${n}</li>`).join("") || `<li>-</li>`}</ol>

      <div class="small" style="margin-top:12px"><b>Not available</b></div>
      <ol id="noList" class="list">${no.map(n => `<li>${n}</li>`).join("") || `<li>-</li>`}</ol>

      <div class="small" style="margin-top:12px"><b>Maybe</b></div>
      <ol id="maybeList" class="list">${maybe.map(n => `<li>${n}</li>`).join("") || `<li>-</li>`}</ol>
    </div>
  `;

  // back button (no matches API call)
  root.querySelector("#back").onclick = () => {
    location.hash = "#/match";
  };

  // share availability
  root.querySelector("#shareAvail").onclick = () => {
    const btn = root.querySelector("#shareAvail");
    setDisabled(btn, true, "Opening…");
    waOpenPrefill(whatsappAvailabilityMessage(m, availability));
    toastInfo("WhatsApp opened with availability list.");
    setTimeout(() => setDisabled(btn, false), 900);
  };

  // load players list on demand
  const playersRes = await API.players();
  const playerEl = root.querySelector("#player");
  const searchEl = root.querySelector("#playerSearch");

  if (!playersRes.ok) {
    playerEl.innerHTML = `<option value="">(failed to load players)</option>`;
    toastError(playersRes.error || "Failed to load players");
    return;
  }

  const allPlayers = (playersRes.players || []).map(p => p.name).filter(Boolean).sort();

  function renderOptions(filterText = "") {
    const f = filterText.trim().toLowerCase();
    const list = f ? allPlayers.filter(n => n.toLowerCase().includes(f)) : allPlayers.slice(0, 80);
    playerEl.innerHTML =
      `<option value="">Select your name</option>` +
      list.map(n => `<option value="${n}">${n}</option>`).join("");
  }

  renderOptions();
  searchEl.addEventListener("input", () => renderOptions(searchEl.value));

  function updateAvailabilityLocal(playerName, choice, note) {
    const idx = availability.findIndex(a => a.playerName.toLowerCase() === playerName.toLowerCase());
    if (idx >= 0) {
      availability[idx].availability = choice;
      availability[idx].note = note || "";
    } else {
      availability.push({ playerName, availability: choice, note: note || "" });
    }

    const grouped = groupAvail(availability);
    root.querySelector("#yesList").innerHTML = grouped.yes.map(n => `<li>${n}</li>`).join("") || `<li>-</li>`;
    root.querySelector("#noList").innerHTML = grouped.no.map(n => `<li>${n}</li>`).join("") || `<li>-</li>`;
    root.querySelector("#maybeList").innerHTML = grouped.maybe.map(n => `<li>${n}</li>`).join("") || `<li>-</li>`;
  }

  async function submit(choice) {
    const playerName = (playerEl.value || "").trim();
    const note = (root.querySelector("#note").value || "").trim();
    const msgEl = root.querySelector("#msg");

    if (!playerName) {
      toastWarn("Please select your name.");
      return;
    }

    // disable buttons to avoid double click
    const yesBtn = root.querySelector("#yesBtn");
    const noBtn = root.querySelector("#noBtn");
    const maybeBtn = root.querySelector("#maybeBtn");
    setDisabled(yesBtn, true);
    setDisabled(noBtn, true);
    setDisabled(maybeBtn, true);

    // immediate UI update (no refresh)
    updateAvailabilityLocal(playerName, choice, note);
    msgEl.textContent = "Saving…";

    const res = await API.setAvailability(m.publicCode, playerName, choice, note);

    if (!res.ok) {
      msgEl.textContent = res.error || "Failed";
      toastError(res.error || "Failed to submit availability");
      setDisabled(yesBtn, false);
      setDisabled(noBtn, false);
      setDisabled(maybeBtn, false);
      return;
    }

    msgEl.textContent = "Saved ✅";
    toastSuccess(`Saved: ${choice}`, "Availability");

    // open WhatsApp message in required format
    waOpenPrefill(whatsappAvailabilityMessage(m, availability));
    toastInfo("WhatsApp opened (tap Send).");

    // re-enable after short delay
    setTimeout(() => {
      setDisabled(yesBtn, false);
      setDisabled(noBtn, false);
      setDisabled(maybeBtn, false);
    }, 900);

    // update detail cache so if reopened, it reflects latest without fetching
    const cachedDetail = await getMatchDetailCached(m.publicCode);
    const merged = cachedDetail?.ok ? cachedDetail : data;
    merged.availability = availability;
    saveMatchDetailCache(m.publicCode, merged);
  }

  root.querySelector("#yesBtn").onclick = () => submit("YES");
  root.querySelector("#noBtn").onclick = () => submit("NO");
  root.querySelector("#maybeBtn").onclick = () => submit("MAYBE");
}

export async function renderMatchPage(root, query) {
  const code = query.get("code");

  // Matches tab (no code)
  if (!code) {
    await renderMatchesList(root);
    return;
  }

  // 1) Try cached detail first (instant view, no API call)
  const cachedDetail = await getMatchDetailCached(code);
  if (cachedDetail?.ok) {
    // render from cache immediately
    const status = String(cachedDetail.match?.status || "").toUpperCase();
    if (status === "COMPLETED") {
      await renderCompletedMatch(root, cachedDetail);
    } else {
      await renderAvailabilityMatch(root, cachedDetail);
    }
    toastInfo("Showing cached match. (No auto refresh)");
    // Important: do NOT auto fetch; user wanted no background calls.
    // If you later want a manual refresh button per match, we can add it.
    return;
  }

  // 2) No cache => fetch once
  root.innerHTML = `
    <div class="card">
      <div class="h1">Loading…</div>
      <div class="small">Fetching match details.</div>
    </div>
  `;

  const data = await API.getPublicMatch(code);
  if (!data.ok) {
    root.innerHTML = `<div class="card"><div class="h1">Error</div><div class="small">${data.error}</div></div>`;
    toastError(data.error || "Failed to load match");
    return;
  }

  // cache it
  saveMatchDetailCache(code, data);

  const status = String(data.match?.status || "").toUpperCase();
  if (status === "COMPLETED") {
    await renderCompletedMatch(root, data);
  } else {
    await renderAvailabilityMatch(root, data);
  }
}
