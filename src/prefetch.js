import { API } from "./api/endpoints.js";

const CACHE = {
  players: { key: "mlfc_cache_players_v2", ttlMs: 12 * 60 * 60 * 1000 },     // 12h
  leaderboard: { key: "mlfc_cache_leaderboard_v2", ttlMs: 5 * 60 * 1000 },   // 5m
  publicMatches: { key: "mlfc_cache_public_matches_v2", ttlMs: 60 * 1000 }   // 1m
};

function now() { return Date.now(); }

function getCache(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}
function setCache(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function readCacheBlock(def) {
  const c = getCache(def.key);
  if (!c || !c.ts || !c.data) return null;
  if ((now() - c.ts) > def.ttlMs) return null;
  return c.data;
}

export function readCachedPlayers() {
  return readCacheBlock(CACHE.players);
}
export function readCachedLeaderboard() {
  return readCacheBlock(CACHE.leaderboard);
}
export function readCachedPublicMatches() {
  return readCacheBlock(CACHE.publicMatches);
}

// Prefetch ONCE at app load; does not auto refresh later
export async function warmAppData() {
  // Fire-and-forget; does not block UI
  prefetchPlayers(false).catch(() => {});
  prefetchLeaderboard(false).catch(() => {});
  prefetchPublicMatches(false).catch(() => {});
}

export async function prefetchPlayers(force = false) {
  const existing = getCache(CACHE.players.key);
  if (!force && existing?.ts && (now() - existing.ts) < CACHE.players.ttlMs) return existing.data;

  const res = await API.players();
  if (res.ok) setCache(CACHE.players.key, { ts: now(), data: res });
  return res.ok ? res : null;
}

export async function prefetchLeaderboard(force = false) {
  const existing = getCache(CACHE.leaderboard.key);
  if (!force && existing?.ts && (now() - existing.ts) < CACHE.leaderboard.ttlMs) return existing.data;

  const res = await API.leaderboard();
  if (res.ok) setCache(CACHE.leaderboard.key, { ts: now(), data: res });
  return res.ok ? res : null;
}

export async function prefetchPublicMatches(force = false) {
  const existing = getCache(CACHE.publicMatches.key);
  if (!force && existing?.ts && (now() - existing.ts) < CACHE.publicMatches.ttlMs) return existing.data;

  const res = await API.publicMatches();
  if (res.ok) setCache(CACHE.publicMatches.key, { ts: now(), data: res });
  return res.ok ? res : null;
}
