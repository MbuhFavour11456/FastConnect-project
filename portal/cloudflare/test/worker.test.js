import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createFakeFapshi } from "./fake-fapshi.js";
import { SimulatedRouter } from "./simulated-router.js";
import { expireSubscriptions } from "../src/subscription-expiry.js";
import worker from "../src/index.js";

const simulatorToken =
  "local-test-router-token-0123456789-abcdef";
const testRouterCommandId = "00000000-0000-4000-8000-000000000001";

class LocalD1 {
  constructor(database) {
    this.database = database;
  }

  prepare(query) {
    const thisDatabase = this.database;

    return {
      query,
      parameters: [],
      bind(...values) {
        this.parameters = values;
        return this;
      },
      first() {
        return thisDatabase.prepare(query).get(...this.parameters) ?? null;
      },
      all() {
        return { results: thisDatabase.prepare(query).all(...this.parameters) };
      },
      run() {
        const result = thisDatabase.prepare(query).run(...this.parameters);
        return {
          ...result,
          meta: { changes: Number(result.changes) },
        };
      },
    };
  }

  batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) => {
        if (/^\s*SELECT/i.test(statement.query)) {
          return { results: statement.all().results, meta: { changes: 0 } };
        }

        const result = statement.run();
        return { meta: { changes: Number(result.changes) } };
      });
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

async function createTestDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const migrationName of [
    "0001_initial_schema.sql",
    "0002_admin_login_attempts.sql",
    "0003_admin_session_version.sql",
    "0004_admin_invitations.sql",
    "0005_fapshi_sandbox.sql",
    "0006_vouchers.sql",
    "0007_subscription_expiry.sql",
    "0008_customer_accounts_households.sql",
  ]) {
    const migration = await readFile(
      new URL(`../migrations/${migrationName}`, import.meta.url),
      "utf8",
    );
    database.exec(migration);
  }
  return database;
}

async function createPendingOrder(database, reference) {
  const deviceCount = database
    .prepare("SELECT COUNT(*) AS count FROM devices")
    .get().count;
  const macSuffix = String(deviceCount + 1).padStart(2, "0");
  const macAddress = `02:00:00:00:00:${macSuffix}`;

  database
    .prepare(
      `INSERT INTO devices (id, mac_address)
       VALUES (?, ?)`,
    )
    .run(`device-${reference}`, macAddress);
  database
    .prepare(
      `INSERT INTO orders
         (id, reference, device_id, plan_id, phone_number, payment_network, amount_xaf)
       VALUES (?, ?, ?, '10-day', '+237670000000', 'mtn', 2000)`,
    )
    .run(`order-${reference}`, reference, `device-${reference}`);
}

async function createActiveTestSubscription(database, reference) {
  await createPendingOrder(database, reference);
  database
    .prepare(
      `UPDATE orders SET status = 'paid' WHERE reference = ?`,
    )
    .run(reference);
  database
    .prepare(
      `INSERT INTO payments
         (id, order_id, provider_transaction_id, amount_xaf, status, confirmed_at)
       VALUES (?, ?, ?, 2000, 'successful', '2026-10-02T12:00:00.000Z')`,
    )
    .run(`payment-${reference}`, `order-${reference}`, `fake-${reference}`);
  database
    .prepare(
      `INSERT INTO subscriptions
         (id, order_id, device_id, plan_id, status, started_at, expires_at)
       VALUES (?, ?, ?, '10-day', 'active',
               '2026-10-02T12:00:00.000Z', '2026-10-12T12:00:00.000Z')`,
    )
    .run(`subscription-${reference}`, `order-${reference}`, `device-${reference}`);
  database
    .prepare(
      `INSERT INTO router_commands (id, subscription_id, action, status)
       VALUES (?, ?, 'grant', 'pending')`,
    )
    .run(testRouterCommandId, `subscription-${reference}`);
}

