-- PrepCoach schema v1. Track-agnostic: track ∈ ('dsa','system_design','java').

CREATE TABLE tracks (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  enabled  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE topics (
  id          INTEGER PRIMARY KEY,
  track       TEXT NOT NULL REFERENCES tracks(id),
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (track, name)
);

CREATE TABLE problems (
  slug               TEXT PRIMARY KEY,
  track              TEXT NOT NULL REFERENCES tracks(id),
  title              TEXT NOT NULL,
  topic_id           INTEGER NOT NULL REFERENCES topics(id),
  secondary_topics   TEXT NOT NULL DEFAULT '[]',   -- JSON array of topic names
  difficulty         TEXT NOT NULL CHECK (difficulty IN ('easy','medium','hard')),
  difficulty_rating  REAL NOT NULL,
  url                TEXT,
  generated          INTEGER NOT NULL DEFAULT 0     -- Problem.md / stub / tests written
);

-- Pluggable sheets: a problem can appear in several sheets.
CREATE TABLE sheet_problems (
  sheet        TEXT NOT NULL,
  slug         TEXT NOT NULL REFERENCES problems(slug),
  sheet_order  INTEGER NOT NULL,
  verified     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (sheet, slug)
);

CREATE TABLE sessions (
  id              INTEGER PRIMARY KEY,
  track           TEXT NOT NULL REFERENCES tracks(id),
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  reviews_served  INTEGER NOT NULL DEFAULT 0,
  summary         TEXT
);

CREATE TABLE attempts (
  id              INTEGER PRIMARY KEY,
  session_id      INTEGER REFERENCES sessions(id),
  problem_slug    TEXT NOT NULL REFERENCES problems(slug),
  status          TEXT NOT NULL DEFAULT 'in_progress'
                    CHECK (status IN ('in_progress','completed','abandoned')),
  is_review       INTEGER NOT NULL DEFAULT 0,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  solve_time_sec  INTEGER,
  hints_used      INTEGER NOT NULL DEFAULT 0 CHECK (hints_used BETWEEN 0 AND 4),
  tests_passed    INTEGER,
  tests_total     INTEGER,
  last_run_at     TEXT,
  rubric          TEXT,           -- JSON: tutor rubric + computed components
  outcome_score   REAL,
  tutor_summary   TEXT
);
CREATE INDEX idx_attempts_problem ON attempts(problem_slug);
CREATE INDEX idx_attempts_status ON attempts(status);

CREATE TABLE hint_log (
  attempt_id  INTEGER NOT NULL REFERENCES attempts(id),
  level       INTEGER NOT NULL,
  given_at    TEXT NOT NULL
);

CREATE TABLE ratings (
  topic_id        INTEGER PRIMARY KEY REFERENCES topics(id),
  track           TEXT NOT NULL REFERENCES tracks(id),
  rating          REAL NOT NULL,
  attempts_count  INTEGER NOT NULL DEFAULT 0,
  last_updated    TEXT
);

CREATE TABLE attempt_rating_changes (
  attempt_id     INTEGER NOT NULL REFERENCES attempts(id),
  topic_id       INTEGER NOT NULL REFERENCES topics(id),
  is_primary     INTEGER NOT NULL,
  weight         REAL NOT NULL,
  expected       REAL NOT NULL,
  k              REAL NOT NULL,
  rating_before  REAL NOT NULL,
  rating_after   REAL NOT NULL,
  PRIMARY KEY (attempt_id, topic_id)
);

-- topic_id NULL = overall track rating.
CREATE TABLE rating_history (
  id           INTEGER PRIMARY KEY,
  track        TEXT NOT NULL REFERENCES tracks(id),
  topic_id     INTEGER REFERENCES topics(id),
  rating       REAL NOT NULL,
  recorded_at  TEXT NOT NULL,
  attempt_id   INTEGER REFERENCES attempts(id)
);
CREATE INDEX idx_rating_history ON rating_history(track, topic_id, recorded_at);

CREATE TABLE weaknesses (
  id                    INTEGER PRIMARY KEY,
  track                 TEXT NOT NULL REFERENCES tracks(id),
  topic_id              INTEGER REFERENCES topics(id),
  description           TEXT NOT NULL,
  times_observed        INTEGER NOT NULL DEFAULT 1,
  clean_demonstrations  INTEGER NOT NULL DEFAULT 0,
  first_seen            TEXT NOT NULL,
  last_seen             TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','improving','resolved'))
);

CREATE TABLE weakness_attempts (
  weakness_id  INTEGER NOT NULL REFERENCES weaknesses(id),
  attempt_id   INTEGER NOT NULL REFERENCES attempts(id),
  kind         TEXT NOT NULL CHECK (kind IN ('observed','handled_well')),
  PRIMARY KEY (weakness_id, attempt_id)
);

CREATE TABLE review_queue (
  problem_slug   TEXT PRIMARY KEY REFERENCES problems(slug),
  due_date       TEXT NOT NULL,     -- YYYY-MM-DD local
  interval_days  INTEGER NOT NULL,
  ease           REAL NOT NULL,
  last_outcome   REAL NOT NULL,
  reviews_count  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE preferences (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
