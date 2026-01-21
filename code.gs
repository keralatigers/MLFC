/***************************************
 * Manor Lakes FC - Code.gs (Seasons + Leaderboard)
 *
 * Implements:
 *  - Seasons: list + admin create + auto-close by endDate
 *  - Matches (public): open list + past list (paged) + meta fingerprint banner
 *  - Admin: list matches (by season), create match (seasonId), lock ratings, unlock match,
 *           setup opponent captain, setup internal teams + captains
 *  - Captain: submit score (Blue/Orange or MLFC/Opponent), submit ratings batch
 *            + stores teamAtMatch into ratings + (optionally) updates TEAMS sheet for match
 *  - Leaderboard per season: table rows {playerName, goals, assists, avgRating, matchesRated}
 *
 * Removed:
 *  - manual "close availability" endpoint entirely
 ***************************************/

const ADMIN_KEY = "Password@123#"; // <-- CHANGE THIS

// Sheets
const SHEET_SEASONS = "seasons";
const SHEET_MATCHES = "matches";
const SHEET_PLAYERS = "players";
const SHEET_AVAIL = "availability";
const SHEET_CAPTAINS = "captains";
const SHEET_TEAMS = "teams";
const SHEET_RATINGS = "ratings";
const SHEET_EVENTS = "events";   // optional; if missing goals/assists will be 0
const SHEET_SCORES = "scores";

// Cache TTLs (seconds)
const TTL_SEASONS = 60;
const TTL_MATCH_INDEX = 30;
const TTL_PUBLIC_LIST = 30;
const TTL_PUBLIC_META = 20;
const TTL_PUBLIC_MATCH = 15;
const TTL_LEADERBOARD = 30;
const TTL_PLAYERS = 6 * 60 * 60;
const TZ = "Australia/Melbourne";

// =========================
// Script-level caching helpers (CacheService + versioned keys)
// =========================

// Cache headers maps aggressively (header row almost never changes)
const TTL_HEADERS = 6 * 60 * 60; // 6h

function props() { return PropertiesService.getScriptProperties(); }
function tokenKey(name) { return `tok:${name}`; }
function getToken(name) {
  const v = props().getProperty(tokenKey(name));
  return v ? String(v) : "1";
}
function bumpToken(name) {
  const p = props();
  const k = tokenKey(name);
  const cur = Number(p.getProperty(k) || "1");
  const next = String((Number.isFinite(cur) ? cur : 1) + 1);
  p.setProperty(k, next);
  return next;
}
function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function requireAdminKey(adminKey) {
  if (!adminKey || adminKey !== ADMIN_KEY) throw new Error("Unauthorized");
}

function cache() { return CacheService.getScriptCache(); }
function cacheGetJson(key) {
  const raw = cache().get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function cachePutJson(key, obj, ttlSec) {
  cache().put(key, JSON.stringify(obj), ttlSec);
}
function cacheRemove(keys) {
  try { cache().removeAll(keys); } catch {}
}

function isoNow() { return new Date().toISOString(); }
function safeUpper(x) { return String(x || "").toUpperCase(); }
function isDateObj(v) {
  return Object.prototype.toString.call(v) === "[object Date]" && !isNaN(v.getTime());
}

function normalizeDateCell(v) {
  // returns YYYY-MM-DD
  if (isDateObj(v)) return Utilities.formatDate(v, TZ, "yyyy-MM-dd");

  const s = String(v || "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const d = new Date(s);
  if (!isNaN(d.getTime())) return Utilities.formatDate(d, TZ, "yyyy-MM-dd");

  return s;
}

function normalizeTimeCell(v) {
  // returns HH:MM (24h)
  if (isDateObj(v)) return Utilities.formatDate(v, TZ, "HH:mm");

  const s = String(v || "").trim();
  if (!s) return "";
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    const [h, m] = s.split(":");
    return String(h).padStart(2, "0") + ":" + m;
  }

  const d = new Date(s);
  if (!isNaN(d.getTime())) return Utilities.formatDate(d, TZ, "HH:mm");

  return s;
}

function normalizeBoolCell(v, defaultVal = "FALSE") {
  const s = String(v ?? "").trim().toUpperCase();
  if (!s) return defaultVal;
  if (["TRUE", "YES", "1"].includes(s)) return "TRUE";
  if (["FALSE", "NO", "0"].includes(s)) return "FALSE";
  return defaultVal;
}
function randCode(len = 10) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghijkmnpqrstuvwxyz";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function getSheet(name) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error("Missing sheet: " + name);
  return sh;
}

function sheetExists(name) {
  const ss = SpreadsheetApp.getActive();
  return !!ss.getSheetByName(name);
}

function getHeaders(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
}

function headerMap(sh) {
  // Hot-path optimization: cache header maps in CacheService.
  // Header row changes are very rare; if it ever changes, wait TTL_HEADERS or bump tok:headers manually.
  const sheetName = sh.getName();
  const tok = getToken(`headers:${sheetName}`);
  const key = `hdr:v1:${sheetName}:${tok}`;
  const cached = cacheGetJson(key);
  if (cached) return cached;

  const headers = getHeaders(sh);
  const h = {};
  headers.forEach((k, i) => {
    const sk = String(k);
    h[sk] = i;
    const low = sk.toLowerCase();
    if (h[low] == null) h[low] = i;
  });
  cachePutJson(key, h, TTL_HEADERS);
  return h;
}

