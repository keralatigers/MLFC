export function lsGet(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function lsSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota
  }
}

export function lsDel(key) {
  try {
    localStorage.removeItem(key);
  } catch {}
}

export function isFresh(entry, ttlMs) {
  if (!entry || !entry.ts) return false;
  return (Date.now() - entry.ts) <= ttlMs;
}