function routerRequest(pathname, { method = "GET", body, token = simulatorToken } = {}) {
  const headers = {};
  if (token !== null) {
    headers.authorization = `Bearer ${token}`;
  }
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }

  return new Request(`https://app.test${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("health reports success only when the D1 database is available", async () => {
  const database = await createTestDatabase();

  try {
    const response = await worker.fetch(
      new Request("https://app.test/health"),
      { DB: new LocalD1(database) },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      service: "fastconnect",
      status: "ok",
      database: "connected",
    });
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    database.close();
  }
});

test("plans endpoint returns active fixed plans from the D1 schema", async () => {
  const database = await createTestDatabase();

  try {
    const response = await worker.fetch(
      new Request("https://app.test/api/plans"),
      { DB: new LocalD1(database) },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      plans: [
        {
          id: "10-day",
          name: "10-Day Plan",
          days: 10,
          priceXaf: 2000,
          description: "10 consecutive days of Wi-Fi access",
        },
        {
          id: "30-day",
          name: "30-Day Plan",
          days: 30,
          priceXaf: 5000,
          description: "30 consecutive days of Wi-Fi access",
        },
      ],
    });
  } finally {
    database.close();
  }
});

test("admin setup is one-time and creates a salted password hash", async () => {
  const database = await createTestDatabase();
  const request = new Request("https://app.test/api/admin/setup", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.test",
    },
    body: JSON.stringify({
      setupToken: "test-admin-setup-token-that-is-long-enough-123",
      username: "Owner",
      fullName: "FastConnect Owner",
      password: "a-long-test-password-2026",
    }),
  });
  const env = {
    DB: new LocalD1(database),
    ADMIN_SETUP_TOKEN: "test-admin-setup-token-that-is-long-enough-123",
    ADMIN_SESSION_SECRET: "test-admin-session-secret-that-is-long-enough-123",
  };

  try {
    const response = await worker.fetch(request, env);
    const storedAdmin = database
      .prepare("SELECT username, full_name, password_hash FROM admins")
      .get();
    const repeated = await worker.fetch(
      new Request("https://app.test/api/admin/setup", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://app.test",
        },
        body: JSON.stringify({
          setupToken: "test-admin-setup-token-that-is-long-enough-123",
          username: "Owner",
          fullName: "FastConnect Owner",
          password: "a-long-test-password-2026",
        }),
      }),
      env,
    );

    assert.equal(response.status, 201);
    assert.equal(storedAdmin.username, "owner");
    assert.equal(storedAdmin.full_name, "FastConnect Owner");
    assert.match(storedAdmin.password_hash, /^pbkdf2-sha256\$100000\$/);
    assert.notEqual(storedAdmin.password_hash, "a-long-test-password-2026");
    assert.equal(repeated.status, 409);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM admins").get().count, 1);
  } finally {
    database.close();
  }
});

test("admin sign-in protects overview data and logout clears the session", async () => {
  const database = await createTestDatabase();
  const env = {
    DB: new LocalD1(database),
    ADMIN_SETUP_TOKEN: "test-admin-setup-token-that-is-long-enough-123",
    ADMIN_SESSION_SECRET: "test-admin-session-secret-that-is-long-enough-123",
  };
  const setup = await worker.fetch(
    new Request("https://app.test/api/admin/setup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://app.test",
      },
      body: JSON.stringify({
        setupToken: env.ADMIN_SETUP_TOKEN,
        username: "owner",
        fullName: "FastConnect Owner",
        password: "a-long-test-password-2026",
      }),
    }),
    env,
  );

  try {
    assert.equal(setup.status, 201);
    const rejectedSetup = await worker.fetch(
      new Request("https://app.test/api/admin/setup", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.test",
        },
        body: JSON.stringify({
          setupToken: env.ADMIN_SETUP_TOKEN,
          username: "other",
          fullName: "Other User",
          password: "another-long-test-password",
        }),
      }),
      env,
    );
    assert.equal(rejectedSetup.status, 403);

    const failedLogins = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      failedLogins.push(
        await worker.fetch(
          new Request("https://app.test/api/admin/login", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "https://app.test",
              "cf-connecting-ip": "203.0.113.11",
            },
            body: JSON.stringify({
              username: "unknown",
              password: "incorrect-password",
            }),
          }),
          env,
        ),
      );
    }
    const unauthorized = await worker.fetch(
      new Request("https://app.test/api/admin/overview"),
      env,
    );
    await createPendingOrder(database, "FC-ADMIN-ORDER");
    database
      .prepare("UPDATE orders SET status = 'paid' WHERE reference = ?")
      .run("FC-ADMIN-ORDER");
    database
      .prepare(
        `INSERT INTO payments
           (id, order_id, provider_transaction_id, amount_xaf, status, confirmed_at)
         VALUES (?, ?, ?, 2000, 'successful', ?)`,
      )
      .run(
        "payment-FC-ADMIN-ORDER",
        "order-FC-ADMIN-ORDER",
        "transaction-FC-ADMIN-ORDER",
        new Date().toISOString(),
      );
    database
      .prepare(
        `INSERT INTO subscriptions
           (id, order_id, device_id, plan_id, status, started_at, expires_at)
         VALUES (?, ?, ?, '10-day', 'active', ?, ?)`,
      )
      .run(
        "subscription-FC-ADMIN-ORDER",
        "order-FC-ADMIN-ORDER",
        "device-FC-ADMIN-ORDER",
        new Date().toISOString(),
        new Date(Date.now() + 10 * 86400000).toISOString(),
      );
    await createPendingOrder(database, "FC-ADMIN-PENDING");
    database
      .prepare(
        `INSERT INTO payments (id, order_id, amount_xaf, status)
         VALUES (?, ?, 2000, 'pending')`,
      )
      .run("payment-FC-ADMIN-PENDING", "order-FC-ADMIN-PENDING");
    const login = await worker.fetch(
      new Request("https://app.test/api/admin/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://app.test",
          "cf-connecting-ip": "203.0.113.10",
        },
        body: JSON.stringify({
          username: "owner",
          password: "a-long-test-password-2026",
        }),
      }),
      env,
    );
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const overview = await worker.fetch(
      new Request("https://app.test/api/admin/overview", {
        headers: { cookie },
      }),
      env,
    );
    const dashboard = await overview.json();
    const ordersResponse = await worker.fetch(
      new Request("https://app.test/api/admin/orders", {
        headers: { cookie },
      }),
      env,
    );
    const ordersPayload = await ordersResponse.json();
    const publicOrdersResponse = await worker.fetch(
      new Request("https://app.test/api/admin/orders"),
      env,
    );
    const deviceListResponse = await worker.fetch(
      new Request("https://app.test/api/admin/devices", {
        headers: { cookie },
      }),
      env,
    );
    const subscriptionListResponse = await worker.fetch(
      new Request("https://app.test/api/admin/subscriptions", {
        headers: { cookie },
      }),
      env,
    );
    const paymentListResponse = await worker.fetch(
      new Request("https://app.test/api/admin/payments", {
        headers: { cookie },
      }),
      env,
    );
    const auditListResponse = await worker.fetch(
      new Request("https://app.test/api/admin/audit", {
        headers: { cookie },
      }),
      env,
    );
    const unauthorizedDeviceList = await worker.fetch(
      new Request("https://app.test/api/admin/devices"),
      env,
    );
    const deviceList = await deviceListResponse.json();
    const subscriptionList = await subscriptionListResponse.json();
    const paymentList = await paymentListResponse.json();
    const auditList = await auditListResponse.json();
    const logout = await worker.fetch(
      new Request("https://app.test/api/admin/logout", {
        method: "POST",
        headers: { origin: "https://app.test", cookie },
      }),
      env,
    );
    const afterLogout = await worker.fetch(
      new Request("https://app.test/api/admin/overview", {
        headers: { cookie },
      }),
      env,
    );

    assert.equal(unauthorized.status, 401);
    assert.equal(failedLogins[0].status, 401);
    assert.equal(failedLogins[4].status, 401);
    assert.equal(failedLogins[5].status, 429);
    assert.ok(Number(failedLogins[5].headers.get("retry-after")) > 0);
    assert.equal(login.status, 200);
    assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict; Max-Age=28800; Secure/);
    assert.equal(overview.status, 200);
    assert.deepEqual(dashboard, {
      orders: { total: 2, pending: 1 },
      devices: { total: 2, pending: 2 },
      activeSubscriptions: 1,
      pendingPayments: 1,
      revenueTodayXaf: 2000,
      confirmedPaymentsToday: 1,
    });
    assert.equal(ordersResponse.status, 200);
    assert.equal(ordersPayload.orders.length, 2);
    assert.equal(deviceListResponse.status, 200);
    assert.equal(deviceList.devices.length, 2);
    assert.ok(deviceList.devices.every((device) => /^[0-9A-F:]{17}$/.test(device.macAddress)));
    assert.equal(subscriptionListResponse.status, 200);
    assert.equal(subscriptionList.subscriptions.length, 1);
    assert.equal(paymentListResponse.status, 200);
    assert.equal(paymentList.payments.length, 2);
    assert.ok(paymentList.payments.every((payment) => !("phoneNumber" in payment)));
    assert.ok(paymentList.payments.every((payment) => payment.phoneSuffix === "00"));
    assert.equal(auditListResponse.status, 200);
    assert.ok(auditList.entries.length > 0);
    assert.ok(
      auditList.entries.some(
        (entry) => entry.actorType === "owner" && entry.actor === "owner",
      ),
    );
    assert.ok(
      auditList.entries.every((entry) => ["owner", "system"].includes(entry.actorType)),
    );
    assert.equal(unauthorizedDeviceList.status, 401);
    const recentPaidOrder = ordersPayload.orders.find(
      (order) => order.reference === "FC-ADMIN-ORDER",
    );
    assert.deepEqual(recentPaidOrder, {
      reference: "FC-ADMIN-ORDER",
      status: "paid",
      amountXaf: 2000,
      createdAt: recentPaidOrder.createdAt,
      plan: { name: "10-Day Plan", days: 10 },
    });
    assert.equal("phoneNumber" in recentPaidOrder, false);
    assert.equal("macAddress" in recentPaidOrder, false);
    assert.equal(publicOrdersResponse.status, 401);
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal(afterLogout.status, 401);
  } finally {
    database.close();
  }
});

test("owner password changes require the current password and revoke existing sessions", async () => {
  const database = await createTestDatabase();
  const env = {
    DB: new LocalD1(database),
    ADMIN_SETUP_TOKEN: "test-admin-setup-token-that-is-long-enough-123",
    ADMIN_SESSION_SECRET: "test-admin-session-secret-that-is-long-enough-123",
  };
  const origin = "https://app.test";
  const password = "a-long-test-password-2026";
  const newPassword = "a-different-test-password-2026";

  try {
    await worker.fetch(
      new Request(`${origin}/api/admin/setup`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          setupToken: env.ADMIN_SETUP_TOKEN,
          username: "owner",
          fullName: "FastConnect Owner",
          password,
        }),
      }),
      env,
    );
    const login = await worker.fetch(
      new Request(`${origin}/api/admin/login`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "cf-connecting-ip": "203.0.113.40",
        },
        body: JSON.stringify({ username: "owner", password }),
      }),
      env,
    );
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const incorrectCurrentPassword = await worker.fetch(
      new Request(`${origin}/api/admin/password`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie },
        body: JSON.stringify({
          currentPassword: "incorrect-current-password",
          newPassword,
        }),
      }),
      env,
    );
    const shortNewPassword = await worker.fetch(
      new Request(`${origin}/api/admin/password`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie },
        body: JSON.stringify({
          currentPassword: password,
          newPassword: "too-short",
        }),
      }),
      env,
    );
    const rejectedOrigin = await worker.fetch(
      new Request(`${origin}/api/admin/password`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.test",
          cookie,
        },
        body: JSON.stringify({ currentPassword: password, newPassword }),
      }),
      env,
    );
    const changed = await worker.fetch(
      new Request(`${origin}/api/admin/password`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie },
        body: JSON.stringify({ currentPassword: password, newPassword }),
      }),
      env,
    );
    const staleSession = await worker.fetch(
      new Request(`${origin}/api/admin/session`, { headers: { cookie } }),
      env,
    );
    const oldPasswordLogin = await worker.fetch(
      new Request(`${origin}/api/admin/login`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "cf-connecting-ip": "203.0.113.41",
        },
        body: JSON.stringify({ username: "owner", password }),
      }),
      env,
    );
    const newPasswordLogin = await worker.fetch(
      new Request(`${origin}/api/admin/login`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "cf-connecting-ip": "203.0.113.42",
        },
        body: JSON.stringify({ username: "owner", password: newPassword }),
      }),
      env,
    );
    const passwordAudit = database
      .prepare("SELECT action FROM audit_logs WHERE action = 'admin_password_changed'")
      .get();

    assert.equal(login.status, 200);
    assert.equal(incorrectCurrentPassword.status, 401);
    assert.equal(shortNewPassword.status, 400);
    assert.equal(rejectedOrigin.status, 403);
    assert.equal(changed.status, 200);
    assert.deepEqual(await changed.json(), { changed: true, signInRequired: true });
    assert.match(changed.headers.get("set-cookie"), /Max-Age=0/);
    assert.deepEqual(await staleSession.json(), { authenticated: false });
    assert.equal(oldPasswordLogin.status, 401);
    assert.equal(newPasswordLogin.status, 200);
    assert.equal(passwordAudit.action, "admin_password_changed");
  } finally {
    database.close();
  }
});

test("owner plan management validates changes and preserves existing orders", async () => {
  const database = await createTestDatabase();
  const env = {
    DB: new LocalD1(database),
    ADMIN_SETUP_TOKEN: "test-admin-setup-token-that-is-long-enough-123",
    ADMIN_SESSION_SECRET: "test-admin-session-secret-that-is-long-enough-123",
  };
  const origin = "https://app.test";

  try {
    await worker.fetch(
      new Request(`${origin}/api/admin/setup`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          setupToken: env.ADMIN_SETUP_TOKEN,
          username: "owner",
          fullName: "FastConnect Owner",
          password: "a-long-test-password-2026",
        }),
      }),
      env,
    );
    const login = await worker.fetch(
      new Request(`${origin}/api/admin/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          username: "owner",
          password: "a-long-test-password-2026",
        }),
      }),
      env,
    );
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const unauthenticated = await worker.fetch(
      new Request(`${origin}/api/admin/plans`),
      env,
    );
    const initial = await worker.fetch(
      new Request(`${origin}/api/admin/plans`, { headers: { cookie } }),
      env,
    );
    const wrongOrigin = await worker.fetch(
      new Request(`${origin}/api/admin/plans`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.test",
          cookie,
        },
        body: JSON.stringify({}),
      }),
      env,
    );
    const invalidPlan = await worker.fetch(
      new Request(`${origin}/api/admin/plans`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie },
        body: JSON.stringify({
          id: "7-day",
          name: "7-Day Plan",
          days: 0,
          priceXaf: 1000,
          description: "Seven days",
          isActive: true,
        }),
      }),
      env,
    );
    const newPlanBody = {
      id: "7-day",
      name: "7-Day Plan",
      days: 7,
      priceXaf: 1200,
      description: "7 consecutive days of Wi-Fi access",
      isActive: true,
    };
    const created = await worker.fetch(
      new Request(`${origin}/api/admin/plans`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie },
        body: JSON.stringify(newPlanBody),
      }),
      env,
    );
    const duplicate = await worker.fetch(
      new Request(`${origin}/api/admin/plans`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie },
        body: JSON.stringify(newPlanBody),
      }),
      env,
    );
    const methodNotAllowed = await worker.fetch(
      new Request(`${origin}/api/admin/plans/7-day`, {
        method: "DELETE",
        headers: { origin, cookie },
      }),
      env,
    );
    await createPendingOrder(database, "FC-PLAN-PRICE-SNAPSHOT");
    const changedExistingTerms = await worker.fetch(
      new Request(`${origin}/api/admin/plans/10-day`, {
        method: "PUT",
        headers: { "content-type": "application/json", origin, cookie },
        body: JSON.stringify({
          name: "Changed 10-Day Plan",
          days: 11,
          priceXaf: 2500,
          description: "Updated plan description",
          isActive: true,
        }),
      }),
      env,
    );
    const updated = await worker.fetch(
      new Request(`${origin}/api/admin/plans/10-day`, {
        method: "PUT",
        headers: { "content-type": "application/json", origin, cookie },
        body: JSON.stringify({
          name: "10-Day Plan",
          days: 10,
          priceXaf: 2500,
          description: "Updated plan description",
          isActive: false,
        }),
      }),
      env,
    );
    const publicPlansResponse = await worker.fetch(
      new Request(`${origin}/api/plans`),
      env,
    );
    const publicPlans = await publicPlansResponse.json();
    const order = database
      .prepare("SELECT amount_xaf, plan_id FROM orders WHERE reference = ?")
      .get("FC-PLAN-PRICE-SNAPSHOT");
    const auditCount = database
      .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action LIKE 'plan_%'")
      .get().count;

    assert.equal(login.status, 200);
    assert.equal(unauthenticated.status, 401);
    assert.equal(initial.status, 200);
    assert.equal((await initial.json()).plans.length, 2);
    assert.equal(wrongOrigin.status, 403);
    assert.equal(invalidPlan.status, 400);
    assert.equal(created.status, 201);
    assert.equal(duplicate.status, 409);
    assert.equal(methodNotAllowed.status, 405);
    assert.equal(changedExistingTerms.status, 409);
    assert.equal(updated.status, 200);
    assert.equal(order.amount_xaf, 2000);
    assert.equal(order.plan_id, "10-day");
    assert.deepEqual(publicPlans.plans.map((plan) => plan.id), ["7-day", "30-day"]);
    assert.equal(auditCount, 2);
  } finally {
    database.close();
  }
});

