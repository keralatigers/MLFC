// cache_cleanup.js
//
// Cleans old localStorage entries so the app stays fast and doesn’t hit quota.
//

const PREFIX_MATCH_DETAIL = "mlfc_match_detail_cache_v2:";
const KEY_MATCHES_LIST = "mlfc_matches_list_cache_v2";
const KEY_ADMIN_MATCHES = "mlfc_admin_matches_cache_ls_v1";

const MAX_MATCH_DETAIL_ITEMS = 80;           // keep at most 80 match detail entries
const MATCH_DETAIL_MAX_AGE_MS = 30 * 864e5;  // 30 days
const MAX_MATCH_LIST_ITEMS = 120;            // keep last 120 matches in list cache
const ADMIN_MATCHES_MAX_AGE_MS = 14 * 864e5; // 14 days

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

export function cleanupCaches() {
  try {
    const now = Date.now();

    // 1) Prune match detail caches by age and then by max count
    const detailKeys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX_MATCH_DETAIL)) detailKeys.push(k);
    }

    // Remove old by age
    detailKeys.forEach(k => {
      const obj = safeJsonParse(localStorage.getItem(k));
      const ts = obj?.ts;
      if (!ts || (now - ts) > MATCH_DETAIL_MAX_AGE_MS) {
        localStorage.removeItem(k);
      }
    });

    // Recompute keys after removing aged
    const remaining = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX_MATCH_DETAIL)) {
        const obj = safeJsonParse(localStorage.getItem(k));
        remaining.push({ k, ts: obj?.ts || 0 });
      }
    }

    // If too many, keep newest
    if (remaining.length > MAX_MATCH_DETAIL_ITEMS) {
      remaining.sort((a, b) => b.ts - a.ts);
      const toRemove = remaining.slice(MAX_MATCH_DETAIL_ITEMS);
      toRemove.forEach(x => localStorage.removeItem(x.k));
    }

    // 2) Trim matches list cache size
    const listRaw = localStorage.getItem(KEY_MATCHES_LIST);
    if (listRaw) {
      const listObj = safeJsonParse(listRaw);
      if (listObj?.items && Array.isArray(listObj.items)) {
        if (listObj.items.length > MAX_MATCH_LIST_ITEMS) {
          listObj.items = listObj.items.slice(0, MAX_MATCH_LIST_ITEMS);
          localStorage.setItem(KEY_MATCHES_LIST, JSON.stringify(listObj));
        }
      }
    }

    // 3) Prune admin matches cache by age (keep for 14 days)
    const adminRaw = localStorage.getItem(KEY_ADMIN_MATCHES);
    if (adminRaw) {
      const adminObj = safeJsonParse(adminRaw);
      const ts = adminObj?.ts;
      if (!ts || (now - ts) > ADMIN_MATCHES_MAX_AGE_MS) {
        localStorage.removeItem(KEY_ADMIN_MATCHES);
      }
    }
  } catch {
    // ignore cleanup failures
  }
}
