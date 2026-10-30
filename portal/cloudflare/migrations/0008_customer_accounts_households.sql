PRAGMA foreign_keys = ON;

CREATE TABLE customers (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    full_name TEXT NOT NULL,
    phone_number TEXT,
    password_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended', 'closed')),
    email_verified_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX customers_status_created_at
    ON customers(status, created_at DESC);

CREATE TABLE customer_login_attempts (
    attempt_key TEXT PRIMARY KEY,
    failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
    window_started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE customer_sessions (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX customer_sessions_customer_expiry
    ON customer_sessions(customer_id, expires_at);

CREATE UNIQUE INDEX customer_sessions_one_current_per_customer
    ON customer_sessions(customer_id)
    WHERE revoked_at IS NULL;

ALTER TABLE orders
    ADD COLUMN customer_id TEXT REFERENCES customers(id) ON DELETE RESTRICT;

ALTER TABLE subscriptions
    ADD COLUMN customer_id TEXT REFERENCES customers(id) ON DELETE RESTRICT;

CREATE INDEX orders_customer_created_at
    ON orders(customer_id, created_at DESC);

CREATE INDEX subscriptions_customer_status
    ON subscriptions(customer_id, status);

CREATE TABLE households (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended', 'closed')),
    created_by_admin_id TEXT REFERENCES admins(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX households_owner_status
    ON households(owner_customer_id, status);

CREATE TABLE household_memberships (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('invited', 'pending', 'active', 'suspended', 'removed')),
    approved_by_admin_id TEXT REFERENCES admins(id) ON DELETE SET NULL,
    approved_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (household_id, customer_id)
);

CREATE INDEX household_memberships_customer_status
    ON household_memberships(customer_id, status);

CREATE INDEX household_memberships_household_status
    ON household_memberships(household_id, status);

CREATE TABLE access_entitlements (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    entitlement_type TEXT NOT NULL
        CHECK (entitlement_type IN ('paid_subscription', 'household', 'guest', 'admin_comp')),
    source_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended', 'expired', 'revoked')),
    starts_at TEXT NOT NULL,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (entitlement_type, source_id, customer_id)
);

CREATE INDEX access_entitlements_customer_status
    ON access_entitlements(customer_id, status, starts_at, expires_at);

CREATE TABLE guest_passes (
    id TEXT PRIMARY KEY,
    household_id TEXT REFERENCES households(id) ON DELETE CASCADE,
    created_by_customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
    created_by_admin_id TEXT REFERENCES admins(id) ON DELETE SET NULL,
    token_hash TEXT NOT NULL UNIQUE,
    duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 5 AND 1440),
    status TEXT NOT NULL DEFAULT 'available'
        CHECK (status IN ('available', 'claimed', 'expired', 'revoked')),
    expires_at TEXT NOT NULL,
    claimed_by_customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
    claimed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (household_id IS NOT NULL OR created_by_admin_id IS NOT NULL)
);

CREATE INDEX guest_passes_status_expiry
    ON guest_passes(status, expires_at);

CREATE TABLE customer_network_sessions (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    router_session_id TEXT,
    router_name TEXT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'ended', 'revoked', 'failed')),
    started_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    ended_at TEXT,
    end_reason TEXT
);

CREATE UNIQUE INDEX customer_network_sessions_one_active_per_customer
    ON customer_network_sessions(customer_id)
    WHERE status = 'active';

CREATE INDEX customer_network_sessions_customer_status
    ON customer_network_sessions(customer_id, status, started_at DESC);

CREATE TABLE account_audit_logs (
    id TEXT PRIMARY KEY,
    customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('customer', 'admin', 'system')),
    actor_id TEXT,
    action TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX account_audit_logs_customer_created_at
    ON account_audit_logs(customer_id, created_at DESC);