function readAllDataRows(sh) {
  const lr = sh.getLastRow();
  const lc = sh.getLastColumn();
  if (lr < 2) return [];
  return sh.getRange(2, 1, lr - 1, lc).getValues();
}

function appendRow(sheetName, obj) {
  const sh = getSheet(sheetName);
  const headers = getHeaders(sh);
  const row = headers.map(h => obj[h] ?? "");
  sh.appendRow(row);
}

function parseMatchDateTime(match) {
  const d = normalizeDateCell(match.date);
  const t = normalizeTimeCell(match.time);
  const dt = new Date(`${d}T${t}:00`);
  return dt;
}

/* =========================
   Seasons
   ========================= */

function seasonsCacheKey() {
  const tok = getToken("seasons");
  return `seasons:v2:${tok}`;
}
function currentSeasonCacheKey() {
  const tok = getToken("seasons");
  return `currentSeason:v2:${tok}`;
}

function invalidateSeasons() {
  bumpToken("seasons");
}

function getSeasons() {
  const cached = cacheGetJson(seasonsCacheKey());
  if (cached) return cached;

  const sh = getSheet(SHEET_SEASONS);
  const h = headerMap(sh);
  const rows = readAllDataRows(sh);

  const seasons = rows.map(r => ({
    seasonId: String(r[h.seasonId] || ""),
    name: String(r[h.name] || ""),
    startDate: String(r[h.startDate] || ""),
    endDate: String(r[h.endDate] || ""),
    status: String(r[h.status] || ""),
    createdAt: String(r[h.createdAt] || ""),
    closedAt: String(r[h.closedAt] || "")
  })).filter(s => s.seasonId && s.name);

  const out = { ok: true, seasons };
  cachePutJson(seasonsCacheKey(), out, TTL_SEASONS);
  return out;
}

function autoCloseSeasonsIfNeeded() {
  // Free approach: runs on any API call, closes seasons whose endDate passed
  const sh = getSheet(SHEET_SEASONS);
  const h = headerMap(sh);
  const rows = readAllDataRows(sh);

  const nowDt = new Date();
  let changed = false;

  rows.forEach((r, i) => {
    const status = safeUpper(r[h.status]);
    const endDate = String(r[h.endDate] || "").trim();
    if (status !== "OPEN" || !endDate) return;

    const endDt = new Date(`${endDate}T23:59:59`);
    if (!Number.isNaN(endDt.getTime()) && nowDt > endDt) {
      if (h.status != null) sh.getRange(i + 2, h.status + 1).setValue("CLOSED");
      if (h.closedAt != null) sh.getRange(i + 2, h.closedAt + 1).setValue(isoNow());
      changed = true;
    }
  });

  if (changed) invalidateSeasons();
}

function getCurrentSeasonId() {
  autoCloseSeasonsIfNeeded();

  const cached = cacheGetJson(currentSeasonCacheKey());
  if (cached?.seasonId) return cached.seasonId;

  const data = getSeasons();
  const seasons = data.seasons || [];

  // Pick latest OPEN by startDate, else latest overall by startDate
  const open = seasons.filter(s => safeUpper(s.status) === "OPEN");
  const pickFrom = open.length ? open : seasons;

  pickFrom.sort((a, b) => {
    const ad = new Date(`${a.startDate}T00:00:00`).getTime() || 0;
    const bd = new Date(`${b.startDate}T00:00:00`).getTime() || 0;
    return bd - ad;
  });

  const seasonId = pickFrom[0]?.seasonId || "";
  cachePutJson(currentSeasonCacheKey(), { seasonId }, TTL_SEASONS);
  return seasonId;
}

/* =========================
   Players (cached)
   ========================= */

function playersCacheKey() {
  const tok = getToken("players");
  return `players:v2:${tok}`;
}
function invalidatePlayers() {
  bumpToken("players");
}

function getPlayersCached() {
  const cached = cacheGetJson(playersCacheKey());
  if (cached) return cached;

  const sh = getSheet(SHEET_PLAYERS);
  const h = headerMap(sh);
  const rows = readAllDataRows(sh);

  const players = rows.map(r => ({
    name: String(r[h.name] || "").trim(),
    phone: String(r[h.phone] || "").trim()
  })).filter(p => p.name).sort((a, b) => a.name.localeCompare(b.name));

  const out = { ok: true, players };
  cachePutJson(playersCacheKey(), out, TTL_PLAYERS);
  return out;
}

/* =========================
   Match Index (cached)
   ========================= */

function matchIndexKey() {
  const tok = getToken("matchesIndex");
  return `matchIndex:v6:${tok}`;
}

function invalidateMatches(seasonIdOpt, publicCodeOpt) {
  // Versioned tokens let us cache more aggressively without needing to enumerate/remove all keys.
  bumpToken("matchesIndex");
  if (seasonIdOpt) bumpToken(`season:${seasonIdOpt}`);
  if (publicCodeOpt) bumpToken(`match:${publicCodeOpt}`);
}