test("owner can create, list, and cancel cash vouchers without exposing stored codes", async () => {
  const database = await createTestDatabase();
  const env = {
    DB: new LocalD1(database),
    ADMIN_SETUP_TOKEN: "test-admin-setup-token-that-is-long-enough-123",
    ADMIN_SESSION_SECRET: "test-admin-session-secret-that-is-long-enough-123",
  };
  const origin = "https://app.test";

  try {
    await worker.fetch(
      new Request(`${origin}/api/admin/setup`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          setupToken: env.ADMIN_SETUP_TOKEN,
          username: "owner",
          fullName: "FastConnect Owner",
          password: "a-long-test-password-2026",
        }),
      }),
      env,
    );
    const login = await worker.fetch(
      new Request(`${origin}/api/admin/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          username: "owner",
          password: "a-long-test-password-2026",
        }),
      }),
      env,
    );
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const unauthenticated = await worker.fetch(
      new Request(`${origin}/api/admin/vouchers`),
      env,
    );
    const wrongOrigin = await worker.fetch(
      new Request(`${origin}/api/admin/vouchers`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.test",
          cookie,
        },
        body: JSON.stringify({ planId: "30-day" }),
      }),
      env,
    );
    const invalidPlan = await worker.fetch(
      new Request(`${origin}/api/admin/vouchers`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie },
        body: JSON.stringify({ planId: "missing-plan" }),
      }),
      env,
    );
    const created = await worker.fetch(
      new Request(`${origin}/api/admin/vouchers`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie },
        body: JSON.stringify({ planId: "30-day", note: "Room 4" }),
      }),
      env,
    );
    const creation = await created.json();
    const hashRow = database
      .prepare("SELECT code_hash, plan_days, amount_xaf, note, status FROM vouchers")
      .get();
    const listed = await worker.fetch(
      new Request(`${origin}/api/admin/vouchers`, { headers: { cookie } }),
      env,
    );
    const listing = await listed.json();
    const changedVoucherPlanTerms = await worker.fetch(
      new Request(`${origin}/api/admin/plans/30-day`, {
        method: "PUT",
        headers: { "content-type": "application/json", origin, cookie },
        body: JSON.stringify({
          name: "Updated 30-Day Plan",
          days: 31,
          priceXaf: 5500,
          description: "Updated plan",
          isActive: true,
        }),
      }),
      env,
    );
    const cancelled = await worker.fetch(
      new Request(`${origin}/api/admin/vouchers/${creation.voucher.id}/cancel`, {
        method: "POST",
        headers: { origin, cookie },
      }),
      env,
    );
    const cancelledAgain = await worker.fetch(
      new Request(`${origin}/api/admin/vouchers/${creation.voucher.id}/cancel`, {
        method: "POST",
        headers: { origin, cookie },
      }),
      env,
    );
    const audit = database
      .prepare(
        `SELECT action, details FROM audit_logs
         WHERE action IN ('voucher_created', 'voucher_cancelled')
         ORDER BY action`,
      )
      .all();

    assert.equal(unauthenticated.status, 401);
    assert.equal(wrongOrigin.status, 403);
    assert.equal(invalidPlan.status, 422);
    assert.equal(created.status, 201);
    assert.match(creation.voucher.code, /^FC-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
    assert.equal(creation.redemptionEnabled, false);
    assert.equal(hashRow.code_hash.includes(creation.voucher.code), false);
    assert.equal(hashRow.plan_days, 30);
    assert.equal(hashRow.amount_xaf, 5000);
    assert.equal(hashRow.note, "Room 4");
    assert.equal(hashRow.status, "unused");
    assert.equal(listed.status, 200);
    assert.equal(Object.hasOwn(listing.vouchers[0], "code"), false);
    assert.equal(listing.vouchers[0].note, "Room 4");
    assert.equal(changedVoucherPlanTerms.status, 409);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelledAgain.status, 409);
    assert.equal(database.prepare("SELECT status FROM vouchers").get().status, "cancelled");
    assert.equal(audit.length, 2);
    assert.ok(audit.every((entry) => !entry.details.includes(creation.voucher.code)));
  } finally {
    database.close();
  }
});

test("admin invitations are disabled because the family shares one owner account", async () => {
  const database = await createTestDatabase();
  const env = {
    DB: new LocalD1(database),
    ADMIN_SETUP_TOKEN: "test-admin-setup-token-that-is-long-enough-123",
    ADMIN_SESSION_SECRET: "test-admin-session-secret-that-is-long-enough-123",
  };
  try {
    const requests = [
      new Request("https://app.test/api/admin/accounts"),
      new Request("https://app.test/api/admin/invitations", {
        method: "POST",
      }),
      new Request("https://app.test/api/admin/accept-invitation", {
        method: "POST",
      }),
    ];
    for (const request of requests) {
      const response = await worker.fetch(request, env);
      assert.equal(response.status, 404);
    }
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM admins").get().count, 0);
  } finally {
    database.close();
  }
});

test("order creation uses the database price and starts no payment", async () => {
  const database = await createTestDatabase();
  const request = new Request("https://app.test/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      planId: "10-day",
      macAddress: "02-00-00-00-00-01",
      phoneNumber: "670 000 000",
      paymentNetwork: "mtn",
      deviceName: "Test phone",
      amountXaf: 1,
    }),
  });

  try {
    const response = await worker.fetch(request, { DB: new LocalD1(database) });
    const payload = await response.json();
    const storedOrder = database
      .prepare("SELECT amount_xaf, phone_number, payment_network, status FROM orders")
      .get();
    const storedDevice = database
      .prepare("SELECT mac_address, device_name FROM devices")
      .get();

    assert.equal(response.status, 201);
    assert.equal(payload.order.amountXaf, 2000);
    assert.equal(payload.order.status, "pending");
    assert.equal(payload.payment.status, "not_started");
    assert.equal(storedOrder.amount_xaf, 2000);
    assert.equal(storedOrder.phone_number, "+237670000000");
    assert.equal(storedOrder.payment_network, "mtn");
    assert.equal(storedOrder.status, "pending");
    assert.equal(storedDevice.mac_address, "02:00:00:00:00:01");
    assert.equal(storedDevice.device_name, "Test phone");
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM payments").get().count,
      0,
    );
  } finally {
    database.close();
  }
});

test("order status is limited to the matching device and omits private payment details", async () => {
  const database = await createTestDatabase();
  const createResponse = await worker.fetch(
    new Request("https://app.test/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        planId: "10-day",
        macAddress: "02:00:00:00:00:01",
        phoneNumber: "670000000",
        paymentNetwork: "mtn",
      }),
    }),
    { DB: new LocalD1(database) },
  );
  const created = await createResponse.json();
  const reference = created.order.reference;

  try {
    const statusResponse = await worker.fetch(
      new Request(
        `https://app.test/api/orders/${encodeURIComponent(reference)}?mac=02%3A00%3A00%3A00%3A00%3A01`,
      ),
      { DB: new LocalD1(database) },
    );
    const payload = await statusResponse.json();
    const wrongDeviceResponse = await worker.fetch(
      new Request(
        `https://app.test/api/orders/${encodeURIComponent(reference)}?mac=02%3A00%3A00%3A00%3A00%3A02`,
      ),
      { DB: new LocalD1(database) },
    );

    assert.equal(statusResponse.status, 200);
    assert.equal(payload.orderStatus, "pending");
    assert.equal(payload.amountXaf, 2000);
    assert.equal(payload.plan.name, "10-Day Plan");
    assert.equal(payload.subscription, null);
    assert.equal("phoneNumber" in payload, false);
    assert.equal("paymentMethod" in payload, false);
    assert.equal(wrongDeviceResponse.status, 404);
    assert.match(created.statusUrl, /^\/status\.html\?reference=/);
  } finally {
    database.close();
  }
});

