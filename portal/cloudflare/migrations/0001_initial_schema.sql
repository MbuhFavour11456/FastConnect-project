PRAGMA foreign_keys = ON;

CREATE TABLE admins (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    days INTEGER NOT NULL CHECK (days > 0),
    price_xaf INTEGER NOT NULL CHECK (price_xaf > 0),
    description TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    device_name TEXT,
    mac_address TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'blocked')),
    last_seen_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
    plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
    phone_number TEXT NOT NULL,
    payment_network TEXT NOT NULL CHECK (payment_network IN ('mtn', 'orange')),
    amount_xaf INTEGER NOT NULL CHECK (amount_xaf > 0),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'paid', 'failed', 'expired')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX orders_status_created_at ON orders(status, created_at);
CREATE INDEX orders_device_id_created_at ON orders(device_id, created_at);

CREATE TABLE payments (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    provider_transaction_id TEXT UNIQUE,
    amount_xaf INTEGER NOT NULL CHECK (amount_xaf >= 0),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'successful', 'failed', 'expired', 'amount_mismatch')),
    payment_method TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    confirmed_at TEXT
);

CREATE INDEX payments_order_created_at ON payments(order_id, created_at);
CREATE UNIQUE INDEX payments_one_success_per_order
    ON payments(order_id)
    WHERE status = 'successful';

CREATE TABLE subscriptions (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
    plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'expired', 'revoked')),
    started_at TEXT,
    expires_at TEXT,
    access_applied_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX subscriptions_device_status ON subscriptions(device_id, status);
CREATE INDEX subscriptions_expiry ON subscriptions(status, expires_at);

CREATE TABLE router_commands (
    id TEXT PRIMARY KEY,
    subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
    action TEXT NOT NULL CHECK (action IN ('grant', 'revoke')),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'claimed', 'applied', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    claimed_at TEXT,
    applied_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX router_commands_pending
    ON router_commands(status, available_at, created_at);
CREATE UNIQUE INDEX router_commands_one_action_per_subscription
    ON router_commands(subscription_id, action);

CREATE TABLE audit_logs (
    id TEXT PRIMARY KEY,
    actor TEXT,
    action TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO plans (id, name, days, price_xaf, description, is_active)
VALUES
    ('10-day', '10-Day Plan', 10, 2000, '10 consecutive days of Wi-Fi access', 1),
    ('30-day', '30-Day Plan', 30, 5000, '30 consecutive days of Wi-Fi access', 1);
