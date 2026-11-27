-- Drill page: a generated set of questions on one weakness, answered one at a time.
CREATE TABLE drill_sets (
  id           INTEGER PRIMARY KEY,
  weakness_id  INTEGER NOT NULL REFERENCES weaknesses(id),
  created_at   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'in_progress', 'done')),
  questions    TEXT NOT NULL,            -- JSON: DrillQuestion[]
  answers      TEXT NOT NULL DEFAULT '{}', -- JSON: { [index]: DrillAnswer }
  drill_id     INTEGER REFERENCES weakness_drills(id),  -- the recorded result, once finished
  finished_at  TEXT
);
CREATE INDEX idx_drill_sets_weakness ON drill_sets(weakness_id, status);
