-- Whether the participant accepted being discoverable (introductions to their email, card live).
-- 0 = declined or not yet decided (card paused on decline); 1 = accepted.
ALTER TABLE claims ADD COLUMN accepted INTEGER NOT NULL DEFAULT 0;
