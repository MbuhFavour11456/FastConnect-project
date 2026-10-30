CREATE TABLE admin_invitations (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    full_name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,
    expires_at TEXT NOT NULL,
    accepted_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX admin_invitations_one_pending_username
    ON admin_invitations(username)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;
