CREATE TABLE customer_email_tokens (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK (purpose IN ('verify_email', 'password_reset')),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX customer_email_tokens_customer_purpose
    ON customer_email_tokens(customer_id, purpose, expires_at);

CREATE INDEX customer_email_tokens_expiry
    ON customer_email_tokens(expires_at);
