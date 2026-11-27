-- Deliberate probing: mark evidence that came from the tutor testing a weakness on purpose.
ALTER TABLE weakness_attempts ADD COLUMN probed INTEGER NOT NULL DEFAULT 0;

-- Short drills on a weakness (practice; they don't change the weakness status — real problems do).
CREATE TABLE weakness_drills (
  id           INTEGER PRIMARY KEY,
  weakness_id  INTEGER NOT NULL REFERENCES weaknesses(id),
  session_id   INTEGER REFERENCES sessions(id),
  at           TEXT NOT NULL,
  correct      INTEGER NOT NULL CHECK (correct >= 0),
  total        INTEGER NOT NULL CHECK (total >= 1 AND correct <= total),
  note         TEXT
);
CREATE INDEX idx_drills_weakness ON weakness_drills(weakness_id, at);
