import { recordVerifiedPaymentResult } from "./payments.js";
import { getCurrentCustomer } from "./customer-auth.js";

const SANDBOX_URL = "https://sandbox.fapshi.com";
const LOCAL_INTENT_PREFIX = "INIT-";
const testPhoneNumbers = {
  mtn: new Set(["650000000", "650000001", "670000000", "670000001", "670000002", "670000003"]),
  orange: new Set(["656000000", "656000001", "690000000", "690000001", "690000002", "690000003"]),
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function configured(env) {
  return (
    typeof env.FAPSHI_API_USER === "string" &&
    env.FAPSHI_API_USER.length > 0 &&
    typeof env.FAPSHI_API_KEY === "string" &&
    env.FAPSHI_API_KEY.length > 0
  );
}

function validTestPhone(phone, network) {
  const localPhone = phone.replace(/^\+237/, "");
  return testPhoneNumbers[network]?.has(localPhone) ?? false;
}

function secureEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function fapshiRequest(env, path, options = {}) {
  if (!configured(env)) {
    throw new Error("Fapshi sandbox credentials are not configured");
  }

  const response = await fetch(`${SANDBOX_URL}${path}`, {
    ...options,
    headers: {
      apiuser: env.FAPSHI_API_USER,
      apikey: env.FAPSHI_API_KEY,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    return { ok: false, status: response.status };
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, status: response.status };
  }
  return { ok: true, body };
}

function normalizeProviderStatus(status) {
  if (typeof status !== "string") return null;
  const normalized = status.toUpperCase();
  if (normalized === "CREATED" || normalized === "PENDING") return "pending";
  if (normalized === "SUCCESSFUL") return "successful";
  if (normalized === "FAILED") return "failed";
  if (normalized === "EXPIRED") return "expired";
  return null;
}

async function verifiedStatus(env, transId, order, expectedMedium) {
  const response = await fapshiRequest(
    env,
    `/payment-status/${encodeURIComponent(transId)}`,
  );
  if (!response.ok) return null;

  const transaction = response.body;
  const status = normalizeProviderStatus(transaction.status);
  const mediumMatches =
    expectedMedium === "orange money"
      ? transaction.medium === "orange money"
      : transaction.medium === "mobile money";
  if (
    transaction.transId !== transId ||
    transaction.externalId !== order.reference ||
    transaction.transType !== "Collection" ||
    !Number.isSafeInteger(transaction.amount) ||
    transaction.amount < 0 ||
    !status ||
    !mediumMatches
  ) {
    return null;
  }
  return {
    orderReference: order.reference,
    providerTransactionId: transId,
    amountXaf: transaction.amount,
    status,
  };
}

async function getOrderPayment(db, reference, macAddress, customerId = null) {
  return db
    .prepare(
      `SELECT o.id, o.reference, o.amount_xaf, o.status AS order_status,
              o.phone_number, o.payment_network, d.mac_address,
              payments.id AS payment_id,
              payments.provider_transaction_id, payments.status AS payment_status,
              payments.amount_xaf AS payment_amount, payments.status_checked_at
       FROM orders AS o
       JOIN devices AS d ON d.id = o.device_id
       LEFT JOIN payments ON payments.id = (
         SELECT payment.id
         FROM payments AS payment
         WHERE payment.order_id = o.id
         ORDER BY CASE payment.status
           WHEN 'pending' THEN 0
           WHEN 'successful' THEN 1
           ELSE 2
         END, payment.created_at DESC
         LIMIT 1
       )
       WHERE o.reference = ?
         AND (
           (? IS NOT NULL AND o.customer_id = ?)
           OR (? IS NULL AND o.customer_id IS NULL AND d.mac_address = ?)
         )`,
    )
    .bind(reference, customerId, customerId, customerId, macAddress)
    .first();
}

export async function startSandboxPayment(request, env, db, reference) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return jsonResponse({ error: "Content-Type must be application/json" }, 400);
  }
  if (Number(request.headers.get("content-length") ?? 0) > 4096) {
    return jsonResponse({ error: "Request body is too large" }, 400);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON" }, 400);
  }
  if (!body || Array.isArray(body) || typeof body.macAddress !== "string") {
    return jsonResponse({ error: "A valid device MAC address is required" }, 400);
  }
  const macAddress = body.macAddress.trim().replaceAll("-", ":").toUpperCase();
  if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(macAddress)) {
    return jsonResponse({ error: "A valid device MAC address is required" }, 400);
  }
  const customer = await getCurrentCustomer(request, db);
  if (!configured(env)) {
    return jsonResponse({ error: "Fapshi sandbox credentials are not configured" }, 503);
  }

  const order = await getOrderPayment(db, reference, macAddress, customer?.id ?? null);
  if (!order || order.order_status !== "pending") {
    return jsonResponse({ error: "Pending order not found for this device" }, 404);
  }
  if (!validTestPhone(order.phone_number, order.payment_network)) {
    return jsonResponse(
      { error: "Sandbox payments accept only Fapshi's documented test numbers for the selected network" },
      422,
    );
  }
  if (order.payment_status === "successful") {
    return jsonResponse({ error: "This order has already been paid" }, 409);
  }
  if (order.payment_status === "amount_mismatch") {
    return jsonResponse(
      { error: "Fapshi reported a payment amount mismatch. Contact the owner before trying again." },
      409,
    );
  }
  if (order.payment_status === "pending") {
    return jsonResponse(
      {
        paymentStatus: "pending",
        message: order.provider_transaction_id.startsWith(LOCAL_INTENT_PREFIX)
          ? "Payment request is being checked; do not submit another request."
          : "A sandbox payment request is already active for this order.",
      },
      200,
    );
  }

  const localTransactionId = `${LOCAL_INTENT_PREFIX}${crypto.randomUUID()}`;
  const intent = await db
    .prepare(
      `INSERT INTO payments
         (id, order_id, provider_transaction_id, amount_xaf, status, payment_method)
       SELECT ?, o.id, ?, o.amount_xaf, 'pending', 'fapshi'
       FROM orders AS o
       WHERE o.id = ? AND o.status = 'pending'
         AND NOT EXISTS (
           SELECT 1 FROM payments AS existing
           WHERE existing.order_id = o.id
             AND existing.status IN ('pending', 'successful')
         )`,
    )
    .bind(crypto.randomUUID(), localTransactionId, order.id)
    .run();
  if (intent.meta?.changes !== 1) {
    return jsonResponse({ error: "A payment request already exists for this order" }, 409);
  }

  let initiated;
  try {
    initiated = await fapshiRequest(env, "/direct-pay", {
      method: "POST",
      body: JSON.stringify({
        amount: order.amount_xaf,
        phone: order.phone_number.replace(/^\+237/, ""),
        medium: order.payment_network === "orange" ? "orange money" : "mobile money",
        externalId: order.reference,
        message: `FastConnect sandbox order ${order.reference}`,
      }),
    });
  } catch (error) {
    console.error("Fapshi sandbox initiation could not be confirmed:", error.message);
    return jsonResponse(
      { error: "Could not confirm whether the sandbox request started. Do not retry; check order status or contact the owner." },
      503,
    );
  }

  if (!initiated.ok && initiated.status >= 500) {
    console.error("Fapshi sandbox returned an uncertain initiation response:", initiated.status);
    return jsonResponse(
      { error: "Fapshi could not confirm whether the sandbox request started. Do not retry; check order status or contact the owner." },
      503,
    );
  }
  if (!initiated.ok) {
    await db
      .prepare(
        `UPDATE payments SET status = 'failed'
         WHERE provider_transaction_id = ? AND status = 'pending'`,
      )
      .bind(localTransactionId)
      .run();
    console.error("Fapshi sandbox rejected the initiation request:", initiated.status);
    return jsonResponse(
      { error: "Fapshi sandbox rejected the payment request. Check the test credentials and configuration." },
      502,
    );
  }
  const transId = initiated.body?.transId;
  if (typeof transId !== "string" || transId.length === 0 || transId.length > 160) {
    console.error("Fapshi sandbox initiation response did not contain a valid transaction ID");
    return jsonResponse(
      { error: "Fapshi returned an incomplete response. Do not retry; check order status or contact the owner." },
      502,
    );
  }

  await db
    .prepare(
      `UPDATE payments SET provider_transaction_id = ?
       WHERE provider_transaction_id = ? AND status = 'pending'`,
    )
    .bind(transId, localTransactionId)
    .run();
  return jsonResponse({
    paymentStatus: "pending",
    message: "Sandbox payment request sent. Confirm it on the test number's simulated payment prompt.",
  });
}

