import { handleRouterSimulatorRequest } from "./router-queue.js";
import { handleAdminRequest } from "./admin-auth.js";
import {
  checkSandboxPayment,
  handleFapshiWebhook,
  startSandboxPayment,
} from "./fapshi.js";
import { expireSubscriptions } from "./subscription-expiry.js";
import { handleCustomerAuthRequest } from "./customer-auth.js";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...jsonHeaders, ...headers },
  });
}

function badRequest(message) {
  return jsonResponse({ error: message }, 400);
}

function normalizeMacAddress(value) {
  if (typeof value !== "string") {
    return null;
  }

  const macAddress = value.trim().replaceAll("-", ":").toUpperCase();
  return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(macAddress)
    ? macAddress
    : null;
}

function normalizePhoneNumber(value) {
  if (typeof value !== "string") {
    return null;
  }

  const phoneNumber = value.trim().replace(/[\s()-]/g, "");
  if (/^6\d{8}$/.test(phoneNumber)) {
    return `+237${phoneNumber}`;
  }

  return /^\+2376\d{8}$/.test(phoneNumber) ? phoneNumber : null;
}

function isValidOrderInput(body) {
  return (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    typeof body.planId === "string" &&
    typeof body.macAddress === "string" &&
    typeof body.phoneNumber === "string" &&
    (body.paymentNetwork === "mtn" || body.paymentNetwork === "orange") &&
    (body.deviceName === undefined ||
      (typeof body.deviceName === "string" && body.deviceName.length <= 120))
  );
}

async function checkDatabase(db) {
  if (!db || typeof db.prepare !== "function") {
    throw new Error("Cloudflare D1 binding DB is unavailable");
  }

  const result = await db.prepare("SELECT 1 AS ok").first();
  if (result?.ok !== 1) {
    throw new Error("Cloudflare D1 health check failed");
  }
}

async function listPlans(db) {
  if (!db || typeof db.prepare !== "function") {
    throw new Error("Cloudflare D1 binding DB is unavailable");
  }

  const { results } = await db
    .prepare(
      `SELECT id, name, days, price_xaf, description
       FROM plans
       WHERE is_active = 1
       ORDER BY days ASC`,
    )
    .all();

  return results.map((plan) => ({
    id: plan.id,
    name: plan.name,
    days: plan.days,
    priceXaf: plan.price_xaf,
    description: plan.description,
  }));
}

async function getOrderStatus(reference, macAddress, db) {
  const order = await db
    .prepare(
      `SELECT orders.status AS order_status,
              plans.name AS plan_name,
              plans.days AS plan_days,
              orders.amount_xaf,
              subscriptions.status AS subscription_status,
              subscriptions.started_at,
              subscriptions.expires_at
       FROM orders
       JOIN devices ON devices.id = orders.device_id
       JOIN plans ON plans.id = orders.plan_id
       LEFT JOIN subscriptions ON subscriptions.order_id = orders.id
       WHERE orders.reference = ? AND devices.mac_address = ?`,
    )
    .bind(reference, macAddress)
    .first();

  if (!order) {
    return jsonResponse({ error: "Order not found" }, 404);
  }

  return jsonResponse({
    orderStatus: order.order_status,
    amountXaf: order.amount_xaf,
    plan: {
      name: order.plan_name,
      days: order.plan_days,
    },
    subscription: order.subscription_status
      ? {
          status: order.subscription_status,
          startedAt: order.started_at,
          expiresAt: order.expires_at,
        }
      : null,
  });
}

