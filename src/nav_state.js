// src/nav_state.js
//
// Browser reload detection + scoping helpers.
// We want to re-fetch from API ONLY when the user performs a *browser reload*
// on the *current* page, not just because the app happened to be loaded via reload.

const RELOAD_HASH_KEY = "mlfc_reload_hash_v1";

function detectBrowserReload() {
  try {
    const nav = performance.getEntriesByType?.("navigation")?.[0];
    if (nav && typeof nav.type === "string") return nav.type === "reload";
  } catch {}

  // Legacy fallback (deprecated but still present in some browsers)
  try {
    return performance?.navigation?.type === 1;
  } catch {
    return false;
  }
}

// Some modules only need a boolean "was this navigation a browser reload?".
// Keep this named export for compatibility.
export function isBrowserReload() {
  return detectBrowserReload();
}

// Call once on boot (safe to call multiple times)
export function initReloadContext() {
  try {
    if (!detectBrowserReload()) return;
    // Store the *initial* hash that was loaded via reload.
    // Example: "#/match?code=ABC" or "#/admin"
    const hash = window.location.hash || "#/match";
    sessionStorage.setItem(RELOAD_HASH_KEY, hash);
  } catch {}
}

export function getReloadHash() {
  try {
    return sessionStorage.getItem(RELOAD_HASH_KEY) || "";
  } catch {
    return "";
  }
}

// True only when the current app load was a browser reload AND the
// reloaded URL hash starts with the given prefix (e.g. "#/match", "#/admin").
export function isReloadFor(prefix) {
  const h = getReloadHash();
  return !!h && h.startsWith(prefix);
}

// Match list: treat as reload ONLY if the reload happened on the list view
// (i.e. "#/match" with no ?code=...)
export function isReloadForMatchList() {
  const { path, query } = getReloadQuery();
  if (path !== "#/match") return false;
  const c = query.get("code") || "";
  return !c;
}

// Admin list: treat as reload ONLY if the reload happened on list views
// (i.e. not on manage view)
export function isReloadForAdminList() {
  const { path, query } = getReloadQuery();
  if (path !== "#/admin") return false;
  const view = (query.get("view") || "open").toLowerCase();
  return view !== "manage";
}

export function getReloadQuery() {
  const h = getReloadHash();
  const [path, qs] = h.split("?");
  return { path, query: new URLSearchParams(qs || "") };
}

// Match detail: only treat as reload if the reload happened *on that match code*.
export function isReloadForMatchCode(code) {
  const { path, query } = getReloadQuery();
  if (path !== "#/match") return false;
  const c = query.get("code") || "";
  return !!c && c === String(code || "");
}

export function isReloadForAdminMatchCode(code) {
  const { path, query } = getReloadQuery();
  if (path !== "#/admin") return false;
  const c = query.get("code") || "";
  return !!c && c === String(code || "");
}
