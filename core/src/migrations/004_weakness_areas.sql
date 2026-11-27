-- Weaknesses are general skill gaps grouped into areas; each observation keeps the specific slip as a note.
ALTER TABLE weaknesses ADD COLUMN area TEXT;
ALTER TABLE weakness_attempts ADD COLUMN note TEXT;