function getMatchIndex() {
  const cached = cacheGetJson(matchIndexKey());
  if (cached) return cached;

  const sh = getSheet(SHEET_MATCHES);
  const h = headerMap(sh);
  const rows = readAllDataRows(sh);

  const list = rows.map(r => ({
    matchId: String(r[h.matchId] || ""),
    title: String(r[h.title] || ""),
    date: normalizeDateCell(r[h.date]),
    time: normalizeTimeCell(r[h.time]),
    type: String(r[h.type] || ""),
    status: String(r[h.status] || ""),
    publicCode: String(r[h.publicCode] || ""),
    createdAt: String(r[h.createdAt] || ""),
    ratingsLocked: normalizeBoolCell(r[h.ratingsLocked], "FALSE"),
    scoreHome: r[h.scoreHome],
    scoreAway: r[h.scoreAway],
    seasonId: String(r[h.seasonId] || ""),
    autoCloseEnabled: normalizeBoolCell(r[h.autoCloseEnabled], "TRUE"),
    autoClosedAt: String(r[h.autoClosedAt] || "")
  }));

  const byCode = {};
  list.forEach(m => { if (m.publicCode) byCode[m.publicCode] = m; });

  const out = { list, byCode };
  cachePutJson(matchIndexKey(), out, TTL_MATCH_INDEX);
  return out;
}

function setMatchFields(matchId, patch) {
  const sh = getSheet(SHEET_MATCHES);
  const headers = getHeaders(sh);
  const h = {};
  headers.forEach((k, i) => h[String(k)] = i);

  const rows = readAllDataRows(sh);
  const idxMid = h.matchId;
  if (idxMid == null) throw new Error("matches sheet missing matchId");

  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][idxMid]) === String(matchId)) {
      Object.keys(patch).forEach(k => {
        const idx = h[k];
        if (idx != null) sh.getRange(i + 2, idx + 1).setValue(patch[k]);
      });
      return true;
    }
  }
  return false;
}

function ensureAutoClose(match) {
  // auto-close OPEN matches at start time if autoCloseEnabled TRUE
  if (safeUpper(match.status) !== "OPEN") return match;
  if (safeUpper(match.autoCloseEnabled) === "FALSE") return match;

  const dt = parseMatchDateTime(match);
  if (!Number.isNaN(dt.getTime()) && new Date() >= dt) {
    setMatchFields(match.matchId, { status: "CLOSED", autoClosedAt: isoNow() });
    match.status = "CLOSED";
  }
  return match;
}

function findMatchByCode(code) {
  const idx = getMatchIndex();
  return idx.byCode[String(code)] || null;
}

function matchBelongsToSeason(match, seasonId) {
  return String(match.seasonId || "") === String(seasonId || "");
}

/* =========================
   Read per-match related data
   ========================= */

function readRowsByMatchId(sheetName, matchId) {
  const sh = getSheet(sheetName);
  const headers = getHeaders(sh);
  const h = {};
  headers.forEach((k, i) => h[String(k)] = i);

  const rows = readAllDataRows(sh);
  const idxMid = h.matchId;
  if (idxMid == null) return [];

  return rows
    .filter(r => String(r[idxMid]) === String(matchId))
    .map(r => {
      const o = {};
      headers.forEach((k, i) => o[k] = r[i]);
      return o;
    });
}

// Cached variant used for assembling public_match responses.
// cacheScope should include any version token (e.g. match token) to avoid stale rows.
function readRowsByMatchIdCached(sheetName, matchId, cacheScope, ttlSec) {
  const key = `rows:v1:${sheetName}:${matchId}:${cacheScope}`;
  const cached = cacheGetJson(key);
  if (cached) return cached;
  const rows = readRowsByMatchId(sheetName, matchId);
  cachePutJson(key, rows, ttlSec);
  return rows;
}

function getCaptainsRow(matchId) {
  const sh = getSheet(SHEET_CAPTAINS);
  const headers = getHeaders(sh);
  const h = headerMap(sh);

  const rows = readAllDataRows(sh);
  const idxMid = h.matchId;
  if (idxMid == null) return null;

  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][idxMid]) === String(matchId)) {
      const o = {};
      headers.forEach((k, j) => o[k] = rows[i][j]);
      return o;
    }
  }
  return null;
}

function getCaptainsRowCached(matchId, cacheScope, ttlSec) {
  const key = `captains:v1:${matchId}:${cacheScope}`;
  const cached = cacheGetJson(key);
  if (cached) return cached;
  const row = getCaptainsRow(matchId);
  cachePutJson(key, row, ttlSec);
  return row;
}

function ensureCaptainAllowed(matchId, givenBy) {
  const caps = getCaptainsRow(matchId);
  if (!caps) throw new Error("Captains not set");

  const c1 = String(caps.captain1 || "").trim().toLowerCase();
  const c2 = String(caps.captain2 || "").trim().toLowerCase();
  const g = String(givenBy || "").trim().toLowerCase();
  if (!g) throw new Error("captain required");
  if (g !== c1 && g !== c2) throw new Error("Only captains can submit");
}

function ensureMatchEditableForAdmin(matchId) {
  const idx = getMatchIndex();
  const m = (idx.list || []).find(x => String(x.matchId) === String(matchId));
  if (!m) throw new Error("Match not found");

  const locked = safeUpper(m.ratingsLocked) === "TRUE";
  const status = safeUpper(m.status);
  if (locked || status === "CLOSED" || status === "COMPLETED") {
    throw new Error("Match locked. Use Unlock Match.");
  }
  return m;
}

function isRatingsLocked(matchId) {
  const idx = getMatchIndex();
  const m = (idx.list || []).find(x => String(x.matchId) === String(matchId));
  if (!m) return true;
  return safeUpper(m.ratingsLocked) === "TRUE";
}

/* =========================
   Leaderboard per season
   ========================= */

