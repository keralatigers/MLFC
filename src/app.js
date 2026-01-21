import { startRouter } from "./router.js";
import { warmAppData } from "./prefetch.js";
import { initReloadContext } from "./nav_state.js";

function boot() {
  // Record reload context (if this app load is a browser reload)
  initReloadContext();

  // Prefetch API data without blocking UI
  warmAppData().catch(() => {});

  // Start hash router + initial render
  startRouter();
}

// Make sure DOM exists first
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
