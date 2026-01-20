import { startRouter } from "./router.js";
import { warmAppData } from "./prefetch.js";

function boot() {
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
