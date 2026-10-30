export async function expireSubscriptions(db, now = new Date()) {
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
    throw new Error("D1 database binding is unavailable for subscription expiry");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("Subscription expiry clock returned an invalid date");
  }

  const timestamp = now.toISOString();
  const { results: dueSubscriptions } = await db
    .prepare(
      `SELECT id, device_id, expires_at
       FROM subscriptions
       WHERE status = 'active'
         AND expires_at IS NOT NULL
         AND expires_at <= ?
       ORDER BY expires_at ASC, id ASC
       LIMIT 100`,
    )
    .bind(timestamp)
    .all();
  let expiredCount = 0;
  let revocationsQueued = 0;

  for (const subscription of dueSubscriptions) {
    const results = await db.batch([
      db
        .prepare(
          `UPDATE subscriptions
           SET status = 'expired', expired_at = ?
           WHERE id = ? AND status = 'active' AND expires_at <= ?`,
        )
        .bind(timestamp, subscription.id, timestamp),
      db
        .prepare(
          `UPDATE router_commands
           SET status = 'failed',
               last_error = 'subscription_expired_before_grant'
           WHERE action = 'grant'
             AND status = 'pending'
             AND subscription_id = ?
             AND EXISTS (
               SELECT 1 FROM subscriptions
               WHERE id = ? AND status = 'expired' AND expired_at = ?
             )`,
        )
        .bind(subscription.id, subscription.id, timestamp),
      db
        .prepare(
          `INSERT INTO router_commands (id, subscription_id, action, status)
           SELECT ?, id, 'revoke', 'pending'
           FROM subscriptions
           WHERE id = ? AND status = 'expired' AND expired_at = ?
           ON CONFLICT(subscription_id, action) DO NOTHING`,
        )
        .bind(crypto.randomUUID(), subscription.id, timestamp),
      db
        .prepare(
          `INSERT INTO audit_logs (id, actor, action, details, created_at)
           SELECT ?, 'subscription-expiry', 'subscription_expired', ?, ?
           WHERE EXISTS (
             SELECT 1 FROM subscriptions
             WHERE id = ? AND status = 'expired' AND expired_at = ?
           )
           ON CONFLICT(id) DO NOTHING`,
        )
        .bind(
          `subscription-expired:${subscription.id}`,
          JSON.stringify({
            subscriptionId: subscription.id,
            deviceId: subscription.device_id,
            expiresAt: subscription.expires_at,
          }),
          timestamp,
          subscription.id,
          timestamp,
        ),
    ]);
    expiredCount += Number(results[0]?.meta?.changes ?? results[0]?.changes ?? 0);
    revocationsQueued += Number(results[2]?.meta?.changes ?? results[2]?.changes ?? 0);
  }

  return {
    expiredCount,
    revocationsQueued,
  };
}