test("order creation rejects invalid input and unknown plans", async () => {
  const database = await createTestDatabase();

  try {
    const invalidMac = await worker.fetch(
      new Request("https://app.test/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          planId: "10-day",
          macAddress: "not-a-mac",
          phoneNumber: "670000000",
          paymentNetwork: "mtn",
        }),
      }),
      { DB: new LocalD1(database) },
    );
    const unknownPlan = await worker.fetch(
      new Request("https://app.test/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          planId: "free-plan",
          macAddress: "02:00:00:00:00:01",
          phoneNumber: "670000000",
          paymentNetwork: "mtn",
        }),
      }),
      { DB: new LocalD1(database) },
    );

    assert.equal(invalidMac.status, 400);
    assert.equal(unknownPlan.status, 422);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM orders").get().count,
      0,
    );
  } finally {
    database.close();
  }
});

test("blocked devices cannot create orders", async () => {
  const database = await createTestDatabase();
  database
    .prepare(
      `INSERT INTO devices (id, mac_address, status)
       VALUES (?, ?, 'blocked')`,
    )
    .run("blocked-device", "02:00:00:00:00:01");

  try {
    const response = await worker.fetch(
      new Request("https://app.test/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          planId: "10-day",
          macAddress: "02:00:00:00:00:01",
          phoneNumber: "670000000",
          paymentNetwork: "orange",
        }),
      }),
      { DB: new LocalD1(database) },
    );

    assert.equal(response.status, 403);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM orders").get().count,
      0,
    );
  } finally {
    database.close();
  }
});

test("fake successful payment creates one subscription and queues router access", async () => {
  const database = await createTestDatabase();
  await createPendingOrder(database, "FC-SUCCESS");
  const fakeFapshi = createFakeFapshi({
    db: new LocalD1(database),
    clock: () => new Date("2026-10-02T12:00:00.000Z"),
  });

  try {
    const result = await fakeFapshi.settleOrder({
      orderReference: "FC-SUCCESS",
      outcome: "successful",
      providerTransactionId: "FAKE-TRANSACTION-SUCCESS",
    });
    const order = database
      .prepare("SELECT status FROM orders WHERE reference = ?")
      .get("FC-SUCCESS");
    const payment = database
      .prepare("SELECT status, amount_xaf FROM payments WHERE order_id = ?")
      .get("order-FC-SUCCESS");
    const subscription = database
      .prepare(
        `SELECT status, started_at, expires_at
         FROM subscriptions WHERE order_id = ?`,
      )
      .get("order-FC-SUCCESS");
    const command = database
      .prepare(
        `SELECT action, status
         FROM router_commands
         WHERE subscription_id = (
           SELECT id FROM subscriptions WHERE order_id = ?
         )`,
      )
      .get("order-FC-SUCCESS");

    assert.equal(result.processing.outcome, "provisioning_queued");
    assert.equal(order.status, "paid");
    assert.equal(payment.status, "successful");
    assert.equal(payment.amount_xaf, 2000);
    assert.equal(subscription.status, "active");
    assert.equal(subscription.started_at, "2026-10-02T12:00:00.000Z");
    assert.equal(subscription.expires_at, "2026-10-12T12:00:00.000Z");
    assert.equal(command.action, "grant");
    assert.equal(command.status, "pending");
  } finally {
    database.close();
  }
});

test("fake failed and pending payment outcomes never provision access", async () => {
  const database = await createTestDatabase();
  await createPendingOrder(database, "FC-FAILED");
  await createPendingOrder(database, "FC-PENDING");
  const fakeFapshi = createFakeFapshi({
    db: new LocalD1(database),
    clock: () => new Date("2026-10-02T12:00:00.000Z"),
  });

  try {
    const failed = await fakeFapshi.settleOrder({
      orderReference: "FC-FAILED",
      outcome: "failed",
      providerTransactionId: "FAKE-TRANSACTION-FAILED",
    });
    const pending = await fakeFapshi.settleOrder({
      orderReference: "FC-PENDING",
      outcome: "pending",
      providerTransactionId: "FAKE-TRANSACTION-PENDING",
    });

    assert.equal(failed.processing.paymentStatus, "failed");
    assert.equal(pending.processing.paymentStatus, "pending");
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM subscriptions")
        .get().count,
      0,
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM router_commands")
        .get().count,
      0,
    );
  } finally {
    database.close();
  }
});

