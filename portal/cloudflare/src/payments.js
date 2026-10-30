const providerStatuses = new Set(["pending", "successful", "failed", "expired"]);

function isValidVerifiedResult(result) {
  return (
    result !== null &&
    typeof result === "object" &&
    typeof result.orderReference === "string" &&
    result.orderReference.length > 0 &&
    result.orderReference.length <= 120 &&
    typeof result.providerTransactionId === "string" &&
    result.providerTransactionId.length > 0 &&
    result.providerTransactionId.length <= 160 &&
    Number.isSafeInteger(result.amountXaf) &&
    result.amountXaf >= 0 &&
    providerStatuses.has(result.status)
  );
}

function timestampFromClock(clock) {
  const date = clock();
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error("Payment workflow clock returned an invalid date");
  }

  return date.toISOString();
}

export async function recordVerifiedPaymentResult(db, result, clock = () => new Date()) {
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
    throw new Error("D1 database binding is unavailable for payment processing");
  }

  if (!isValidVerifiedResult(result)) {
    return { outcome: "invalid_result" };
  }

  const now = timestampFromClock(clock);
  const order = await db
    .prepare(
      `SELECT o.id, o.reference, o.amount_xaf, o.status, o.device_id,
              o.customer_id, o.plan_id, p.days
       FROM orders AS o
       JOIN plans AS p ON p.id = o.plan_id
       WHERE o.reference = ?`,
    )
    .bind(result.orderReference)
    .first();

  if (!order) {
    return { outcome: "unknown_order" };
  }

  const existingTransaction = await db
    .prepare(
      `SELECT order_id, amount_xaf, status
       FROM payments
       WHERE provider_transaction_id = ?`,
    )
    .bind(result.providerTransactionId)
    .first();

  if (existingTransaction && existingTransaction.order_id !== order.id) {
    return { outcome: "transaction_conflict" };
  }

  if (order.status === "paid") {
    return {
      outcome: existingTransaction ? "duplicate" : "already_paid",
      orderStatus: "paid",
    };
  }

  if (order.status !== "pending") {
    return { outcome: "order_not_payable", orderStatus: order.status };
  }

  const pendingPayment = await db
    .prepare(
      `SELECT id, provider_transaction_id
       FROM payments
       WHERE order_id = ? AND status = 'pending'`,
    )
    .bind(order.id)
    .first();
  const paymentId = crypto.randomUUID();
  const subscriptionId = crypto.randomUUID();
  const commandId = crypto.randomUUID();
  const confirmedAt =
    result.status === "successful" && result.amountXaf === order.amount_xaf
      ? now
      : null;
  const recordedStatus =
    result.status === "successful" && result.amountXaf !== order.amount_xaf
      ? "amount_mismatch"
      : result.status;
  const expiresAt =
    confirmedAt === null
      ? null
      : new Date(
          new Date(confirmedAt).getTime() + order.days * 24 * 60 * 60 * 1000,
        ).toISOString();

  const paymentWrite = pendingPayment
    ? db
        .prepare(
          `UPDATE payments
           SET provider_transaction_id = ?, amount_xaf = ?, status = ?,
               confirmed_at = ?
           WHERE id = ? AND order_id = ? AND status = 'pending'
             AND (provider_transaction_id = ? OR NOT EXISTS (
               SELECT 1 FROM payments AS existing
               WHERE existing.provider_transaction_id = ?
             ))`,
        )
        .bind(
          result.providerTransactionId,
          result.amountXaf,
          recordedStatus,
          confirmedAt,
          pendingPayment.id,
          order.id,
          result.providerTransactionId,
          result.providerTransactionId,
        )
    : db
        .prepare(
          `INSERT INTO payments
             (id, order_id, provider_transaction_id, amount_xaf, status,
              payment_method, confirmed_at)
           SELECT ?, o.id, ?, ?, ?, 'fapshi', ?
           FROM orders AS o
           WHERE o.id = ?
             AND o.status = 'pending'
             AND NOT EXISTS (
               SELECT 1 FROM payments AS existing
               WHERE existing.order_id = o.id
                 AND existing.status IN ('pending', 'successful')
             )
           ON CONFLICT(provider_transaction_id) DO UPDATE SET
             amount_xaf = excluded.amount_xaf,
             status = excluded.status,
             confirmed_at = excluded.confirmed_at
           WHERE payments.order_id = excluded.order_id
             AND payments.status = 'pending'`,
        )
        .bind(
          paymentId,
          result.providerTransactionId,
          result.amountXaf,
          recordedStatus,
          confirmedAt,
          order.id,
        );

  const batchResults = await db.batch([
    paymentWrite,
    db
      .prepare(
        `UPDATE orders
         SET status = 'paid', updated_at = ?
         WHERE id = ?
           AND status = 'pending'
           AND EXISTS (
             SELECT 1 FROM payments
             WHERE payments.order_id = orders.id
               AND payments.provider_transaction_id = ?
               AND payments.status = 'successful'
               AND payments.amount_xaf = orders.amount_xaf
           )`,
      )
      .bind(now, order.id, result.providerTransactionId),
    db
      .prepare(
        `INSERT INTO subscriptions
           (id, order_id, customer_id, device_id, plan_id, status, started_at, expires_at)
         SELECT ?, o.id, o.customer_id, o.device_id, o.plan_id, 'active', ?, ?
         FROM orders AS o
         WHERE o.id = ? AND o.status = 'paid'
           AND EXISTS (
             SELECT 1 FROM payments
             WHERE payments.order_id = o.id
               AND payments.provider_transaction_id = ?
               AND payments.status = 'successful'
               AND payments.amount_xaf = o.amount_xaf
           )
         ON CONFLICT(order_id) DO NOTHING`,
      )
      .bind(subscriptionId, confirmedAt, expiresAt, order.id, result.providerTransactionId),
    db
      .prepare(
        `INSERT INTO router_commands (id, subscription_id, action, status)
         SELECT ?, subscriptions.id, 'grant', 'pending'
         FROM subscriptions
         WHERE subscriptions.order_id = ? AND subscriptions.status = 'active'
         ON CONFLICT(subscription_id, action) DO NOTHING`,
      )
      .bind(commandId, order.id),
    db
      .prepare(
        `INSERT INTO audit_logs (id, actor, action, details, created_at)
         VALUES (?, 'payment-verifier', ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        recordedStatus === "successful" && confirmedAt !== null
          ? "payment_confirmed"
          : recordedStatus === "amount_mismatch"
            ? "payment_amount_mismatch"
            : `payment_${recordedStatus}`,
        JSON.stringify({
          orderReference: order.reference,
          transactionId: result.providerTransactionId,
          amountXaf: result.amountXaf,
        }),
        now,
      ),
  ]);

  const paymentWriteCount = batchResults[0]?.meta?.changes ?? 0;
  const updatedOrder = await db
    .prepare("SELECT status FROM orders WHERE id = ?")
    .bind(order.id)
    .first();
  const payment = await db
    .prepare(
      `SELECT amount_xaf, status
       FROM payments
       WHERE provider_transaction_id = ? AND order_id = ?`,
    )
    .bind(result.providerTransactionId, order.id)
    .first();

  if (paymentWriteCount === 0) {
    return {
      outcome: payment ? "duplicate" : "already_paid",
      orderStatus: updatedOrder.status,
    };
  }

  if (recordedStatus === "amount_mismatch") {
    return {
      outcome: "amount_mismatch",
      orderStatus: updatedOrder.status,
      expectedAmountXaf: order.amount_xaf,
      receivedAmountXaf: result.amountXaf,
    };
  }

  if (recordedStatus !== "successful") {
    return {
      outcome: "recorded",
      paymentStatus: recordedStatus,
      orderStatus: updatedOrder.status,
    };
  }

  return {
    outcome: "provisioning_queued",
    orderStatus: updatedOrder.status,
    subscriptionExpiresAt: expiresAt,
  };
}
