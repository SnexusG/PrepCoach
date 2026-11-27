-- Mixed drills span several weaknesses: a set may have no single weakness, each question names its own, and
-- finishing records one result per weakness. (SQLite can't drop NOT NULL in place, so the table is rebuilt.)
CREATE TABLE drill_sets_new (
  id           INTEGER PRIMARY KEY,
  weakness_id  INTEGER REFERENCES weaknesses(id),   -- null for a mixed drill
  mixed        INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'in_progress', 'done')),
  questions    TEXT NOT NULL,
  answers      TEXT NOT NULL DEFAULT '{}',
  drill_ids    TEXT NOT NULL DEFAULT '[]',          -- weakness_drills rows recorded when finished
  finished_at  TEXT
);
INSERT INTO drill_sets_new (id, weakness_id, mixed, created_at, status, questions, answers, drill_ids, finished_at)
  SELECT id, weakness_id, 0, created_at, status, questions, answers,
         CASE WHEN drill_id IS NULL THEN '[]' ELSE json_array(drill_id) END, finished_at
  FROM drill_sets;
DROP TABLE drill_sets;
ALTER TABLE drill_sets_new RENAME TO drill_sets;
CREATE INDEX idx_drill_sets_weakness ON drill_sets(weakness_id, status);
CREATE INDEX idx_drill_sets_mixed ON drill_sets(mixed, status);