test("fake successful payment with a wrong amount is recorded but grants no access", async () => {
  const database = await createTestDatabase();
  await createPendingOrder(database, "FC-WRONG-AMOUNT");
  const fakeFapshi = createFakeFapshi({
    db: new LocalD1(database),
    clock: () => new Date("2026-10-02T12:00:00.000Z"),
  });

  try {
    const result = await fakeFapshi.settleOrder({
      orderReference: "FC-WRONG-AMOUNT",
      outcome: "successful",
      amountXaf: 1000,
      providerTransactionId: "FAKE-TRANSACTION-WRONG-AMOUNT",
    });

    assert.equal(result.processing.outcome, "amount_mismatch");
    assert.equal(result.processing.expectedAmountXaf, 2000);
    assert.equal(result.processing.receivedAmountXaf, 1000);
    assert.equal(
      database
        .prepare("SELECT status FROM orders WHERE reference = ?")
        .get("FC-WRONG-AMOUNT").status,
      "pending",
    );
    assert.equal(
      database
        .prepare("SELECT status FROM payments WHERE order_id = ?")
        .get("order-FC-WRONG-AMOUNT").status,
      "amount_mismatch",
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM subscriptions")
        .get().count,
      0,
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM router_commands")
        .get().count,
      0,
    );
  } finally {
    database.close();
  }
});

test("replayed successful payment does not create duplicate access commands", async () => {
  const database = await createTestDatabase();
  await createPendingOrder(database, "FC-REPLAY");
  const fakeFapshi = createFakeFapshi({
    db: new LocalD1(database),
    clock: () => new Date("2026-10-02T12:00:00.000Z"),
  });
  const event = {
    orderReference: "FC-REPLAY",
    outcome: "successful",
    providerTransactionId: "FAKE-TRANSACTION-REPLAY",
  };

  try {
    const firstDelivery = await fakeFapshi.settleOrder(event);
    const replay = await fakeFapshi.settleOrder(event);

    assert.equal(firstDelivery.processing.outcome, "provisioning_queued");
    assert.equal(replay.processing.outcome, "duplicate");
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM payments")
        .get().count,
      1,
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM subscriptions")
        .get().count,
      1,
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM router_commands")
        .get().count,
      1,
    );
  } finally {
    database.close();
  }
});

test("scheduled expiry marks due subscriptions and queues one router revocation", async () => {
  const database = await createTestDatabase();
  await createActiveTestSubscription(database, "FC-SUBSCRIPTION-EXPIRED");
  database
    .prepare(
      "UPDATE router_commands SET id = ? WHERE subscription_id = ? AND action = 'grant'",
    )
    .run("00000000-0000-4000-8000-000000000002", "subscription-FC-SUBSCRIPTION-EXPIRED");
  await createActiveTestSubscription(database, "FC-SUBSCRIPTION-CURRENT");
  database
    .prepare("UPDATE subscriptions SET expires_at = ? WHERE order_id = ?")
    .run(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), "order-FC-SUBSCRIPTION-CURRENT");
  database
    .prepare(
      "UPDATE subscriptions SET expires_at = ? WHERE order_id = ?",
    )
    .run("2026-10-02T00:00:00.000Z", "order-FC-SUBSCRIPTION-EXPIRED");
  const beforeExpiryRun = Date.now();
  const tasks = [];
  const context = { waitUntil(promise) { tasks.push(promise); } };

  try {
    worker.scheduled(
      { scheduledTime: Date.parse("2026-10-03T00:00:00.000Z"), cron: "0 * * * *" },
      { DB: new LocalD1(database) },
      context,
    );
    assert.equal(tasks.length, 1);
    await Promise.all(tasks);

    const expired = database
      .prepare("SELECT status, expired_at FROM subscriptions WHERE order_id = ?")
      .get("order-FC-SUBSCRIPTION-EXPIRED");
    const current = database
      .prepare("SELECT status FROM subscriptions WHERE order_id = ?")
      .get("order-FC-SUBSCRIPTION-CURRENT");
    const commands = database
      .prepare(
        `SELECT action, status, last_error
         FROM router_commands
         WHERE subscription_id = (
           SELECT id FROM subscriptions WHERE order_id = ?
         )
         ORDER BY action`,
      )
      .all("order-FC-SUBSCRIPTION-EXPIRED");
    const auditCount = database
      .prepare(
        "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'subscription_expired'",
      )
      .get().count;

    assert.equal(expired.status, "expired");
    assert.ok(Date.parse(expired.expired_at) >= beforeExpiryRun);
    assert.ok(Date.parse(expired.expired_at) <= Date.now());
    assert.equal(current.status, "active");
    assert.equal(commands.length, 2);
    assert.deepEqual({ ...commands[0] }, {
      action: "grant",
      status: "failed",
      last_error: "subscription_expired_before_grant",
    });
    assert.deepEqual({ ...commands[1] }, {
      action: "revoke",
      status: "pending",
      last_error: null,
    });
    assert.match(
      database
        .prepare(
          "SELECT id FROM router_commands WHERE subscription_id = (SELECT id FROM subscriptions WHERE order_id = ?) AND action = 'revoke'",
        )
        .get("order-FC-SUBSCRIPTION-EXPIRED").id,
      /^[0-9a-f-]{36}$/,
    );
    assert.equal(auditCount, 1);

    const repeated = await expireSubscriptions(
      new LocalD1(database),
      new Date(expired.expired_at),
    );
    assert.deepEqual(repeated, { expiredCount: 0, revocationsQueued: 0 });
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM router_commands WHERE subscription_id = (SELECT id FROM subscriptions WHERE order_id = ?) AND action = 'revoke'",
        )
        .get("order-FC-SUBSCRIPTION-EXPIRED").count,
      1,
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'subscription_expired'",
        )
        .get().count,
      1,
    );
  } finally {
    database.close();
  }
});

test("simulator queue is hidden unless explicitly enabled", async () => {
  const database = await createTestDatabase();

  try {
    const response = await worker.fetch(
      routerRequest("/api/router/commands"),
      { DB: new LocalD1(database) },
    );

    assert.equal(response.status, 404);
  } finally {
    database.close();
  }
});

test("simulator queue rejects requests without the configured bearer token", async () => {
  const database = await createTestDatabase();
  const environment = {
    DB: new LocalD1(database),
    ROUTER_SIMULATOR_ENABLED: "true",
    ROUTER_SIMULATOR_TOKEN: simulatorToken,
  };

  try {
    const missingToken = await worker.fetch(
      routerRequest("/api/router/commands", { token: null }),
      environment,
    );
    const wrongToken = await worker.fetch(
      routerRequest("/api/router/commands", { token: "wrong-token" }),
      environment,
    );

    assert.equal(missingToken.status, 401);
    assert.equal(wrongToken.status, 401);
  } finally {
    database.close();
  }
});

test("simulator claims only one bounded command and marks it applied", async () => {
  const database = await createTestDatabase();
  await createActiveTestSubscription(database, "FC-QUEUE");
  const environment = {
    DB: new LocalD1(database),
    ROUTER_SIMULATOR_ENABLED: "true",
    ROUTER_SIMULATOR_TOKEN: simulatorToken,
  };

  try {
    const claim = await worker.fetch(
      routerRequest("/api/router/commands"),
      environment,
    );
    const payload = await claim.json();
    assert.equal(claim.status, 200);
    assert.equal(payload.mode, "simulation-only");
    assert.equal(payload.command.id, testRouterCommandId);
    assert.equal(payload.command.action, "grant");
    assert.equal(payload.command.macAddress, "02:00:00:00:00:01");
    assert.equal(payload.command.profile, "plan-10-days");
    assert.equal(payload.command.expiresAt, "2026-10-12T12:00:00.000Z");
    assert.equal(payload.command.attempts, 1);

    const secondClaim = await worker.fetch(
      routerRequest("/api/router/commands"),
      environment,
    );
    assert.equal(secondClaim.status, 204);

    const result = await worker.fetch(
      routerRequest(`/api/router/commands/${payload.command.id}/result`, {
        method: "POST",
        body: { result: "applied" },
      }),
      environment,
    );
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), {
      status: "applied",
      duplicate: false,
    });

    const replayedResult = await worker.fetch(
      routerRequest(`/api/router/commands/${payload.command.id}/result`, {
        method: "POST",
        body: { result: "applied" },
      }),
      environment,
    );
    assert.deepEqual(await replayedResult.json(), {
      status: "applied",
      duplicate: true,
    });
    assert.equal(
      database
        .prepare("SELECT status FROM router_commands WHERE id = ?")
        .get(payload.command.id).status,
      "applied",
    );
  } finally {
    database.close();
  }
});

