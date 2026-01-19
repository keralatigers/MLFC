import { API } from "../api/endpoints.js";
import { toastSuccess, toastError, toastInfo, toastWarn } from "../ui/toast.js";
import { cleanupCaches } from "../cache_cleanup.js";

const PAGE_SIZE = 20;

// localStorage cache keys
const LS_MATCHES_LIST_KEY = "mlfc_matches_list_cache_v2";       // { ts, page, hasMore, total, items[] }
const LS_MATCH_DETAIL_PREFIX = "mlfc_match_detail_cache_v2:";   // + code => { ts, data }
const LS_MATCHES_META_KEY = "mlfc_matches_meta_v1";             // { ts, fingerprint, latestCode }

const TTL_MATCHES_LIST_MS = 24 * 60 * 60 * 1000; // 24h (manual refresh policy)
const TTL_MATCH_DETAIL_MS = 24 * 60 * 60 * 1000; // 24h

function baseUrl() { return location.href.split("#")[0]; }
function detailKey(code) { return `${LS_MATCH_DETAIL_PREFIX}${code}`; }

function waOpenPrefill(text) {
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
}

function lsGet(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}
function isFresh(entry, ttlMs) {
  if (!entry?.ts) return false;
  return (Date.now() - entry.ts) <= ttlMs;
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
  if (!ratingsAgg.length) lines.push("1. -");
  else ratingsAgg.forEach((r, i) => lines.push(`${i + 1}. ${r.playerName} - ${r.avg.toFixed(2)} (${r.n})`));
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

/* ---------------- Matches List (#/match) ---------------- */

function renderMatchesListShell(root) {
  root.innerHTML = `
    <div class="card">
      <div class="h1">Matches</div>
      <div class="small">Cached on your device. Tap Refresh when you want.</div>

      <div id="newMatchBanner" style="display:none; margin-top:12px"></div>

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

function showBanner(root, latestCode) {
  const banner = root.querySelector("#newMatchBanner");
  if (!banner) return;

  banner.style.display = "block";
  banner.innerHTML = `
    <div class="card" style="border:1px solid rgba(16,185,129,0.35); background: rgba(16,185,129,0.10)">
      <div class="row" style="justify-content:space-between; align-items:center">
        <div style="min-width:0">
          <div style="font-weight:950">New match available</div>
          <div class="small">Tap Update to load the latest matches list.</div>
        </div>
        <div class="row" style="gap:10px">
          <button class="btn primary" id="updateList">Update</button>
          ${latestCode ? `<button class="btn gray" id="openLatest">Open</button>` : ""}
        </div>
      </div>
    </div>
  `;

  const updateBtn = root.querySelector("#updateList");
  const openBtn = root.querySelector("#openLatest");

  if (openBtn) {
    openBtn.onclick = () => {
      location.hash = `#/match?code=${encodeURIComponent(latestCode)}`;
    };
  }

  updateBtn.onclick = async () => {
    setDisabled(updateBtn, true, "Updating…");
    const res = await API.publicMatches(1, PAGE_SIZE);
    setDisabled(updateBtn, false);

    if (!res.ok) {
      toastError(res.error || "Failed to update list");
      return;
    }

    const cacheObj = {
      ts: Date.now(),
      page: res.page,
      hasMore: res.hasMore,
      total: res.total,
      items: res.matches || []
    };
    lsSet(LS_MATCHES_LIST_KEY, cacheObj);
    renderMatchesList(root, cacheObj);

    // Hide banner after update
    banner.style.display = "none";
    banner.innerHTML = "";
    toastSuccess("Matches updated.");
  };
}

function hideBanner(root) {
  const banner = root.querySelector("#newMatchBanner");
  if (!banner) return;
  banner.style.display = "none";
  banner.innerHTML = "";
}

function renderMatchesList(root, cacheObj) {
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

  listEl.querySelectorAll("[data-open]").forEach(btn => {
    btn.onclick = () => {
      const code = btn.getAttribute("data-open");
      location.hash = `#/match?code=${encodeURIComponent(code)}`;
    };
  });

  if (cacheObj.hasMore) {
    pagerCard.style.display = "block";
    pagerInfo.textContent = `Showing ${Math.min(cacheObj.page * PAGE_SIZE, cacheObj.total)} of ${cacheObj.total}`;
    loadMoreBtn.disabled = false;
  } else {
    pagerCard.style.display = "none";
  }
}

