// src/api/endpoints.js
import { apiGet, apiPost } from "./client.js";

export const API = {
  // seasons
  seasons: () => apiGet({ action: "seasons" }),
  leaderboardSeason: (seasonId) => apiGet({ action: "leaderboard_season", seasonId }),

  // public matches (season-scoped)
  publicOpenMatches: (seasonId) => apiGet({ action: "public_open_matches", seasonId }),
  publicPastMatches: (seasonId, page, pageSize) => apiGet({ action: "public_past_matches", seasonId, page, pageSize }),
  publicMatchesMeta: (seasonId) => apiGet({ action: "public_matches_meta", seasonId }),

  // players / public match
  players: () => apiGet({ action: "players" }),
  getPublicMatch: (code) => apiGet({ action: "public_match", code }),
setAvailability: (code, playerName, availability) =>
  apiPost({ action: "set_availability", code, playerName, availability }),
registerPlayer(name, phone = "") {
  return apiPost({
    action: "register_player",
    name,
    phone
  });
},
  // admin
  adminListMatches: (adminKey, seasonId) => apiGet({ action: "admin_list_matches", adminKey, seasonId }),
  adminCreateMatch: (adminKey, payload) => apiPost({ action: "admin_create_match", adminKey, ...payload }),
  adminCreateSeason: (adminKey, payload) => apiPost({ action: "admin_create_season", adminKey, ...payload }),
  adminLockRatings: (adminKey, matchId) => apiPost({ action: "admin_lock_ratings", adminKey, matchId }),
  adminUnlockMatch: (adminKey, matchId) => apiPost({ action: "admin_unlock_match", adminKey, matchId }),
  adminSetupInternal: (adminKey, payload) => apiPost({ action: "admin_setup_internal", adminKey, ...payload }),
  adminSetupOpponent: (adminKey, payload) => apiPost({ action: "admin_setup_opponent", adminKey, ...payload }),

  // captain
  captainSubmitScore: (code, captain, mode, a, b) =>
    apiPost({ action: "captain_submit_score", code, captain, mode, scoreA: a, scoreB: b }),

  captainSubmitRatingsBatch: (code, captain, rows) =>
    apiPost({ action: "captain_submit_ratings_batch", code, captain, rows }),
};