function leaderboardKey(seasonId) {
  const tok = getToken(`season:${seasonId}`);
  return `lb:v3:${seasonId}:${tok}`;
}

function getSeasonMatchIds(seasonId) {
  const idx = getMatchIndex();
  const list = (idx.list || [])
    .filter(m => matchBelongsToSeason(m, seasonId))
    .map(m => ensureAutoClose(m));
  return list.map(m => m.matchId);
}

function computeLeaderboardSeason(seasonId) {
  const cached = cacheGetJson(leaderboardKey(seasonId));
  if (cached) return cached;

  const matchIds = new Set(getSeasonMatchIds(seasonId));

  // goals/assists from events (optional)
  const goals = {};
  const assists = {};
  if (sheetExists(SHEET_EVENTS)) {
    const shE = getSheet(SHEET_EVENTS);
    const hE = headerMap(shE);
    const rowsE = readAllDataRows(shE);
    rowsE.forEach(r => {
      const mid = String(r[hE.matchId] || "");
      if (!matchIds.has(mid)) return;
      const p = String(r[hE.playerName] || "").trim();
      if (!p) return;
      const g = Number(r[hE.goals] || 0);
      const a = Number(r[hE.assists] || 0);
      goals[p] = (goals[p] || 0) + (g > 0 ? g : 0);
      assists[p] = (assists[p] || 0) + (a > 0 ? a : 0);
    });
  }

  // ratings avg from ratings sheet
  const shR = getSheet(SHEET_RATINGS);
  const hR = headerMap(shR);
  const rowsR = readAllDataRows(shR);

  const ratingSum = {};
  const ratingCount = {};

  rowsR.forEach(r => {
    const mid = String(r[hR.matchId] || "");
    if (!matchIds.has(mid)) return;
    const p = String(r[hR.playerName] || "").trim();
    const val = Number(r[hR.rating] || 0);
    if (!p || !(val > 0)) return;
    ratingSum[p] = (ratingSum[p] || 0) + val;
    ratingCount[p] = (ratingCount[p] || 0) + 1;
  });

  const players = new Set([
    ...Object.keys(goals),
    ...Object.keys(assists),
    ...Object.keys(ratingSum)
  ]);

  const rows = Array.from(players).map(p => ({
    playerName: p,
    goals: goals[p] || 0,
    assists: assists[p] || 0,
    avgRating: ratingCount[p] ? (ratingSum[p] / ratingCount[p]) : 0,
    matchesRated: ratingCount[p] || 0
  }));

  // Default sort by rating desc (UI can sort anyway)
  rows.sort((a, b) => (b.avgRating - a.avgRating) || (b.goals - a.goals) || (b.assists - a.assists));

  const out = { ok: true, seasonId, rows };
  cachePutJson(leaderboardKey(seasonId), out, TTL_LEADERBOARD);
  return out;
}

/* =========================
   doGet
   ========================= */

