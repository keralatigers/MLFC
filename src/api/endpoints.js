import { apiGet, apiPost } from "./client.js";

export const API = {
  ping: () => apiGet({ action: "ping" }),

  // public
  players: () => apiGet({ action: "players" }),
  registerPlayer: (name, phone) => apiPost({ action:"register_player", name, phone }),

  publicMatches: (page = 1, pageSize = 20) =>
    apiGet({ action: "public_matches", page: String(page), pageSize: String(pageSize) }),

  getPublicMatch: (code) => apiGet({ action: "public_match", code }),

  setAvailability: (publicCode, playerName, availability, note) =>
    apiPost({ action:"set_availability", publicCode, playerName, availability, note }),

  leaderboard: () => apiGet({ action:"leaderboard" }),

  // admin
  adminListMatches: (adminKey) => apiGet({ action:"admin_list_matches", adminKey }),
  adminCreateMatch: (adminKey, payload) => apiPost({ action:"admin_create_match", adminKey, ...payload }),
  adminCloseMatch: (adminKey, matchId) => apiPost({ action:"admin_close_match", adminKey, matchId }),
  adminLockRatings: (adminKey, matchId) => apiPost({ action:"admin_lock_ratings", adminKey, matchId }),
  adminUnlockMatch: (adminKey, matchId) => apiPost({ action:"admin_unlock_match", adminKey, matchId }),

  adminSetupOpponent: (adminKey, payload) => apiPost({ action:"admin_setup_opponent", adminKey, ...payload }),
  adminSetupInternal: (adminKey, payload) => apiPost({ action:"admin_setup_internal", adminKey, ...payload }),

  // captain
  captainSubmitRatingsBatch: (publicCode, givenBy, ratings) =>
    apiPost({ action:"captain_submit_ratings_batch", publicCode, givenBy, ratings }),

  captainSubmitScore: (publicCode, givenBy, team, scoreFor, scoreAgainst) =>
    apiPost({ action:"captain_submit_score", publicCode, givenBy, team, scoreFor, scoreAgainst })
};