test("simulated router applies a grant and then a revoke without network access", async () => {
  const database = await createTestDatabase();
  await createActiveTestSubscription(database, "FC-FULL-ROUTER-SIMULATION");
  const environment = {
    DB: new LocalD1(database),
    ROUTER_SIMULATOR_ENABLED: "true",
    ROUTER_SIMULATOR_TOKEN: simulatorToken,
  };
  const simulatedRouter = new SimulatedRouter({
    clock: () => new Date("2026-10-02T12:00:00.000Z"),
  });

  try {
    const grantResponse = await worker.fetch(
      routerRequest("/api/router/commands"),
      environment,
    );
    const grantPayload = await grantResponse.json();
    const grantResult = simulatedRouter.apply(grantPayload.command);
    assert.deepEqual(grantResult, { result: "applied" });
    assert.deepEqual(simulatedRouter.getUser(grantPayload.command.macAddress), {
      profile: "plan-10-days",
      expiresAt: "2026-10-12T12:00:00.000Z",
    });

    const grantAcknowledgement = await worker.fetch(
      routerRequest(
        `/api/router/commands/${grantPayload.command.id}/result`,
        { method: "POST", body: grantResult },
      ),
      environment,
    );
    assert.equal(grantAcknowledgement.status, 200);

    database
      .prepare(
        `UPDATE subscriptions SET status = 'revoked'
         WHERE id = 'subscription-FC-FULL-ROUTER-SIMULATION'`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO router_commands
           (id, subscription_id, action, status)
         VALUES (?, ?, 'revoke', 'pending')`,
      )
      .run(
        "00000000-0000-4000-8000-000000000002",
        "subscription-FC-FULL-ROUTER-SIMULATION",
      );

    const revokeResponse = await worker.fetch(
      routerRequest("/api/router/commands"),
      environment,
    );
    const revokePayload = await revokeResponse.json();
    assert.equal(revokePayload.command.action, "revoke");
    const revokeResult = simulatedRouter.apply(revokePayload.command);
    assert.equal(simulatedRouter.getUser(revokePayload.command.macAddress), null);

    const revokeAcknowledgement = await worker.fetch(
      routerRequest(
        `/api/router/commands/${revokePayload.command.id}/result`,
        { method: "POST", body: revokeResult },
      ),
      environment,
    );
    assert.equal(revokeAcknowledgement.status, 200);
    assert.equal(simulatedRouter.size, 0);
  } finally {
    database.close();
  }
});

test("simulator command failures are retried with bounded delays", async () => {
  const database = await createTestDatabase();
  await createActiveTestSubscription(database, "FC-RETRY");
  const environment = {
    DB: new LocalD1(database),
    ROUTER_SIMULATOR_ENABLED: "true",
    ROUTER_SIMULATOR_TOKEN: simulatorToken,
  };

  try {
    const claim = await worker.fetch(
      routerRequest("/api/router/commands"),
      environment,
    );
    const { command } = await claim.json();
    const failure = await worker.fetch(
      routerRequest(`/api/router/commands/${command.id}/result`, {
        method: "POST",
        body: { result: "failed", errorCode: "temporary_failure" },
      }),
      environment,
    );

    assert.equal(failure.status, 200);
    assert.deepEqual(await failure.json(), {
      status: "retry_queued",
      attempts: 1,
      retryAfterSeconds: 2,
    });
    assert.equal(
      database
        .prepare("SELECT status, last_error FROM router_commands WHERE id = ?")
        .get(command.id).status,
      "pending",
    );
  } finally {
    database.close();
  }
});

test("simulator result endpoint rejects invalid payloads and methods", async () => {
  const database = await createTestDatabase();
  await createActiveTestSubscription(database, "FC-INVALID-RESULT");
  const environment = {
    DB: new LocalD1(database),
    ROUTER_SIMULATOR_ENABLED: "true",
    ROUTER_SIMULATOR_TOKEN: simulatorToken,
  };

  try {
    const wrongMethod = await worker.fetch(
      routerRequest("/api/router/commands", { method: "POST" }),
      environment,
    );
    const invalidResult = await worker.fetch(
      routerRequest("/api/router/commands/00000000-0000-0000-0000-000000000000/result", {
        method: "POST",
        body: { result: "run-arbitrary-script", command: "/system reset" },
      }),
      environment,
    );

    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET");
    assert.equal(invalidResult.status, 400);
  } finally {
    database.close();
  }
});

test("pending provider result can later reconcile to success", async () => {
  const database = await createTestDatabase();
  await createPendingOrder(database, "FC-RECONCILE");
  const fakeFapshi = createFakeFapshi({
    db: new LocalD1(database),
    clock: () => new Date("2026-10-02T12:00:00.000Z"),
  });
  const event = {
    orderReference: "FC-RECONCILE",
    providerTransactionId: "FAKE-TRANSACTION-RECONCILE",
  };

  try {
    const pending = await fakeFapshi.settleOrder({
      ...event,
      outcome: "pending",
    });
    const success = await fakeFapshi.settleOrder({
      ...event,
      outcome: "successful",
    });

    assert.equal(pending.processing.paymentStatus, "pending");
    assert.equal(success.processing.outcome, "provisioning_queued");
    assert.equal(
      database
        .prepare("SELECT status FROM payments")
        .get().status,
      "successful",
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM subscriptions")
        .get().count,
      1,
    );
  } finally {
    database.close();
  }
});

test("Fapshi payment start uses only sandbox credentials and documented test numbers", async () => {
  const database = await createTestDatabase();
  const macAddress = "02:00:00:00:00:01";
  await createPendingOrder(database, "FC-SANDBOX-START");
  const originalFetch = globalThis.fetch;
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return Response.json({ transId: "FAPSHI-SANDBOX-1" });
  };

  try {
    const response = await worker.fetch(
      new Request("https://app.test/api/orders/FC-SANDBOX-START/payment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ macAddress }),
      }),
      {
        DB: new LocalD1(database),
        FAPSHI_API_USER: "sandbox-user",
        FAPSHI_API_KEY: "sandbox-key",
      },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      paymentStatus: "pending",
      message: "Sandbox payment request sent. Confirm it on the test number's simulated payment prompt.",
    });
    assert.equal(call.url, "https://sandbox.fapshi.com/direct-pay");
    assert.equal(call.options.headers.apiuser, "sandbox-user");
    assert.equal(call.options.headers.apikey, "sandbox-key");
    assert.deepEqual(JSON.parse(call.options.body), {
      amount: 2000,
      phone: "670000000",
      medium: "mobile money",
      externalId: "FC-SANDBOX-START",
      message: "FastConnect sandbox order FC-SANDBOX-START",
    });
    assert.deepEqual(
      {
        ...database
          .prepare("SELECT provider_transaction_id, status FROM payments")
          .get(),
      },
      { provider_transaction_id: "FAPSHI-SANDBOX-1", status: "pending" },
    );
    const duplicate = await worker.fetch(
      new Request("https://app.test/api/orders/FC-SANDBOX-START/payment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ macAddress }),
      }),
      {
        DB: new LocalD1(database),
        FAPSHI_API_USER: "sandbox-user",
        FAPSHI_API_KEY: "sandbox-key",
      },
    );
    assert.equal(duplicate.status, 200);
    assert.equal(call.url, "https://sandbox.fapshi.com/direct-pay");
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("uncertain Fapshi initiation errors keep the order reserved to prevent duplicate requests", async () => {
  const database = await createTestDatabase();
  const macAddress = "02:00:00:00:00:01";
  await createPendingOrder(database, "FC-SANDBOX-UNCERTAIN");
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const originalConsoleError = console.error;
  console.error = () => {};
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("temporary provider error", { status: 503 });
  };

  try {
    const request = () =>
      new Request("https://app.test/api/orders/FC-SANDBOX-UNCERTAIN/payment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ macAddress }),
      });
    const env = {
      DB: new LocalD1(database),
      FAPSHI_API_USER: "sandbox-user",
      FAPSHI_API_KEY: "sandbox-key",
    };
    const first = await worker.fetch(request(), env);
    const retry = await worker.fetch(request(), env);

    assert.equal(first.status, 503);
    assert.equal(retry.status, 200);
    assert.equal(calls, 1);
    assert.equal(
      database.prepare("SELECT status FROM payments").get().status,
      "pending",
    );
  } finally {
    console.error = originalConsoleError;
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("Fapshi sandbox status is verified server-side before recording payment", async () => {
  const database = await createTestDatabase();
  const macAddress = "02:00:00:00:00:01";
  await createPendingOrder(database, "FC-SANDBOX-VERIFY");
  database
    .prepare(
      `INSERT INTO payments
         (id, order_id, provider_transaction_id, amount_xaf, status, payment_method)
       VALUES ('payment-sandbox', 'order-FC-SANDBOX-VERIFY',
               'FAPSHI-SANDBOX-VERIFY', 2000, 'pending', 'fapshi')`,
    )
    .run();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, "https://sandbox.fapshi.com/payment-status/FAPSHI-SANDBOX-VERIFY");
    return Response.json({
      transId: "FAPSHI-SANDBOX-VERIFY",
      externalId: "FC-SANDBOX-VERIFY",
      transType: "Collection",
      amount: 2000,
      status: "SUCCESSFUL",
      medium: "mobile money",
    });
  };

  try {
    const response = await worker.fetch(
      new Request(
        `https://app.test/api/orders/FC-SANDBOX-VERIFY/payment?mac=${encodeURIComponent(macAddress)}`,
      ),
      {
        DB: new LocalD1(database),
        FAPSHI_API_USER: "sandbox-user",
        FAPSHI_API_KEY: "sandbox-key",
      },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      paymentStatus: "successful",
      orderStatus: "paid",
    });
    assert.equal(database.prepare("SELECT status FROM payments").get().status, "successful");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM subscriptions").get().count, 1);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("Fapshi webhook requires its secret and verifies the sandbox transaction", async () => {
  const database = await createTestDatabase();
  await createPendingOrder(database, "FC-SANDBOX-WEBHOOK");
  database
    .prepare(
      `INSERT INTO payments
         (id, order_id, provider_transaction_id, amount_xaf, status, payment_method)
       VALUES ('payment-webhook', 'order-FC-SANDBOX-WEBHOOK',
               'FAPSHI-SANDBOX-WEBHOOK', 2000, 'pending', 'fapshi')`,
    )
    .run();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      transId: "FAPSHI-SANDBOX-WEBHOOK",
      externalId: "FC-SANDBOX-WEBHOOK",
      transType: "Collection",
      amount: 2000,
      status: "FAILED",
      medium: "mobile money",
    });

  try {
    const webhook = () =>
      new Request("https://app.test/api/payments/fapshi-webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-wh-secret": "private-sandbox-hook-secret",
        },
        body: JSON.stringify({
          transId: "FAPSHI-SANDBOX-WEBHOOK",
          externalId: "FC-SANDBOX-WEBHOOK",
          status: "SUCCESSFUL",
        }),
      });
    const env = {
      DB: new LocalD1(database),
      FAPSHI_API_USER: "sandbox-user",
      FAPSHI_API_KEY: "sandbox-key",
      FAPSHI_WEBHOOK_SECRET: "private-sandbox-hook-secret",
    };
    const response = await worker.fetch(webhook(), env);
    const unauthorized = await worker.fetch(
      new Request("https://app.test/api/payments/fapshi-webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "x-wh-secret": "wrong" },
        body: JSON.stringify({}),
      }),
      env,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { received: true, outcome: "recorded" });
    assert.equal(unauthorized.status, 401);
    assert.equal(database.prepare("SELECT status FROM payments").get().status, "failed");
    assert.equal(database.prepare("SELECT status FROM orders").get().status, "pending");
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("Fapshi sandbox payment requires credentials and rejects non-test numbers", async () => {
  const database = await createTestDatabase();
  const macAddress = "02:00:00:00:00:01";
  await createPendingOrder(database, "FC-SANDBOX-NOT-CONFIGURED");

  try {
    const request = () =>
      new Request("https://app.test/api/orders/FC-SANDBOX-NOT-CONFIGURED/payment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ macAddress }),
      });
    const unavailable = await worker.fetch(request(), { DB: new LocalD1(database) });
    assert.equal(unavailable.status, 503);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM payments").get().count, 0);

    database
      .prepare("UPDATE orders SET payment_network = 'orange' WHERE reference = ?")
      .run("FC-SANDBOX-NOT-CONFIGURED");
    const rejectedTestNumber = await worker.fetch(request(), {
      DB: new LocalD1(database),
      FAPSHI_API_USER: "sandbox-user",
      FAPSHI_API_KEY: "sandbox-key",
    });
    assert.equal(rejectedTestNumber.status, 422);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM payments").get().count, 0);
  } finally {
    database.close();
  }
});

