// src/storage.js
//
// Optimized localStorage helpers:
// - In-memory read-through cache (avoid repeated JSON.parse)
// - Debounced + idle writes (reduce main-thread JSON.stringify cost)
//
// API compatibility: exports lsGet, lsSet, lsDel, isFresh

const MEM = new Map();
const PENDING = new Map();
const WRITE_TIMERS = new Map();

function safeParse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function scheduleWrite(key) {
  if (WRITE_TIMERS.has(key)) return;

  const flush = () => {
    WRITE_TIMERS.delete(key);
    if (!PENDING.has(key)) return;
    const val = PENDING.get(key);
    PENDING.delete(key);
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch {
      // ignore quota / serialization issues
    }
  };

  // Prefer idle time to avoid jank on mobile.
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(flush, { timeout: 600 });
    WRITE_TIMERS.set(key, id);
  } else {
    const id = setTimeout(flush, 50);
    WRITE_TIMERS.set(key, id);
  }
}

export function lsGet(key) {
  if (MEM.has(key)) return MEM.get(key);
  try {
    const raw = localStorage.getItem(key);
    const parsed = safeParse(raw);
    MEM.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function lsSet(key, value) {
  // Always update in-memory immediately so UI reads are instant.
  MEM.set(key, value);
  PENDING.set(key, value);
  scheduleWrite(key);
}

export function lsDel(key) {
  MEM.delete(key);
  PENDING.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {}
}

export function isFresh(entry, ttlMs) {
  if (!entry || !entry.ts) return false;
  return (Date.now() - entry.ts) <= ttlMs;
}

// Optional: allow callers to clear the in-memory cache (debug/testing)
export function __clearMemCache() {
  MEM.clear();
}