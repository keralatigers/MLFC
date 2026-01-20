// src/prefetch.js
//
// Background warmup to make the UI feel snappy even when APIs are slow.
//
// Design:
// - Cache-first everywhere (pages read from localStorage immediately).
// - Prefetch runs in the background and only updates caches.
// - Prefetch must use the same cache keys/shapes as the pages.

import { API } from "./api/endpoints.js";

const LS_SEASONS_CACHE = "mlfc_seasons_cache_v1"; // {ts,data}
const LS_SELECTED_SEASON = "mlfc_selected_season_v1";

// Match page cache keys (must match src/pages/match.js)
const LS_OPEN_CACHE_PREFIX = "mlfc_open_matches_cache_v2:";   // seasonId -> {ts,matches}
const LS_PAST_CACHE_PREFIX = "mlfc_past_matches_cache_v2:";   // seasonId -> {ts,page,pageSize,total,hasMore,matches}
const LS_MATCH_META_PREFIX = "mlfc_matches_meta_v2:";         // seasonId -> {ts,fingerprint,latestCode}
const LS_PLAYERS_CACHE = "mlfc_players_cache_v2";             // {ts,players:[name...]}

// Leaderboard page cache keys (must match src/pages/leaderboard.js)
const LS_LB_PREFIX = "mlfc_leaderboard_v2:"; // + seasonId => {ts,data}

const TTL = {
  seasons: 10 * 60 * 1000,      // 10 min
  players: 6 * 60 * 60 * 1000,  // 6h
  open: 60 * 1000,             // 1 min
  meta: 60 * 1000,             // 1 min
  past: 10 * 60 * 1000,        // 10 min
  leaderboard: 5 * 60 * 1000,  // 5 min
};

function now() { return Date.now(); }
function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

function isFresh(obj, ttlMs) {
  return !!(obj?.ts && (now() - obj.ts) < ttlMs);
}

function openKey(seasonId) { return `${LS_OPEN_CACHE_PREFIX}${seasonId}`; }
function pastKey(seasonId) { return `${LS_PAST_CACHE_PREFIX}${seasonId}`; }
function metaKey(seasonId) { return `${LS_MATCH_META_PREFIX}${seasonId}`; }
function lbKey(seasonId) { return `${LS_LB_PREFIX}${seasonId}`; }

async function getSeasonsCachedOrFetch() {
  const cached = lsGet(LS_SEASONS_CACHE);
  if (cached?.data?.ok && isFresh(cached, TTL.seasons)) return cached.data;
  const res = await API.seasons();
  if (res?.ok) lsSet(LS_SEASONS_CACHE, { ts: now(), data: res });
  return res;
}

function pickSeasonId(seasonsRes) {
  const seasons = seasonsRes?.seasons || [];
  const current = seasonsRes?.currentSeasonId || seasons[0]?.seasonId || "";
  const selected = localStorage.getItem(LS_SELECTED_SEASON) || "";
  if (selected && seasons.some(s => s.seasonId === selected)) return selected;
  if (current) return current;
  return "";
}

function uniqueSorted(arr) {
  return [...new Set(arr)].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function prefetchPlayers() {
  const cached = lsGet(LS_PLAYERS_CACHE);
  if (cached?.players?.length && isFresh(cached, TTL.players)) return;

  API.players()
    .then(res => {
      if (!res?.ok) return;
      const list = uniqueSorted((res.players || []).map(p => p.name));
      lsSet(LS_PLAYERS_CACHE, { ts: now(), players: list });
    })
    .catch(() => {});
}

function prefetchMatchTab(seasonId) {
  // Open matches
  const openCached = lsGet(openKey(seasonId));
  if (!openCached?.matches || !isFresh(openCached, TTL.open)) {
    API.publicOpenMatches(seasonId)
      .then(res => {
        if (res?.ok) lsSet(openKey(seasonId), { ts: now(), matches: res.matches || [] });
      })
      .catch(() => {});
  }

  // Matches meta (used for update banner)
  const metaCached = lsGet(metaKey(seasonId));
  if (!metaCached || !isFresh(metaCached, TTL.meta)) {
    API.publicMatchesMeta(seasonId)
      .then(res => {
        if (!res?.ok) return;
        lsSet(metaKey(seasonId), { ts: now(), fingerprint: res.fingerprint || "", latestCode: res.latestCode || "" });
      })
      .catch(() => {});
  }

  // Past matches (page 1) - helps when user expands Past section
  const pastCached = lsGet(pastKey(seasonId));
  if (!pastCached?.matches || !isFresh(pastCached, TTL.past)) {
    API.publicPastMatches(seasonId, 1, 20)
      .then(res => {
        if (res?.ok) lsSet(pastKey(seasonId), { ts: now(), ...res });
      })
      .catch(() => {});
  }
}

function prefetchLeaderboard(seasonId) {
  const cached = lsGet(lbKey(seasonId));
  if (cached?.data?.ok && isFresh(cached, TTL.leaderboard)) return;

  API.leaderboardSeason(seasonId)
    .then(res => {
      if (res?.ok) lsSet(lbKey(seasonId), { ts: now(), data: res });
    })
    .catch(() => {});
}

// Prefetch ONCE at app load; does not block UI.
export async function warmAppData() {
  // Fire-and-forget tasks. The only awaited call is seasons (so we know seasonId).
  prefetchPlayers();

  try {
    const seasonsRes = await getSeasonsCachedOrFetch();
    if (!seasonsRes?.ok) return;

    const seasonId = pickSeasonId(seasonsRes);
    if (!seasonId) return;

    // Warm other tabs in background
    prefetchMatchTab(seasonId);
    prefetchLeaderboard(seasonId);
  } catch {
    // ignore
  }
}
