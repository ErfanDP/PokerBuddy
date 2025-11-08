-- Migration number: 0001 	 2025-11-08T21:09:42.413Z
-- games in a chat (one active at a time)
CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active'   -- active | ended
);

-- players who joined the current game
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT,
  first_name TEXT,
  joined_at INTEGER NOT NULL,
  UNIQUE (game_id, user_id)
);

-- buy-ins (need 2 approvals)
CREATE TABLE IF NOT EXISTS buyins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'  -- pending | approved | rejected
);

-- approvals (distinct approvers; buyer cannot approve)
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  buyin_id INTEGER NOT NULL,
  approver_user_id TEXT NOT NULL,
  decision TEXT NOT NULL,                  -- approve | reject
  created_at INTEGER NOT NULL,
  UNIQUE (buyin_id, approver_user_id)
);

CREATE INDEX IF NOT EXISTS idx_games_chat ON games(chat_id, status);
CREATE INDEX IF NOT EXISTS idx_buyins_game ON buyins(game_id, status);
CREATE INDEX IF NOT EXISTS idx_approvals_buyin ON approvals(buyin_id);