test("database failures return an explicit unavailable response", async () => {
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const response = await worker.fetch(
      new Request("https://app.test/health"),
      {},
    );

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "Service temporarily unavailable",
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test("static assets are forwarded and API methods are enforced", async () => {
  const database = await createTestDatabase();
  let assetRequest;

  try {
    const unknownRoute = await worker.fetch(
      new Request("https://app.test/not-a-route"),
      {
        DB: new LocalD1(database),
        ASSETS: {
          async fetch(request) {
            assetRequest = request;
            return new Response("static index");
          },
        },
      },
    );
    const unsupportedMethod = await worker.fetch(
      new Request("https://app.test/api/plans", { method: "POST" }),
      { DB: new LocalD1(database) },
    );
    const wrongOrderMethod = await worker.fetch(
      new Request("https://app.test/api/orders"),
      { DB: new LocalD1(database) },
    );

    assert.equal(unknownRoute.status, 200);
    assert.equal(await unknownRoute.text(), "static index");
    assert.equal(assetRequest.url, "https://app.test/not-a-route");
    assert.equal(unsupportedMethod.status, 405);
    assert.equal(unsupportedMethod.headers.get("allow"), "GET");
    assert.equal(wrongOrderMethod.status, 405);
    assert.equal(wrongOrderMethod.headers.get("allow"), "POST");
  } finally {
    database.close();
  }
});

test("D1 schema enforces unique device addresses and order references", async () => {
  const database = await createTestDatabase();

  try {
    database
      .prepare(
        `INSERT INTO devices (id, mac_address) VALUES (?, ?),
         (?, ?)`,
      )
      .run("device-1", "02:00:00:00:00:01", "device-2", "02:00:00:00:00:02");
    database
      .prepare(
        `INSERT INTO orders
         (id, reference, device_id, plan_id, phone_number, payment_network, amount_xaf)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "order-1",
        "FC-TEST-1",
        "device-1",
        "10-day",
        "670000000",
        "mtn",
        2000,
      );

    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO orders
             (id, reference, device_id, plan_id, phone_number, payment_network, amount_xaf)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "order-2",
            "FC-TEST-1",
            "device-2",
            "10-day",
            "670000000",
            "mtn",
            2000,
          ),
      /UNIQUE constraint failed: orders\.reference/,
    );
  } finally {
    database.close();
  }
});


test("customer accounts can register, sign in, and revoke their session", async () => {
  const database = await createTestDatabase();
  const db = new LocalD1(database);
  const env = { DB: db };
  const origin = "https://fastconnect.test";

  try {
    const registerResponse = await worker.fetch(
      new Request(`${origin}/api/account/register`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          fullName: "Test Customer",
          email: "customer@example.com",
          phoneNumber: "+237 670 000 000",
          password: "correct-horse-battery-staple",
        }),
      }),
      env,
    );
    assert.equal(registerResponse.status, 201);
    const registered = await registerResponse.json();
    assert.equal(registered.customer.email, "customer@example.com");

    const loginResponse = await worker.fetch(
      new Request(`${origin}/api/account/login`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          email: "CUSTOMER@example.com",
          password: "correct-horse-battery-staple",
        }),
      }),
      env,
    );
    assert.equal(loginResponse.status, 200);
    assert.equal((await loginResponse.json()).authenticated, true);
    const setCookie = loginResponse.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    const cookie = setCookie.split(";")[0];

    const sessionResponse = await worker.fetch(
      new Request(`${origin}/api/account/session`, { headers: { cookie } }),
      env,
    );
    const session = await sessionResponse.json();
    assert.equal(session.authenticated, true);
    assert.equal(session.customer.email, "customer@example.com");

    const logoutResponse = await worker.fetch(
      new Request(`${origin}/api/account/logout`, {
        method: "POST",
        headers: { origin, cookie },
      }),
      env,
    );
    assert.equal(logoutResponse.status, 200);

    const afterLogout = await worker.fetch(
      new Request(`${origin}/api/account/session`, { headers: { cookie } }),
      env,
    );
    assert.equal((await afterLogout.json()).authenticated, false);
  } finally {
    database.close();
  }
});

test("customer registration rejects duplicate email addresses", async () => {
  const database = await createTestDatabase();
  const db = new LocalD1(database);
  const env = { DB: db };
  const origin = "https://fastconnect.test";
  const body = JSON.stringify({
    fullName: "Test Customer",
    email: "duplicate@example.com",
    password: "correct-horse-battery-staple",
  });

  try {
    const sendRegistration = () => worker.fetch(
      new Request(`${origin}/api/account/register`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body,
      }),
      env,
    );
    assert.equal((await sendRegistration()).status, 201);
    assert.equal((await sendRegistration()).status, 409);
  } finally {
    database.close();
  }
});


test("admin can create a household and approve a family member's unlimited entitlement", async () => {
  const database = await createTestDatabase();
  const env = {
    DB: new LocalD1(database),
    ADMIN_SETUP_TOKEN: "test-admin-setup-token-that-is-long-enough-123",
    ADMIN_SESSION_SECRET: "test-admin-session-secret-that-is-long-enough-123",
  };
  const origin = "https://app.test";

  const registerCustomer = async (fullName, email) => {
    const response = await worker.fetch(
      new Request(`${origin}/api/account/register`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          fullName,
          email,
          password: "correct-horse-battery-staple",
        }),
      }),
      env,
    );
    assert.equal(response.status, 201);
  };

  try {
    await registerCustomer("Household Owner", "owner@example.com");
    await registerCustomer("Family Member", "member@example.com");

    const setup = await worker.fetch(
      new Request(`${origin}/api/admin/setup`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          setupToken: env.ADMIN_SETUP_TOKEN,
          username: "owner",
          fullName: "FastConnect Owner",
          password: "a-long-test-password-2026",
        }),
      }),
      env,
    );
    assert.equal(setup.status, 201);

    const login = await worker.fetch(
      new Request(`${origin}/api/admin/login`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          username: "owner",
          password: "a-long-test-password-2026",
        }),
      }),
      env,
    );
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];

    const created = await worker.fetch(
      new Request(`${origin}/api/admin/households`, {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Test household", ownerEmail: "owner@example.com" }),
      }),
      env,
    );
    assert.equal(created.status, 201);
    const createdPayload = await created.json();
    const householdId = createdPayload.household.id;
    assert.equal(createdPayload.ownerAccess, "approved");

    const added = await worker.fetch(
      new Request(`${origin}/api/admin/households/${householdId}/members`, {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        body: JSON.stringify({ email: "member@example.com" }),
      }),
      env,
    );
    assert.equal(added.status, 201);
    const addedPayload = await added.json();
    assert.equal(addedPayload.membership.status, "pending");

    const approved = await worker.fetch(
      new Request(`${origin}/api/admin/household-memberships/${addedPayload.membership.id}/approve`, {
        method: "POST",
        headers: { origin, cookie },
      }),
      env,
    );
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).access, "unlimited_household");

    const entitlement = database.prepare(
      `SELECT access_entitlements.status, access_entitlements.expires_at,
              access_entitlements.entitlement_type
       FROM access_entitlements
       JOIN customers ON customers.id = access_entitlements.customer_id
       WHERE customers.email = 'member@example.com'`,
    ).get();
    assert.equal(entitlement.status, "active");
    assert.equal(entitlement.expires_at, null);
    assert.equal(entitlement.entitlement_type, "household");
  } finally {
    database.close();
  }
});


test("customers can view only subscriptions owned by their signed-in account", async () => {
  const database = await createTestDatabase();
  const env = { DB: new LocalD1(database) };
  const origin = "https://app.test";

  try {
    const register = async (email, fullName) => worker.fetch(
      new Request(`${origin}/api/account/register`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          fullName,
          email,
          password: "customer-test-password-2026",
        }),
      }),
      env,
    );

    const firstRegister = await register("first@example.com", "First Customer");
    const secondRegister = await register("second@example.com", "Second Customer");
    assert.equal(firstRegister.status, 201);
    assert.equal(secondRegister.status, 201);
    const firstCustomer = (await firstRegister.json()).customer;
    const secondCustomer = (await secondRegister.json()).customer;

    await createActiveTestSubscription(database, "FC-CUSTOMER-SUBSCRIPTION");
    database.prepare(
      `UPDATE subscriptions
       SET customer_id = ?
       WHERE order_id = (SELECT id FROM orders WHERE reference = ?)`,
    ).run(firstCustomer.id, "FC-CUSTOMER-SUBSCRIPTION");

    const login = await worker.fetch(
      new Request(`${origin}/api/account/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: "first@example.com",
          password: "customer-test-password-2026",
        }),
      }),
      env,
    );
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];

    const subscriptionsResponse = await worker.fetch(
      new Request(`${origin}/api/account/subscriptions`, { headers: { cookie } }),
      env,
    );
    assert.equal(subscriptionsResponse.status, 200);
    const payload = await subscriptionsResponse.json();
    assert.equal(payload.subscriptions.length, 1);
    assert.equal(payload.subscriptions[0].orderReference, "FC-CUSTOMER-SUBSCRIPTION");
    assert.equal(payload.subscriptions[0].plan.days, 10);

    const unauthorizedResponse = await worker.fetch(
      new Request(`${origin}/api/account/subscriptions`),
      env,
    );
    assert.equal(unauthorizedResponse.status, 401);

    // A second customer's identity must never affect the first customer's query.
    assert.notEqual(firstCustomer.id, secondCustomer.id);
    const secondLogin = await worker.fetch(
      new Request(`${origin}/api/account/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: "second@example.com",
          password: "customer-test-password-2026",
        }),
      }),
      env,
    );
    assert.equal(secondLogin.status, 200);
    const secondCookie = secondLogin.headers.get("set-cookie").split(";")[0];
    const secondSubscriptions = await worker.fetch(
      new Request(`${origin}/api/account/subscriptions`, { headers: { cookie: secondCookie } }),
      env,
    );
    assert.equal(secondSubscriptions.status, 200);
    assert.deepEqual((await secondSubscriptions.json()).subscriptions, []);
  } finally {
    database.close();
  }
});

test("signed-in customer checkout owns the order and resulting subscription", async () => {
  const database = await createTestDatabase();
  const env = { DB: new LocalD1(database) };
  const origin = "https://app.test";

  try {
    const register = await worker.fetch(
      new Request(`${origin}/api/account/register`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          fullName: "Checkout Customer",
          email: "checkout-customer@example.com",
          password: "customer-test-password-2026",
        }),
      }),
      env,
    );
    assert.equal(register.status, 201);
    const { customer } = await register.json();

    const login = await worker.fetch(
      new Request(`${origin}/api/account/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: "checkout-customer@example.com",
          password: "customer-test-password-2026",
        }),
      }),
      env,
    );
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];

    const unauthenticated = await worker.fetch(
      new Request(`${origin}/api/account/orders`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          planId: "10-day",
          macAddress: "02:00:00:00:00:01",
          phoneNumber: "670000000",
          paymentNetwork: "mtn",
        }),
      }),
      env,
    );
    assert.equal(unauthenticated.status, 401);

    const createOrder = await worker.fetch(
      new Request(`${origin}/api/account/orders`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie },
        body: JSON.stringify({
          planId: "10-day",
          macAddress: "02:00:00:00:00:01",
          phoneNumber: "670000000",
          paymentNetwork: "mtn",
        }),
      }),
      env,
    );
    const orderPayload = await createOrder.json();
    assert.equal(createOrder.status, 201);
    const storedOrder = database
      .prepare("SELECT customer_id, status FROM orders WHERE reference = ?")
      .get(orderPayload.order.reference);
    assert.equal(storedOrder.customer_id, customer.id);
    assert.equal(storedOrder.status, "pending");

    const fakeFapshi = createFakeFapshi({
      db: new LocalD1(database),
      clock: () => new Date("2026-10-02T12:00:00.000Z"),
    });
    await fakeFapshi.settleOrder({
      orderReference: orderPayload.order.reference,
      outcome: "successful",
      providerTransactionId: "FAKE-ACCOUNT-CHECKOUT",
    });

    const orderId = database
      .prepare("SELECT id FROM orders WHERE reference = ?")
      .get(orderPayload.order.reference).id;
    const storedSubscription = database
      .prepare("SELECT customer_id, status FROM subscriptions WHERE order_id = ?")
      .get(orderId);
    assert.equal(storedSubscription.customer_id, customer.id);
    assert.equal(storedSubscription.status, "active");
  } finally {
    database.close();
  }
});