export async function checkSandboxPayment(request, env, db, reference) {
  const url = new URL(request.url);
  const macAddress = url.searchParams
    .get("mac")
    ?.trim()
    .replaceAll("-", ":")
    .toUpperCase();
  if (!macAddress || !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(macAddress)) {
    return jsonResponse({ error: "A valid device MAC address is required" }, 400);
  }
  const order = await getOrderPayment(db, reference, macAddress);
  if (!order) return jsonResponse({ error: "Order not found" }, 404);
  if (!order.provider_transaction_id) {
    return jsonResponse({ paymentStatus: "not_started" });
  }
  if (order.payment_status !== "pending") {
    return jsonResponse({ paymentStatus: order.payment_status });
  }
  if (order.provider_transaction_id.startsWith(LOCAL_INTENT_PREFIX)) {
    return jsonResponse({ paymentStatus: "pending" });
  }
  if (!configured(env)) {
    return jsonResponse({ error: "Fapshi sandbox credentials are not configured" }, 503);
  }

  const now = new Date();
  const checkedAt = now.toISOString();
  const earliestCheck = new Date(now.getTime() - 10000).toISOString();
  const reservation = await db
    .prepare(
      `UPDATE payments SET status_checked_at = ?
       WHERE id = ? AND status = 'pending'
         AND (status_checked_at IS NULL OR status_checked_at <= ?)`,
    )
    .bind(checkedAt, order.payment_id, earliestCheck)
    .run();
  if (reservation.meta?.changes !== 1) {
    return jsonResponse({ paymentStatus: "pending", retryAfterSeconds: 10 });
  }

  const verified = await verifiedStatus(
    env,
    order.provider_transaction_id,
    order,
    order.payment_network === "orange" ? "orange money" : "mobile money",
  );
  if (!verified) {
    return jsonResponse({ error: "Could not verify the payment status with Fapshi sandbox" }, 502);
  }
  const reconciliation = await recordVerifiedPaymentResult(db, verified);
  return jsonResponse({
    paymentStatus: reconciliation.paymentStatus ??
      (reconciliation.outcome === "provisioning_queued" ? "successful" : verified.status),
    orderStatus: reconciliation.orderStatus,
  });
}