async function showMatchesTab(root) {
  renderMatchesListShell(root);

  const msgEl = root.querySelector("#msg");
  const refreshBtn = root.querySelector("#refresh");
  const loadMoreBtn = root.querySelector("#loadMore");

  // 1) Render cached list instantly (no API call)
  const cached = lsGet(LS_MATCHES_LIST_KEY);
  if (cached?.items?.length) {
    renderMatchesList(root, cached);
    msgEl.textContent = isFresh(cached, TTL_MATCHES_LIST_MS)
      ? "Loaded from device cache."
      : "Loaded cached list (may be old). Tap Refresh if needed.";
  } else {
    msgEl.textContent = "No cached matches yet. Tap Refresh to load.";
  }

  // 2) Background meta check (tiny request) to see if new match exists
  // This does NOT fetch full list; only shows banner if changed.
  API.publicMatchesMeta()
    .then(meta => {
      if (!meta?.ok) return;

      const prev = lsGet(LS_MATCHES_META_KEY);
      const changed = !prev || prev.fingerprint !== meta.fingerprint;

      // Store latest meta
      lsSet(LS_MATCHES_META_KEY, { ts: Date.now(), fingerprint: meta.fingerprint, latestCode: meta.latestCode });

      if (changed && meta.fingerprint) {
        showBanner(root, meta.latestCode);
      } else {
        hideBanner(root);
      }
    })
    .catch(() => { /* ignore */ });

  // Refresh button (full fetch)
  refreshBtn.onclick = async () => {
    setDisabled(refreshBtn, true, "Refreshing…");
    msgEl.textContent = "Loading…";

    const res = await API.publicMatches(1, PAGE_SIZE);

    setDisabled(refreshBtn, false);

    if (!res.ok) {
      toastError(res.error || "Failed to load matches");
      msgEl.textContent = res.error || "Failed";
      return;
    }

    const cacheObj = { ts: Date.now(), page: res.page, hasMore: res.hasMore, total: res.total, items: res.matches || [] };
    lsSet(LS_MATCHES_LIST_KEY, cacheObj);
    renderMatchesList(root, cacheObj);
    hideBanner(root);

    toastSuccess("Matches refreshed.");
    msgEl.textContent = "";
  };

  // Load more
  loadMoreBtn.onclick = async () => {
    const cached2 = lsGet(LS_MATCHES_LIST_KEY);
    if (!cached2?.page) { toastWarn("Refresh first."); return; }

    setDisabled(loadMoreBtn, true, "Loading…");

    const nextPage = cached2.page + 1;
    const res = await API.publicMatches(nextPage, PAGE_SIZE);

    if (!res.ok) {
      setDisabled(loadMoreBtn, false);
      toastError(res.error || "Failed to load more");
      return;
    }

    const merged = [...(cached2.items || []), ...(res.matches || [])];
    const newCache = { ts: Date.now(), page: res.page, hasMore: res.hasMore, total: res.total, items: merged };
    lsSet(LS_MATCHES_LIST_KEY, newCache);
    renderMatchesList(root, newCache);

    if (newCache.hasMore) setDisabled(loadMoreBtn, false);
  };
}

/* ---------------- Match Detail (#/match?code=...) ---------------- */

async function getDetail(code) {
  const cached = lsGet(detailKey(code));
  if (cached?.data?.ok && isFresh(cached, TTL_MATCH_DETAIL_MS)) return cached.data;
  if (cached?.data?.ok) return cached.data; // allow stale (manual refresh philosophy)
  return null;
}

function saveDetail(code, data) {
  lsSet(detailKey(code), { ts: Date.now(), data });
}

async function renderCompleted(root, data) {
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
        <button class="btn primary" id="shareDetails">Share match details</button>
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

  root.querySelector("#back").onclick = () => { location.hash = "#/match"; };

  root.querySelector("#shareDetails").onclick = () => {
    const btn = root.querySelector("#shareDetails");
    setDisabled(btn, true, "Opening…");
    waOpenPrefill(whatsappMatchDetailsMessage(m, ratingsAgg));
    toastInfo("WhatsApp opened.");
    setTimeout(() => setDisabled(btn, false), 900);
  };
}