function doGet(e) {
  try {
    autoCloseSeasonsIfNeeded();

    const action = (e.parameter.action || "").toLowerCase();

    if (action === "ping") return jsonOut({ ok: true });

    if (action === "seasons") {
      const data = getSeasons();
      const currentSeasonId = getCurrentSeasonId();
      return jsonOut({ ok: true, seasons: data.seasons, currentSeasonId });
    }

    if (action === "players") {
      return jsonOut(getPlayersCached());
    }

    if (action === "public_matches_meta") {
      const seasonId = String(e.parameter.seasonId || getCurrentSeasonId());
      const tok = getToken(`season:${seasonId}`);
      const key = `public_meta:v2:${seasonId}:${tok}`;
      const cached = cacheGetJson(key);
      if (cached) return jsonOut(cached);

      const idx = getMatchIndex();
      const list = (idx.list || [])
        .filter(m => matchBelongsToSeason(m, seasonId))
        .map(m => ensureAutoClose(m));

const open = list
  .filter(m => safeUpper(m.status) === "OPEN")
  .sort((a, b) => {
    const ac = new Date(a.createdAt || 0).getTime();
    const bc = new Date(b.createdAt || 0).getTime();
    return bc - ac; // newest first
  });

      const top = open[0] || null;
      if (!top) {
        const out = { ok: true, fingerprint: "", latestCode: "" };
        cachePutJson(key, out, TTL_PUBLIC_META);
        return jsonOut(out);
      }

      const fingerprint = [top.matchId, top.status, top.date, top.time, top.type, top.title].join("|");
      const out = { ok: true, fingerprint, latestCode: String(top.publicCode || "") };
      cachePutJson(key, out, TTL_PUBLIC_META);
      return jsonOut(out);
    }

    // Open matches only (fast, no paging needed usually)
    if (action === "public_open_matches") {
      const seasonId = String(e.parameter.seasonId || getCurrentSeasonId());
      const tok = getToken(`season:${seasonId}`);
      const key = `public_open:v2:${seasonId}:${tok}`;
      const cached = cacheGetJson(key);
      if (cached) return jsonOut(cached);

      const idx = getMatchIndex();
      const list = (idx.list || [])
        .filter(m => matchBelongsToSeason(m, seasonId))
        .map(m => ensureAutoClose(m));

      const open = list
        .filter(m => safeUpper(m.status) === "OPEN")
        .sort((a, b) => parseMatchDateTime(a) - parseMatchDateTime(b));

      const out = { ok: true, seasonId, matches: open };
      cachePutJson(key, out, TTL_PUBLIC_LIST);
      return jsonOut(out);
    }

    // Past matches (paged)
    if (action === "public_past_matches") {
      const seasonId = String(e.parameter.seasonId || getCurrentSeasonId());
      const pageSize = Math.max(5, Math.min(50, Number(e.parameter.pageSize || 20)));
      const page = Math.max(1, Number(e.parameter.page || 1));
      const tok = getToken(`season:${seasonId}`);
      const key = `public_past:v2:${seasonId}:${tok}:p${page}:s${pageSize}`;
      const cached = cacheGetJson(key);
      if (cached) return jsonOut(cached);

      const idx = getMatchIndex();
      const list = (idx.list || [])
        .filter(m => matchBelongsToSeason(m, seasonId))
        .map(m => ensureAutoClose(m));

      const past = list
        .filter(m => safeUpper(m.status) !== "OPEN")
        .sort((a, b) => parseMatchDateTime(b) - parseMatchDateTime(a));

      const total = past.length;
      const start = (page - 1) * pageSize;
      const matches = past.slice(start, start + pageSize);

      const out = {
        ok: true,
        seasonId,
        page,
        pageSize,
        total,
        hasMore: (start + pageSize) < total,
        matches
      };
      cachePutJson(key, out, TTL_PUBLIC_LIST);
      return jsonOut(out);
    }

    if (action === "public_match") {
      const code = String(e.parameter.code || "");
      if (!code) return jsonOut({ ok: false, error: "code required" });

      const tok = getToken(`match:${code}`);
      const key = `public_match:v6:${code}:${tok}`;
      const cached = cacheGetJson(key);
      if (cached) return jsonOut(cached);

      let match = findMatchByCode(code);
      if (!match) return jsonOut({ ok: false, error: "Match not found" });

      match = ensureAutoClose(match);

      // Cached sub-reads to reduce repeated sheet scans on hot endpoints.
      // cacheScope must include match token so invalidation is automatic.
      const subScope = `${tok}`;
      const availability = readRowsByMatchIdCached(SHEET_AVAIL, match.matchId, subScope, TTL_PUBLIC_MATCH);
      const captains = getCaptainsRowCached(match.matchId, subScope, TTL_PUBLIC_MATCH);
      const teams = readRowsByMatchIdCached(SHEET_TEAMS, match.matchId, subScope, TTL_PUBLIC_MATCH);
      const ratings = readRowsByMatchIdCached(SHEET_RATINGS, match.matchId, subScope, TTL_PUBLIC_MATCH);
      const scores = readRowsByMatchIdCached(SHEET_SCORES, match.matchId, subScope, TTL_PUBLIC_MATCH);
      const events = sheetExists(SHEET_EVENTS)
        ? readRowsByMatchIdCached(SHEET_EVENTS, match.matchId, subScope, TTL_PUBLIC_MATCH)
        : [];

      const out = { ok: true, match, availability, captains, teams, ratings, scores, events };
      cachePutJson(key, out, TTL_PUBLIC_MATCH);
      return jsonOut(out);
    }

    if (action === "leaderboard_season") {
      const seasonId = String(e.parameter.seasonId || getCurrentSeasonId());
      return jsonOut(computeLeaderboardSeason(seasonId));
    }

    if (action === "admin_list_matches") {
      requireAdminKey(e.parameter.adminKey);
      const seasonId = String(e.parameter.seasonId || getCurrentSeasonId());

      // Cached because admins often click around; matches index + sheet reads can be slow.
      const tok = getToken(`season:${seasonId}`);
      const key = `admin_list:v2:${seasonId}:${tok}`;
      const cached = cacheGetJson(key);
      if (cached) return jsonOut(cached);

      const idx = getMatchIndex();
      const matches = (idx.list || [])
        .filter(m => matchBelongsToSeason(m, seasonId))
        .map(m => ensureAutoClose(m))
        .sort((a, b) => parseMatchDateTime(b) - parseMatchDateTime(a));

      const out = { ok: true, seasonId, matches };
      cachePutJson(key, out, 15);
      return jsonOut(out);
    }

    return jsonOut({ ok: false, error: "Unknown action" });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err.message || err) });
  }
}

/* =========================
   doPost
   ========================= */

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    autoCloseSeasonsIfNeeded();
    lock.tryLock(1500);

   const raw = e.postData?.contents || "";
let body = {};
try {
  body = JSON.parse(raw);
} catch (err) {
  // form-urlencoded fallback
  body = Object.assign({}, e.parameter || {});
  // parse JSON fields like rows if present
  if (typeof body.rows === "string") {
    try { body.rows = JSON.parse(body.rows); } catch {}
  }
  if (typeof body.bluePlayers === "string") {
    try { body.bluePlayers = JSON.parse(body.bluePlayers); } catch {}
  }
  if (typeof body.orangePlayers === "string") {
    try { body.orangePlayers = JSON.parse(body.orangePlayers); } catch {}
  }
}
const action = (body.action || "").toLowerCase();


/* =========================
   Public: Register Player
   ========================= */