export async function handleFapshiWebhook(request, env, db) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return jsonResponse({ error: "Content-Type must be application/json" }, 400);
  }
  if (Number(request.headers.get("content-length") ?? 0) > 4096) {
    return jsonResponse({ error: "Webhook payload is too large" }, 400);
  }
  if (!env.FAPSHI_WEBHOOK_SECRET) {
    return jsonResponse({ error: "Fapshi webhook secret is not configured" }, 503);
  }
  if (!secureEqual(request.headers.get("x-wh-secret"), env.FAPSHI_WEBHOOK_SECRET)) {
    return jsonResponse({ error: "Unauthorized webhook" }, 401);
  }
  let event;
  try {
    event = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid webhook payload" }, 400);
  }
  if (
    !event ||
    typeof event.transId !== "string" ||
    event.transId.length === 0 ||
    typeof event.externalId !== "string" ||
    event.externalId.length === 0
  ) {
    return jsonResponse({ error: "Invalid webhook payload" }, 400);
  }
  const order = await db
    .prepare(
      `SELECT o.id, o.reference, o.amount_xaf, o.status AS order_status,
              o.payment_network
       FROM orders AS o
       WHERE o.reference = ?`,
    )
    .bind(event.externalId)
    .first();
  if (!order) return jsonResponse({ error: "Unknown order" }, 404);

  const verified = await verifiedStatus(
    env,
    event.transId,
    order,
    order.payment_network === "orange" ? "orange money" : "mobile money",
  );
  if (!verified) {
    return jsonResponse({ error: "Could not verify the webhook transaction" }, 502);
  }
  const reconciliation = await recordVerifiedPaymentResult(db, verified);
  return jsonResponse({ received: true, outcome: reconciliation.outcome });
}
