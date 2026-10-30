ALTER TABLE subscriptions ADD COLUMN expired_at TEXT;

CREATE INDEX subscriptions_active_expiry
    ON subscriptions(status, expires_at);
