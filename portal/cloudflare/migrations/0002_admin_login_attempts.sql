CREATE TABLE admin_login_attempts (
    attempt_key TEXT PRIMARY KEY,
    failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
    window_started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
