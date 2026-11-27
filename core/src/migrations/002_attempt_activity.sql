-- Active-time tracking. solve_time_sec stays wall-clock (start → finish); active_time_sec counts only the time
-- between activity events that are close together, so breaks, nights and days away are not "solve time".

CREATE TABLE attempt_activity (
  id          INTEGER PRIMARY KEY,
  attempt_id  INTEGER NOT NULL REFERENCES attempts(id),
  kind        TEXT NOT NULL,   -- start | edit | run | hint | tutor | focus | finish
  at          TEXT NOT NULL
);
CREATE INDEX idx_activity_attempt ON attempt_activity(attempt_id, at);

-- NULL for attempts recorded before tracking existed (their active time is unknown).
ALTER TABLE attempts ADD COLUMN active_time_sec INTEGER;