async function createPendingOrder(request, db) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return badRequest("Content-Type must be application/json");
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 4096) {
    return badRequest("Request body is too large");
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON");
  }

  if (!isValidOrderInput(body)) {
    return badRequest("Order details are incomplete or invalid");
  }

  const macAddress = normalizeMacAddress(body.macAddress);
  if (!macAddress) {
    return badRequest("A valid device MAC address is required");
  }

  const phoneNumber = normalizePhoneNumber(body.phoneNumber);
  if (!phoneNumber) {
    return badRequest("Enter a valid Cameroon mobile-money number");
  }

  const plan = await db
    .prepare(
      `SELECT id, name, days, price_xaf, description
       FROM plans
       WHERE id = ? AND is_active = 1`,
    )
    .bind(body.planId)
    .first();

  if (!plan) {
    return jsonResponse({ error: "The selected plan is unavailable" }, 422);
  }

  const normalizedDeviceName = body.deviceName?.trim() || null;
  const orderId = crypto.randomUUID();
  const orderReference = `FC-${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
  const results = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO devices (id, device_name, mac_address)
         VALUES (?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), normalizedDeviceName, macAddress),
    db
      .prepare(
        `INSERT INTO orders
           (id, reference, device_id, plan_id, phone_number, payment_network,
            amount_xaf, status)
         SELECT ?, ?, id, ?, ?, ?, ?, 'pending'
         FROM devices
         WHERE mac_address = ? AND status != 'blocked'`,
      )
      .bind(
        orderId,
        orderReference,
        plan.id,
        phoneNumber,
        body.paymentNetwork,
        plan.price_xaf,
        macAddress,
      ),
  ]);

  if (results[1]?.meta?.changes !== 1) {
    return jsonResponse({ error: "This device cannot place an order" }, 403);
  }

  return jsonResponse(
    {
      order: {
        reference: orderReference,
        plan: {
          id: plan.id,
          name: plan.name,
          days: plan.days,
        },
        amountXaf: plan.price_xaf,
        status: "pending",
      },
      statusUrl: `/status.html?reference=${encodeURIComponent(orderReference)}&mac=${encodeURIComponent(macAddress)}`,
      payment: {
        status: "not_started",
        message: "Payment processing is not connected in this development build.",
      },
    },
    201,
  );
}

export default {
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      expireSubscriptions(env.DB).catch((error) => {
        console.error("Subscription expiry job failed:", error);
        throw error;
      }),
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const isHealthRoute = url.pathname === "/health";
    const isPlansRoute = url.pathname === "/api/plans";
    const isOrdersRoute = url.pathname === "/api/orders";
    const orderStatusMatch = /^\/api\/orders\/([A-Za-z0-9-]{1,120})$/.exec(url.pathname);
    const isOrderStatusRoute = orderStatusMatch !== null;
    const paymentRouteMatch =
      /^\/api\/orders\/([A-Za-z0-9-]{1,120})\/payment$/.exec(url.pathname);
    const isPaymentRoute = paymentRouteMatch !== null;
    const isFapshiWebhookRoute = url.pathname === "/api/payments/fapshi-webhook";
    const isRouterSimulatorRoute = url.pathname.startsWith("/api/router/commands");
    const isAdminApiRoute = url.pathname.startsWith("/api/admin/");
    const isCustomerApiRoute = url.pathname.startsWith("/api/account/");

    if (isFapshiWebhookRoute) {
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405, { allow: "POST" });
      }
      try {
        await checkDatabase(env.DB);
        return await handleFapshiWebhook(request, env, env.DB);
      } catch (error) {
        console.error("Fapshi webhook processing failed:", error);
        return jsonResponse({ error: "Service temporarily unavailable" }, 503);
      }
    }

    if (isCustomerApiRoute) {
      try {
        return await handleCustomerAuthRequest(request, env, env.DB, url.pathname);
      } catch (error) {
        console.error("Customer account request failed:", error);
        return jsonResponse({ error: "Service temporarily unavailable" }, 503);
      }
    }

    if (isAdminApiRoute) {
      try {
        return await handleAdminRequest(request, env, env.DB, url.pathname);
      } catch (error) {
        console.error("Admin request failed:", error);
        return jsonResponse(
          { error: "Service temporarily unavailable" },
          503,
        );
      }
    }

    if (isRouterSimulatorRoute) {
      try {
        return await handleRouterSimulatorRequest(
          request,
          env,
          env.DB,
          url.pathname,
        );
      } catch (error) {
        console.error("Router simulator request failed:", error);
        return jsonResponse(
          { error: "Service temporarily unavailable" },
          503,
        );
      }
    }

    if (
      isHealthRoute ||
      isPlansRoute ||
      isOrdersRoute ||
      isOrderStatusRoute ||
      isPaymentRoute
    ) {
      const expectedMethod = isOrdersRoute || (isPaymentRoute && request.method === "POST")
        ? "POST"
        : "GET";
      if (request.method !== expectedMethod) {
        return jsonResponse(
          { error: "Method not allowed" },
          405,
          { allow: expectedMethod },
        );
      }

      try {
        await checkDatabase(env.DB);

        if (isHealthRoute) {
          return jsonResponse({
            service: "fastconnect",
            status: "ok",
            database: "connected",
          });
        }

        if (isPlansRoute) {
          return jsonResponse({ plans: await listPlans(env.DB) });
        }

        if (isOrderStatusRoute) {
          const macAddress = normalizeMacAddress(url.searchParams.get("mac"));
          if (!macAddress) {
            return badRequest("A valid device MAC address is required");
          }

          return await getOrderStatus(
            orderStatusMatch[1],
            macAddress,
            env.DB,
          );
        }

        if (isPaymentRoute) {
          if (request.method === "POST") {
            return await startSandboxPayment(
              request,
              env,
              env.DB,
              paymentRouteMatch[1],
            );
          }
          return await checkSandboxPayment(
            request,
            env,
            env.DB,
            paymentRouteMatch[1],
          );
        }

        return await createPendingOrder(request, env.DB);
      } catch (error) {
        console.error("Cloudflare app request failed:", error);
        return jsonResponse({ error: "Service temporarily unavailable" }, 503);
      }
    }

    if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};
