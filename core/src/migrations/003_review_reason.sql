-- Reviews are only for problems you struggled with: remember why, and count clean reviews toward graduating out.
ALTER TABLE review_queue ADD COLUMN reason TEXT;
ALTER TABLE review_queue ADD COLUMN clean_streak INTEGER NOT NULL DEFAULT 0;
