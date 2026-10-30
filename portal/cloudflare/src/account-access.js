import { getCurrentCustomer } from "./customer-auth.js";

const headers = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}

export async function handleAccountAccessRequest(request, db) {
  if (request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const customer = await getCurrentCustomer(request, db);
  if (!customer) {
    return jsonResponse({ error: "Sign in to check your Wi-Fi access." }, 401);
  }

  const now = new Date().toISOString();
  const subscription = await db.prepare(
    `SELECT subscriptions.id, subscriptions.status, subscriptions.expires_at,
            plans.name AS plan_name
     FROM subscriptions
     WHERE subscriptions.customer_id = ?
       AND subscriptions.status = 'active'
       AND (subscriptions.expires_at IS NULL OR subscriptions.expires_at > ?)
     ORDER BY subscriptions.expires_at DESC
     LIMIT 1`,
  ).bind(customer.id, now).first();

  const entitlement = await db.prepare(
    `SELECT entitlement_type, expires_at
     FROM access_entitlements
     WHERE customer_id = ?
       AND status = 'active'
       AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY created_at DESC
     LIMIT 1`,
  ).bind(customer.id, now).first();

  const hasActiveAccess = Boolean(subscription || entitlement);
  return jsonResponse({
    authenticated: true,
    canReconnect: hasActiveAccess,
    access: subscription
      ? {
          type: "subscription",
          planName: subscription.plan_name,
          expiresAt: subscription.expires_at,
        }
      : entitlement
        ? {
            type: entitlement.entitlement_type,
            expiresAt: entitlement.expires_at,
          }
        : null,
    message: hasActiveAccess
      ? "Your account has active access. Reconnection does not require another purchase."
      : "No active access was found. Choose a plan to continue.",
    routerConnected: false,
  });
}