async function renderAvailability(root, data) {
  const m = data.match;
  const status = String(m.status || "").toUpperCase();
  const when = formatHumanDateTime(m.date, m.time);

  let availability = normalizeAvail(data.availability || []);
  const grouped = groupAvail(availability);

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
      <ol id="yesList" class="list">${grouped.yes.map(n => `<li>${n}</li>`).join("") || `<li>-</li>`}</ol>

      <div class="small" style="margin-top:12px"><b>Not available</b></div>
      <ol id="noList" class="list">${grouped.no.map(n => `<li>${n}</li>`).join("") || `<li>-</li>`}</ol>

      <div class="small" style="margin-top:12px"><b>Maybe</b></div>
      <ol id="maybeList" class="list">${grouped.maybe.map(n => `<li>${n}</li>`).join("") || `<li>-</li>`}</ol>
    </div>
  `;

  root.querySelector("#back").onclick = () => { location.hash = "#/match"; };

  root.querySelector("#shareAvail").onclick = () => {
    const btn = root.querySelector("#shareAvail");
    setDisabled(btn, true, "Opening…");
    waOpenPrefill(whatsappAvailabilityMessage(m, availability));
    toastInfo("WhatsApp opened.");
    setTimeout(() => setDisabled(btn, false), 900);
  };

  const playersRes = await API.players();
  if (!playersRes.ok) {
    toastError(playersRes.error || "Failed to load players");
    return;
  }

  const allPlayers = (playersRes.players || []).map(p => p.name).filter(Boolean).sort();
  const playerEl = root.querySelector("#player");
  const searchEl = root.querySelector("#playerSearch");

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

    const g = groupAvail(availability);
    root.querySelector("#yesList").innerHTML = g.yes.map(n => `<li>${n}</li>`).join("") || `<li>-</li>`;
    root.querySelector("#noList").innerHTML = g.no.map(n => `<li>${n}</li>`).join("") || `<li>-</li>`;
    root.querySelector("#maybeList").innerHTML = g.maybe.map(n => `<li>${n}</li>`).join("") || `<li>-</li>`;
  }

  async function submit(choice) {
    const playerName = (playerEl.value || "").trim();
    const note = (root.querySelector("#note").value || "").trim();
    const msgEl = root.querySelector("#msg");

    if (!playerName) { toastWarn("Select your name."); return; }

    const yesBtn = root.querySelector("#yesBtn");
    const noBtn = root.querySelector("#noBtn");
    const maybeBtn = root.querySelector("#maybeBtn");
    yesBtn.disabled = true; noBtn.disabled = true; maybeBtn.disabled = true;

    updateAvailabilityLocal(playerName, choice, note);
    msgEl.textContent = "Saving…";

    const res = await API.setAvailability(m.publicCode, playerName, choice, note);
    if (!res.ok) {
      msgEl.textContent = res.error || "Failed";
      toastError(res.error || "Failed to submit");
      yesBtn.disabled = false; noBtn.disabled = false; maybeBtn.disabled = false;
      return;
    }

    msgEl.textContent = "Saved ✅";
    toastSuccess(`Saved: ${choice}`, "Availability");

    waOpenPrefill(whatsappAvailabilityMessage(m, availability));
    toastInfo("WhatsApp opened (tap Send).");

    setTimeout(() => {
      yesBtn.disabled = false; noBtn.disabled = false; maybeBtn.disabled = false;
    }, 900);

    // update device cache for this match detail
    const cachedDetail = await getDetail(m.publicCode);
    const merged = cachedDetail?.ok ? cachedDetail : data;
    merged.availability = availability;
    saveDetail(m.publicCode, merged);
  }

  root.querySelector("#yesBtn").onclick = () => submit("YES");
  root.querySelector("#noBtn").onclick = () => submit("NO");
  root.querySelector("#maybeBtn").onclick = () => submit("MAYBE");
}

export async function renderMatchPage(root, query) {
  cleanupCaches();

  const code = query.get("code");
  if (!code) {
    await showMatchesTab(root);
    return;
  }

  // match detail: cache-first, no auto refresh
  const cached = await getDetail(code);
  if (cached?.ok) {
    const status = String(cached.match?.status || "").toUpperCase();
    if (status === "COMPLETED") await renderCompleted(root, cached);
    else await renderAvailability(root, cached);
    return;
  }

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

  saveDetail(code, data);

  const status = String(data.match?.status || "").toUpperCase();
  if (status === "COMPLETED") await renderCompleted(root, data);
  else await renderAvailability(root, data);
}
