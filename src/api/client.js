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
    setVisible(false);
  }
}

export async function apiGet(params) {
  loadingStart();
  try {
    const url = new URL(CONFIG.API_BASE);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const res = await fetch(url.toString(), {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
    });

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
    // Use form-encoded to avoid CORS preflight with Apps Script
    const params = new URLSearchParams();
    Object.entries(body || {}).forEach(([k, v]) => {
      // If object/array, stringify
      if (typeof v === "object") params.set(k, JSON.stringify(v));
      else params.set(k, String(v));
    });

    const res = await fetch(CONFIG.API_BASE, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: params.toString(),
    });

    return await res.json();
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    loadingEnd();
  }
}

