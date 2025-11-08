-- Migration number: 0002      2025-11-09T00:00:00.000Z
-- Adds fields required for the single-message status flow.

ALTER TABLE games ADD COLUMN status_message_id TEXT;
ALTER TABLE games ADD COLUMN buy_in_cents INTEGER NOT NULL DEFAULT 0;

-- Optional: ensure existing active games have at least some value.
UPDATE games SET buy_in_cents = 0 WHERE buy_in_cents IS NULL;
