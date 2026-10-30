ALTER TABLE payments ADD COLUMN status_checked_at TEXT;

CREATE UNIQUE INDEX payments_one_pending_per_order
    ON payments(order_id)
    WHERE status = 'pending';
