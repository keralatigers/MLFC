import { CONFIG } from "../config.js";

/**
 * Global loading bar controller:
 * - shows only if request takes >300ms
 * - supports multiple concurrent requests
 */
let inflight = 0;
let showTimer = null;

function setVisible(visible) {
  const el = document.getElementById("loadingbar");
  if (!el) return;
  el.classList.toggle("loadingbar--show", visible);
}

function loadingStart() {
  inflight += 1;

  // Only show after 300ms to avoid flicker
  if (inflight === 1) {
    if (showTimer) clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      // still inflight?
      if (inflight > 0) setVisible(true);
    }, 300);
  }
}

function loadingEnd() {
  inflight = Math.max(0, inflight - 1);

  if (inflight === 0) {
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    // hide immediately
    setVisible(false);
  }
}

export async function apiGet(params) {
  loadingStart();
  try {
    const url = new URL(CONFIG.API_BASE);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString(), { method: "GET" });
    return await res.json();
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    loadingEnd();
  }
}

export async function apiPost(body) {
  loadingStart();
  try {
    const res = await fetch(CONFIG.API_BASE, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body)
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    loadingEnd();
  }
}
