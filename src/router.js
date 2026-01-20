// src/router.js
import { renderMatchPage } from "./pages/match.js";
import { renderLeaderboardPage } from "./pages/leaderboard.js";
import { renderAdminPage } from "./pages/admin.js";
import { renderCaptainPage } from "./pages/captain.js";
import { renderRegisterPage } from "./pages/register.js";

const ROUTES = {
  "#/match": renderMatchPage,
  "#/leaderboard": renderLeaderboardPage,
  "#/admin": renderAdminPage,
  "#/captain": renderCaptainPage,
  "#/register": renderRegisterPage,
};

const PAGE_CONTAINERS = {};   // route -> div
const LAST_HASH_BY_ROUTE = {}; // route -> full hash (includes query)

// Used by pages to cancel stale async UI updates
export function getRouteToken() {
  return window.__mlfcRouteToken || "";
}
export function setRouteToken() {
  window.__mlfcRouteToken = String(Math.random());
  return window.__mlfcRouteToken;
}

// Compatibility export (in case anything still imports getRoute)
export function getRoute() {
  const hash = window.location.hash || "#/match";
  const [path, qs] = hash.split("?");
  const query = new URLSearchParams(qs || "");
  return { path, query };
}

function getPathQueryAndHash() {
  const hash = window.location.hash || "#/match";
  const [path, qs] = hash.split("?");
  const query = new URLSearchParams(qs || "");
  return { path, query, fullHash: hash };
}

function getRoot() {
  const root = document.getElementById("app");
  if (!root) throw new Error("Missing #app in index.html");
  return root;
}

function ensureContainer(route) {
  const root = getRoot();
  if (!PAGE_CONTAINERS[route]) {
    const div = document.createElement("div");
    div.dataset.route = route;
    div.style.display = "none";
    root.appendChild(div);
    PAGE_CONTAINERS[route] = div;
  }
  return PAGE_CONTAINERS[route];
}

function showOnly(route) {
  Object.entries(PAGE_CONTAINERS).forEach(([r, el]) => {
    el.style.display = (r === route) ? "block" : "none";
  });
}

async function renderRoute() {
  const { path, query, fullHash } = getPathQueryAndHash();
  const route = ROUTES[path] ? path : "#/match";
  const token = setRouteToken();

  const container = ensureContainer(route);
  showOnly(route);

  const lastHash = LAST_HASH_BY_ROUTE[route] || "";
  const firstTime = !container.dataset.rendered;

  // Key behavior:
  // - Switch tabs: no rerender if same hash for that route
  // - Open match detail: hash changes (#/match?code=...) => rerender match page
  const shouldRender = firstTime || (fullHash !== lastHash);
  LAST_HASH_BY_ROUTE[route] = fullHash;

  if (!shouldRender) return;

  try {
    // Only show a loading placeholder the first time a route is created
    if (firstTime) {
      container.innerHTML = `<div class="card"><div class="h1">Loading…</div><div class="small">Please wait.</div></div>`;
    }
    await ROUTES[route](container, query, token);

    // Mark rendered only if still current token
    if (getRouteToken() === token) container.dataset.rendered = "1";
  } catch (e) {
    console.error(e);
    container.innerHTML = `
      <div class="card">
        <div class="h1">Something went wrong</div>
        <div class="small">${String(e?.message || e)}</div>
      </div>
    `;
  }
}

window.addEventListener("hashchange", renderRoute);

export function startRouter() {
  if (!window.location.hash) window.location.hash = "#/match";
  renderRoute();
}
