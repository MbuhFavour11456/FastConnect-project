CREATE TABLE vouchers (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
    plan_name TEXT NOT NULL,
    plan_days INTEGER NOT NULL CHECK (plan_days > 0),
    amount_xaf INTEGER NOT NULL CHECK (amount_xaf > 0),
    note TEXT,
    status TEXT NOT NULL DEFAULT 'unused'
        CHECK (status IN ('unused', 'redeemed', 'cancelled')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    redeemed_at TEXT,
    redeemed_device_id TEXT REFERENCES devices(id) ON DELETE RESTRICT,
    cancelled_at TEXT
);

CREATE INDEX vouchers_status_created_at
    ON vouchers(status, created_at DESC);
CREATE INDEX vouchers_plan_id_created_at
    ON vouchers(plan_id, created_at DESC);
