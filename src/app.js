import { getRoute } from "./router.js";
import { renderMatchPage } from "./pages/match.js";
import { renderAdminPage } from "./pages/admin.js";
import { renderLeaderboardPage } from "./pages/leaderboard.js";
import { renderRegisterPage } from "./pages/register.js";
import { renderCaptainPage } from "./pages/captain.js";

const app = document.getElementById("app");

async function render() {
  const { path, query } = getRoute();

  if (path === "#/admin") return renderAdminPage(app, query);
  if (path === "#/leaderboard") return renderLeaderboardPage(app, query);
  if (path === "#/register") return renderRegisterPage(app, query);
  if (path === "#/captain") return renderCaptainPage(app, query);

  return renderMatchPage(app, query);
}

window.addEventListener("hashchange", render);
render();