if (action === "register_player") {
  const name = String(body.name || "").trim().replace(/\s+/g, " ");
  const phone = String(body.phone || "").trim();

  if (!name) {
    return jsonOut({ ok: false, error: "name required" });
  }

  const sh = getSheet(SHEET_PLAYERS);
  const h = headerMap(sh);
  const rows = readAllDataRows(sh);

  // Check if player already exists (case-insensitive)
  for (let i = 0; i < rows.length; i++) {
    const existingName = String(rows[i][h.name] || "").trim().toLowerCase();
    if (existingName === name.toLowerCase()) {
      return jsonOut({
        ok: true,
        existing: true,
        playerId: String(rows[i][h.playerId] || "")
      });
    }
  }

  // Create new player
  const playerId = "p_" + randCode(8);

  appendRow(SHEET_PLAYERS, {
    playerId,
    name,
    phone,
    isAdmin: "FALSE",
    createdAt: isoNow()
  });

  invalidatePlayers();

  return jsonOut({
    ok: true,
    existing: false,
    playerId
  });
}


    if (action === "admin_create_season") {
      requireAdminKey(body.adminKey);

      const name = String(body.name || "").trim().replace(/\s+/g, " ");
      const startDate = String(body.startDate || "").trim();
      const endDate = String(body.endDate || "").trim();
      if (!name || !startDate || !endDate) return jsonOut({ ok: false, error: "name/startDate/endDate required" });

      const seasonId = "s_" + randCode(8);
      appendRow(SHEET_SEASONS, {
        seasonId,
        name,
        startDate,
        endDate,
        status: "OPEN",
        createdAt: isoNow(),
        closedAt: ""
      });

      invalidateSeasons();
      return jsonOut({ ok: true, seasonId });
    }

    if (action === "admin_create_match") {
      requireAdminKey(body.adminKey);

      const title = String(body.title || "Weekly Match");
      const date = String(body.date || "").trim();
      const time = String(body.time || "").trim();
      const type = String(body.type || "INTERNAL").toUpperCase();
      const seasonId = String(body.seasonId || getCurrentSeasonId());

      if (!date || !time) return jsonOut({ ok: false, error: "date/time required" });
      if (!seasonId) return jsonOut({ ok: false, error: "seasonId required" });

      const matchId = "m_" + randCode(8);
      const publicCode = randCode(10);

      appendRow(SHEET_MATCHES, {
        matchId,
        title,
        date,
        time,
        type,
        status: "OPEN",
        publicCode,
        createdAt: isoNow(),
        ratingsLocked: "FALSE",
        autoClosedAt: "",
        scoreHome: "",
        scoreAway: "",
        seasonId,
        autoCloseEnabled: "TRUE"
      });

      appendRow(SHEET_CAPTAINS, {
        matchId,
        captain1: "",
        captain2: "",
        captain1Team: "",
        captain2Team: ""
      });

      invalidateMatches(seasonId, publicCode);
      return jsonOut({ ok: true, matchId, publicCode, seasonId });
    }

    if (action === "admin_unlock_match") {
      requireAdminKey(body.adminKey);
      const matchId = String(body.matchId || "");
      if (!matchId) return jsonOut({ ok: false, error: "matchId required" });

      // Resolve season/code for targeted cache invalidation
      const idx = getMatchIndex();
      const m = (idx.list || []).find(x => String(x.matchId) === String(matchId)) || null;

      // Unlock and keep OPEN even if start time passed => disable auto close
      setMatchFields(matchId, {
        ratingsLocked: "FALSE",
        status: "OPEN",
        autoCloseEnabled: "FALSE"
      });

      invalidateMatches(m?.seasonId, m?.publicCode);
      return jsonOut({ ok: true });
    }

    if (action === "admin_lock_ratings") {
      requireAdminKey(body.adminKey);
      const matchId = String(body.matchId || "");
      if (!matchId) return jsonOut({ ok: false, error: "matchId required" });

      const idx = getMatchIndex();
      const m = (idx.list || []).find(x => String(x.matchId) === String(matchId)) || null;

      setMatchFields(matchId, { ratingsLocked: "TRUE", status: "COMPLETED" });
      invalidateMatches(m?.seasonId, m?.publicCode);
      return jsonOut({ ok: true });
    }

    if (action === "admin_setup_opponent") {
      requireAdminKey(body.adminKey);
      const matchId = String(body.matchId || "");
      const captain = String(body.captain || "").trim();
      if (!matchId || !captain) return jsonOut({ ok: false, error: "matchId/captain required" });

      ensureMatchEditableForAdmin(matchId);

      const idx = getMatchIndex();
      const m = (idx.list || []).find(x => String(x.matchId) === String(matchId)) || null;

      const sh = getSheet(SHEET_CAPTAINS);
      const h = headerMap(sh);
      const rows = readAllDataRows(sh);

      for (let i = 0; i < rows.length; i++) {
        if (String(rows[i][h.matchId]) === String(matchId)) {
          sh.getRange(i + 2, h.captain1 + 1).setValue(captain);
          sh.getRange(i + 2, h.captain2 + 1).setValue("");
          if (h.captain1Team != null) sh.getRange(i + 2, h.captain1Team + 1).setValue("MLFC");
          if (h.captain2Team != null) sh.getRange(i + 2, h.captain2Team + 1).setValue("");
          invalidateMatches(m?.seasonId, m?.publicCode);
          return jsonOut({ ok: true });
        }
      }
      return jsonOut({ ok: false, error: "Captains row missing" });
    }

    if (action === "admin_setup_internal") {
      requireAdminKey(body.adminKey);

      const matchId = String(body.matchId || "");
      const bluePlayers = body.bluePlayers || [];
      const orangePlayers = body.orangePlayers || [];
      const captainBlue = String(body.captainBlue || "").trim();
      const captainOrange = String(body.captainOrange || "").trim();

      if (!matchId) return jsonOut({ ok: false, error: "matchId required" });
      if (!captainBlue || !captainOrange) return jsonOut({ ok: false, error: "captainBlue/captainOrange required" });

      ensureMatchEditableForAdmin(matchId);

      const idx = getMatchIndex();
      const m = (idx.list || []).find(x => String(x.matchId) === String(matchId)) || null;

      // overwrite TEAMS rows for matchId
      const teamSh = getSheet(SHEET_TEAMS);
      const th = headerMap(teamSh);
      const tRows = readAllDataRows(teamSh);

      for (let i = tRows.length - 1; i >= 0; i--) {
        if (String(tRows[i][th.matchId]) === String(matchId)) teamSh.deleteRow(i + 2);
      }

      bluePlayers.forEach(n => appendRow(SHEET_TEAMS, { matchId, playerName: String(n), team: "BLUE" }));
      orangePlayers.forEach(n => appendRow(SHEET_TEAMS, { matchId, playerName: String(n), team: "ORANGE" }));

      // update CAPTAINS row
      const capSh = getSheet(SHEET_CAPTAINS);
      const ch = headerMap(capSh);
      const cRows = readAllDataRows(capSh);

      for (let i = 0; i < cRows.length; i++) {
        if (String(cRows[i][ch.matchId]) === String(matchId)) {
          capSh.getRange(i + 2, ch.captain1 + 1).setValue(captainBlue);
          capSh.getRange(i + 2, ch.captain2 + 1).setValue(captainOrange);
          if (ch.captain1Team != null) capSh.getRange(i + 2, ch.captain1Team + 1).setValue("BLUE");
          if (ch.captain2Team != null) capSh.getRange(i + 2, ch.captain2Team + 1).setValue("ORANGE");
          invalidateMatches(m?.seasonId, m?.publicCode);
          return jsonOut({ ok: true });
        }
      }
      return jsonOut({ ok: false, error: "Captains row missing" });
    }

    // Captain score: scoreA/scoreB mean:
    // INTERNAL: Blue scoreA, Orange scoreB
    // OPPONENT: MLFC scoreA, Opponent scoreB
    if (action === "captain_submit_score") {
      const code = String(body.code || "");
      const captain = String(body.captain || "").trim();
      const mode = String(body.mode || "").toUpperCase(); // INTERNAL|OPPONENT (for clarity)
      const scoreA = Number(body.scoreA || 0);
      const scoreB = Number(body.scoreB || 0);

      const match = findMatchByCode(code);
      if (!match) return jsonOut({ ok: false, error: "Match not found" });

      const m2 = ensureAutoClose(match);
      if (isRatingsLocked(m2.matchId)) return jsonOut({ ok: false, error: "Ratings locked" });

      // Optional: if captains not set yet, allow admin-only; but here restrict if set
      try { ensureCaptainAllowed(m2.matchId, captain); } catch (e) { /* allow still if captain not set? */ }

      appendRow(SHEET_SCORES, {
        matchId: m2.matchId,
        givenBy: captain,
        team: mode,
        scoreFor: scoreA,
        scoreAgainst: scoreB,
        timestamp: isoNow()
      });

      // Save into matches for quick display (single official score resolution is admin responsibility)
      // For INTERNAL treat scoreHome=Blue, scoreAway=Orange
      // For OPPONENT treat scoreHome=MLFC, scoreAway=Opponent
      setMatchFields(m2.matchId, { scoreHome: scoreA, scoreAway: scoreB });

      invalidateMatches(m2.seasonId, m2.publicCode);
      return jsonOut({ ok: true });
    }
if (action === "set_availability") {
      const code = String(body.code || "").trim();
      const playerName = String(body.playerName || "").trim();
      const availability = String(body.availability || "").trim().toUpperCase(); // YES/NO/MAYBE

      if (!code) return jsonOut({ ok: false, error: "code required" });
      if (!playerName) return jsonOut({ ok: false, error: "playerName required" });
      if (!["YES", "NO", "MAYBE"].includes(availability)) {
        return jsonOut({ ok: false, error: "availability must be YES/NO/MAYBE" });
      }

      let match = findMatchByCode(code);
      if (!match) return jsonOut({ ok: false, error: "Match not found" });

      match = ensureAutoClose(match);
      if (safeUpper(match.status) !== "OPEN") {
        return jsonOut({ ok: false, error: "Match is not open" });
      }

      // Optional safety: ensure player exists in players sheet
      const players = getPlayersCached().players || [];
      const exists = players.some(p => String(p.name || "").toLowerCase() === playerName.toLowerCase());
      if (!exists) return jsonOut({ ok: false, error: "Player not registered" });

      // Upsert into availability sheet
      const sh = getSheet(SHEET_AVAIL);
      const h = headerMap(sh);
      const rows = readAllDataRows(sh);

      const idxMid = h.matchId;
      const idxName = h.playerName;
      const idxAvail = h.availability;
      const idxNote = h.note; // may exist
      const idxTs = h.timestamp; // may exist

      // Update existing row if present
      for (let i = 0; i < rows.length; i++) {
        if (
          String(rows[i][idxMid]) === String(match.matchId) &&
          String(rows[i][idxName] || "").trim().toLowerCase() === playerName.toLowerCase()
        ) {
          if (idxAvail != null) sh.getRange(i + 2, idxAvail + 1).setValue(availability);
          if (idxNote != null) sh.getRange(i + 2, idxNote + 1).setValue("");
          if (idxTs != null) sh.getRange(i + 2, idxTs + 1).setValue(isoNow());

          invalidateMatches(match.seasonId, match.publicCode);
          return jsonOut({ ok: true, updated: true });
        }
      }

      // Insert new
      appendRow(SHEET_AVAIL, {
        matchId: match.matchId,
        playerName: playerName,
        availability: availability,
        note: "",
        timestamp: isoNow()
      });

      invalidateMatches(match.seasonId, match.publicCode);
      return jsonOut({ ok: true, updated: false });
    }
    // Captain ratings batch:
    // rows: [{playerName, rating, teamAtMatch}]
    // - stores ratings
    // - stores teamAtMatch inside ratings
    // - ALSO updates TEAMS sheet (so match detail reflects captain team changes)
    if (action === "captain_submit_ratings_batch") {
      const code = String(body.code || "");
      const captain = String(body.captain || "").trim();
      const rows = body.rows || [];

      const match = findMatchByCode(code);
      if (!match) return jsonOut({ ok: false, error: "Match not found" });

      const m2 = ensureAutoClose(match);
      if (isRatingsLocked(m2.matchId)) return jsonOut({ ok: false, error: "Ratings locked" });

      // Restrict to captains if set
      try { ensureCaptainAllowed(m2.matchId, captain); } catch (e) { /* allow still if not set */ }
      // Append ratings + (optional) goals/assists
      //
      // Ratings are stored in SHEET_RATINGS (only when 1-10).
      // Goals/Assists are stored in SHEET_EVENTS (if that sheet exists).
      // To avoid double-counting, we replace existing EVENTS rows for (matchId, playerName)
      // for any player included in this batch.

      const eventMap = {}; // playerName -> {goals, assists}

      rows.forEach(r => {
        const p = String(r.playerName || '').trim();
        if (!p) return;

        const val = Number(r.rating || 0);
        const teamAtMatch = String(r.teamAtMatch || '').toUpperCase();

        // rating
        if (val >= 1 && val <= 10) {
          appendRow(SHEET_RATINGS, {
            matchId: m2.matchId,
            playerName: p,
            rating: val,
            givenBy: captain,
            timestamp: isoNow(),
            teamAtMatch: teamAtMatch
          });
        }

        // goals/assists (store even if 0 if provided)
        let g = r.goals;
        let a = r.assists;
        // Treat empty string / null as "not provided"
        const gProvided = g !== undefined && g !== null && String(g).trim() !== '';
        const aProvided = a !== undefined && a !== null && String(a).trim() !== '';
        if (gProvided || aProvided) {
          g = gProvided ? Number(g) : 0;
          a = aProvided ? Number(a) : 0;
          if (!Number.isFinite(g) || g < 0) g = 0;
          if (!Number.isFinite(a) || a < 0) a = 0;
          eventMap[p] = { goals: Math.floor(g), assists: Math.floor(a) };
        }
      });

      // Update EVENTS sheet with latest goals/assists for this match (best-effort)
      if (sheetExists(SHEET_EVENTS) && Object.keys(eventMap).length) {
        try {
          const eSh = getSheet(SHEET_EVENTS);
          const eH = headerMap(eSh);
          const eRows = readAllDataRows(eSh);

          // delete existing rows for this match + players in eventMap
          for (let i = eRows.length - 1; i >= 0; i--) {
            const mid = String(eRows[i][eH.matchId] || '');
            const pn = String(eRows[i][eH.playerName] || '').trim();
            if (mid === String(m2.matchId) && eventMap[pn]) {
              eSh.deleteRow(i + 2);
            }
          }

          // append new events rows
          Object.keys(eventMap).forEach(pn => {
            appendRow(SHEET_EVENTS, {
              matchId: m2.matchId,
              playerName: pn,
              goals: eventMap[pn].goals,
              assists: eventMap[pn].assists,
              givenBy: captain,
              timestamp: isoNow()
            });
          });
        } catch (e) {
          // ignore events update errors
        }
      }


      // Update TEAMS sheet with teamAtMatch for those players (best-effort)
      // This makes "captain changed teams" visible in public match detail.
      try {
        const teamSh = getSheet(SHEET_TEAMS);
        const th = headerMap(teamSh);
        const tRows = readAllDataRows(teamSh);

        // Build latest team map from input rows
        const newMap = {};
        rows.forEach(r => {
          const p = String(r.playerName || "").trim();
          const teamAtMatch = String(r.teamAtMatch || "").toUpperCase();
          if (!p) return;
          if (teamAtMatch === "BLUE" || teamAtMatch === "ORANGE") newMap[p] = teamAtMatch;
        });

        // Delete existing team rows for these players for this match
        for (let i = tRows.length - 1; i >= 0; i--) {
          const mid = String(tRows[i][th.matchId] || "");
          const pn = String(tRows[i][th.playerName] || "").trim();
          if (mid === String(m2.matchId) && newMap[pn]) {
            teamSh.deleteRow(i + 2);
          }
        }

        // Append new team rows
        Object.keys(newMap).forEach(pn => {
          appendRow(SHEET_TEAMS, { matchId: m2.matchId, playerName: pn, team: newMap[pn] });
        });
      } catch (e) {
        // ignore team update errors
      }

      invalidateMatches(m2.seasonId, m2.publicCode);
      return jsonOut({ ok: true });
    }

    return jsonOut({ ok: false, error: "Unknown action" });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch {}
  }
}
