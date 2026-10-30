const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const sessionDurationSeconds = 8 * 60 * 60;
const loginWindowMilliseconds = 15 * 60 * 1000;
const maximumLoginFailures = 5;
const passwordIterations = 100000;
const encoder = new TextEncoder();

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...jsonHeaders, ...headers },
  });
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function constantTimeEqual(left, right) {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function cookieName(url) {
  return url.protocol === "https:" ? "__Host-fastconnect-admin" : "fastconnect-admin";
}

function sessionCookie(request, value, maxAge) {
  const name = cookieName(new URL(request.url));
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function hasSameOrigin(request) {
  return request.headers.get("origin") === new URL(request.url).origin;
}

function getCookie(request, name) {
  const cookies = request.headers.get("cookie") ?? "";
  for (const item of cookies.split(";")) {
    const separator = item.indexOf("=");
    if (separator >= 0 && item.slice(0, separator).trim() === name) {
      return item.slice(separator + 1).trim();
    }
  }
  return null;
}

function isValidUsername(value) {
  return typeof value === "string" && /^[a-zA-Z0-9._-]{3,64}$/.test(value);
}

function isValidPassword(value) {
  return typeof value === "string" && value.length >= 12 && value.length <= 256;
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return null;
  }
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 4096) return null;
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function hmacKey(secret) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("Required admin secret is not configured");
  }
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function hmac(secret, value) {
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(value)),
  );
}

async function derivePasswordHash(password, salt) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations: passwordIterations,
    },
    key,
    256,
  );
  return encodeBase64Url(new Uint8Array(bits));
}

async function passwordRecord(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePasswordHash(password, salt);
  return `pbkdf2-sha256$${passwordIterations}$${encodeBase64Url(salt)}$${hash}`;
}

async function verifyPassword(password, passwordHash) {
  const [algorithm, iterationsText, saltText, expectedHash, ...extra] =
    passwordHash.split("$");
  const iterations = Number(iterationsText);
  if (
    algorithm !== "pbkdf2-sha256" ||
    !Number.isInteger(iterations) ||
    iterations < 100000 ||
    iterations > 1000000 ||
    !saltText ||
    !expectedHash ||
    extra.length > 0
  ) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: decodeBase64Url(saltText),
      iterations,
    },
    key,
    256,
  );
  return constantTimeEqual(new Uint8Array(bits), decodeBase64Url(expectedHash));
}

async function createSession(request, env, admin) {
  const expiresAt = Math.floor(Date.now() / 1000) + sessionDurationSeconds;
  const payload = encodeBase64Url(
    encoder.encode(
      JSON.stringify({
        adminId: admin.id,
        username: admin.username,
        sessionVersion: admin.session_version,
        expiresAt,
      }),
    ),
  );
  const signature = encodeBase64Url(await hmac(env.ADMIN_SESSION_SECRET, payload));
  return sessionCookie(request, `${payload}.${signature}`, sessionDurationSeconds);
}

async function authenticatedAdmin(request, env, db) {
  const name = cookieName(new URL(request.url));
  const value = getCookie(request, name);
  if (!value) return null;
  const [payload, signature, ...extra] = value.split(".");
  if (!payload || !signature || extra.length > 0) return null;

  let signatureBytes;
  let session;
  try {
    signatureBytes = decodeBase64Url(signature);
    const key = await hmacKey(env.ADMIN_SESSION_SECRET);
    if (!(await crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(payload)))) {
      return null;
    }
    session = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)));
  } catch {
    return null;
  }

  if (
    !session ||
    typeof session.adminId !== "string" ||
    !Number.isSafeInteger(session.expiresAt) ||
    session.expiresAt <= Math.floor(Date.now() / 1000)
  ) {
    return null;
  }
  const admin = await db
    .prepare(
      `SELECT id, username, full_name, role, session_version
       FROM admins
       WHERE id = ? AND is_active = 1`,
    )
    .bind(session.adminId)
    .first();
  return admin && admin.session_version === session.sessionVersion ? admin : null;
}

function failedLoginWindow(attempt) {
  if (!attempt) return null;
  const startedAt = Date.parse(attempt.window_started_at);
  if (!Number.isFinite(startedAt)) {
    throw new Error("Stored administrator login window is invalid");
  }
  return { failures: attempt.failures, endsAt: startedAt + loginWindowMilliseconds };
}

async function recordFailedLogin(db, attemptKey, now) {
  const windowStart = new Date(now.getTime() - loginWindowMilliseconds).toISOString();
  const timestamp = now.toISOString();
  await db
    .prepare(
      `INSERT INTO admin_login_attempts
         (attempt_key, failures, window_started_at, updated_at)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(attempt_key) DO UPDATE SET
         failures = CASE
           WHEN admin_login_attempts.window_started_at <= ? THEN 1
           ELSE admin_login_attempts.failures + 1
         END,
         window_started_at = CASE
           WHEN admin_login_attempts.window_started_at <= ?
             THEN excluded.updated_at
           ELSE admin_login_attempts.window_started_at
         END,
         updated_at = excluded.updated_at`,
    )
    .bind(attemptKey, timestamp, timestamp, windowStart, windowStart)
    .run();
}

async function setupFirstAdmin(request, env, db) {
  if (!hasSameOrigin(request)) return jsonResponse({ error: "Request origin rejected" }, 403);
  if (typeof env.ADMIN_SETUP_TOKEN !== "string" || env.ADMIN_SETUP_TOKEN.length < 32) {
    return jsonResponse({ error: "Administrator setup is not enabled" }, 503);
  }
  const body = await readJson(request);
  if (
    !body ||
    typeof body.setupToken !== "string" ||
    body.setupToken.length < 32 ||
    body.setupToken.length > 256 ||
    !isValidUsername(body.username) ||
    !isValidPassword(body.password) ||
    typeof body.fullName !== "string" ||
    body.fullName.trim().length < 1 ||
    body.fullName.trim().length > 120
  ) {
    return jsonResponse(
      { error: "Provide a valid setup token, username, name, and password of at least 12 characters" },
      400,
    );
  }

  const existingAdmins = await db
    .prepare("SELECT COUNT(*) AS total FROM admins")
    .first();
  if (existingAdmins.total > 0) {
    return jsonResponse({ error: "Administrator setup is already complete" }, 409);
  }

  const expectedToken = await hmac(env.ADMIN_SETUP_TOKEN, "fastconnect-admin-setup");
  const suppliedToken = await hmac(body.setupToken, "fastconnect-admin-setup");
  if (!constantTimeEqual(expectedToken, suppliedToken)) {
    return jsonResponse({ error: "Administrator setup is unavailable or the token is invalid" }, 403);
  }

  const passwordHash = await passwordRecord(body.password);
  const adminId = crypto.randomUUID();
  const results = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO admins (id, username, password_hash, full_name, role)
         SELECT ?, ?, ?, ?, 'admin'
         WHERE NOT EXISTS (SELECT 1 FROM admins)`,
      )
      .bind(
        adminId,
        body.username.toLowerCase(),
        passwordHash,
        body.fullName.trim(),
      ),
    db
      .prepare(
        `INSERT INTO audit_logs (id, actor, action, details)
         SELECT ?, ?, 'admin_account_created', ?
         WHERE EXISTS (SELECT 1 FROM admins WHERE id = ?)`,
      )
      .bind(
        crypto.randomUUID(),
        body.username.toLowerCase(),
        JSON.stringify({ method: "one-time-setup" }),
        adminId,
      ),
  ]);
  if (Number(results[0]?.meta?.changes ?? results[0]?.changes ?? 0) !== 1) {
    return jsonResponse({ error: "Administrator setup is already complete" }, 409);
  }

  return jsonResponse({ created: true }, 201);
}

async function login(request, env, db) {
  if (!hasSameOrigin(request)) return jsonResponse({ error: "Request origin rejected" }, 403);
  const body = await readJson(request);
  if (
    !body ||
    !isValidUsername(body.username) ||
    typeof body.password !== "string" ||
    body.password.length > 256
  ) {
    return jsonResponse({ error: "Invalid username or password" }, 401);
  }

  const username = body.username.toLowerCase();
  const clientIp = request.headers.get("cf-connecting-ip") ?? "local";
  const attemptKey = encodeBase64Url(
    await hmac(env.ADMIN_SESSION_SECRET, `${clientIp}\u0000${username}`),
  );
  const now = new Date();
  const attempt = await db
    .prepare(
      `SELECT failures, window_started_at
       FROM admin_login_attempts
       WHERE attempt_key = ?`,
    )
    .bind(attemptKey)
    .first();
  const window = failedLoginWindow(attempt);
  if (window && window.failures >= maximumLoginFailures && now.getTime() < window.endsAt) {
    const retryAfter = Math.max(1, Math.ceil((window.endsAt - now.getTime()) / 1000));
    return jsonResponse(
      { error: "Too many sign-in attempts. Try again later." },
      429,
      { "retry-after": String(retryAfter) },
    );
  }

  const admin = await db
    .prepare(
      `SELECT id, username, full_name, password_hash, session_version
       FROM admins
       WHERE username = ? AND is_active = 1`,
    )
    .bind(username)
    .first();
  const passwordMatches =
    admin && isValidPassword(body.password)
      ? await verifyPassword(body.password, admin.password_hash)
      : false;
  if (!admin || !passwordMatches) {
    await recordFailedLogin(db, attemptKey, now);
    return jsonResponse({ error: "Invalid username or password" }, 401);
  }

  await db
    .prepare("DELETE FROM admin_login_attempts WHERE attempt_key = ?")
    .bind(attemptKey)
    .run();
  await db
    .prepare(
      `INSERT INTO audit_logs (id, actor, action)
       VALUES (?, ?, 'admin_login')`,
    )
    .bind(crypto.randomUUID(), admin.username)
    .run();

  return jsonResponse(
    { admin: { username: admin.username, fullName: admin.full_name } },
    200,
    { "set-cookie": await createSession(request, env, admin) },
  );
}

async function changeAdminPassword(request, env, db) {
  if (!hasSameOrigin(request)) {
    return jsonResponse({ error: "Request origin rejected" }, 403);
  }
  const admin = await authenticatedAdmin(request, env, db);
  if (!admin) return jsonResponse({ error: "Sign-in required" }, 401);
  const body = await readJson(request);
  if (
    !body ||
    typeof body.currentPassword !== "string" ||
    body.currentPassword.length > 256 ||
    !isValidPassword(body.newPassword)
  ) {
    return jsonResponse(
      { error: "Enter your current password and a new password of at least 12 characters" },
      400,
    );
  }

  const account = await db
    .prepare("SELECT password_hash FROM admins WHERE id = ? AND is_active = 1")
    .bind(admin.id)
    .first();
  if (
    !account ||
    !(await verifyPassword(body.currentPassword, account.password_hash))
  ) {
    return jsonResponse({ error: "Current password is incorrect" }, 401);
  }

  const passwordHash = await passwordRecord(body.newPassword);
  const results = await db.batch([
    db
      .prepare(
        `UPDATE admins
         SET password_hash = ?, session_version = session_version + 1
         WHERE id = ? AND is_active = 1 AND password_hash = ?`,
      )
      .bind(passwordHash, admin.id, account.password_hash),
    db
      .prepare(
        `INSERT INTO audit_logs (id, actor, action, details)
         SELECT ?, ?, 'admin_password_changed', ?
         WHERE EXISTS (
           SELECT 1 FROM admins
           WHERE id = ? AND password_hash = ? AND session_version = ?
         )`,
      )
      .bind(
        crypto.randomUUID(),
        admin.username,
        JSON.stringify({ sessionsRevoked: true }),
        admin.id,
        passwordHash,
        admin.session_version + 1,
      ),
  ]);
  if (Number(results[0]?.meta?.changes ?? results[0]?.changes ?? 0) !== 1) {
    return jsonResponse(
      { error: "The account changed during this request. Sign in again and retry." },
      409,
    );
  }
  return jsonResponse(
    { changed: true, signInRequired: true },
    200,
    { "set-cookie": sessionCookie(request, "", 0) },
  );
}

async function adminOverview(request, env, db) {
  const admin = await authenticatedAdmin(request, env, db);
  if (!admin) return jsonResponse({ error: "Sign-in required" }, 401);
  const [orders, devices, subscriptions, payments] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
         FROM orders`,
      )
      .first(),
    db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
         FROM devices`,
      )
      .first(),
    db
      .prepare(
        `SELECT COUNT(*) AS total FROM subscriptions WHERE status = 'active'`,
      )
      .first(),
    db
      .prepare(
        `SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                SUM(
                  CASE
                    WHEN status = 'successful'
                      AND date(confirmed_at, '+1 hour') = date('now', '+1 hour')
                    THEN amount_xaf ELSE 0
                  END
                ) AS revenue_today,
                SUM(
                  CASE
                    WHEN status = 'successful'
                      AND date(confirmed_at, '+1 hour') = date('now', '+1 hour')
                    THEN 1 ELSE 0
                  END
                ) AS confirmed_today
         FROM payments`,
      )
      .first(),
  ]);
  return jsonResponse({
    orders: { total: orders.total, pending: orders.pending ?? 0 },
    devices: { total: devices.total, pending: devices.pending ?? 0 },
    activeSubscriptions: subscriptions.total,
    pendingPayments: payments.pending ?? 0,
    revenueTodayXaf: payments.revenue_today ?? 0,
    confirmedPaymentsToday: payments.confirmed_today ?? 0,
  });
}

async function listAdminOrders(request, env, db) {
  const admin = await authenticatedAdmin(request, env, db);
  if (!admin) return jsonResponse({ error: "Sign-in required" }, 401);
  const { results } = await db
    .prepare(
      `SELECT orders.reference,
              orders.status,
              orders.amount_xaf,
              orders.created_at,
              plans.name AS plan_name,
              plans.days AS plan_days
       FROM orders
       JOIN plans ON plans.id = orders.plan_id
       ORDER BY orders.created_at DESC, orders.id DESC
       LIMIT 50`,
    )
    .all();
  return jsonResponse({
    orders: results.map((order) => ({
      reference: order.reference,
      status: order.status,
      amountXaf: order.amount_xaf,
      createdAt: order.created_at,
      plan: { name: order.plan_name, days: order.plan_days },
    })),
  });
}

async function listAdminDevices(request, env, db) {
  const admin = await authenticatedAdmin(request, env, db);
  if (!admin) return jsonResponse({ error: "Sign-in required" }, 401);
  const { results } = await db
    .prepare(
      `SELECT id, device_name, mac_address, status, last_seen_at, created_at
       FROM devices
       ORDER BY created_at DESC, id DESC
       LIMIT 100`,
    )
    .all();
  return jsonResponse({
    devices: results.map((device) => ({
      id: device.id,
      name: device.device_name,
      macAddress: device.mac_address,
      status: device.status,
      lastSeenAt: device.last_seen_at,
      firstSeenAt: device.created_at,
    })),
  });
}

async function listAdminSubscriptions(request, env, db) {
  const admin = await authenticatedAdmin(request, env, db);
  if (!admin) return jsonResponse({ error: "Sign-in required" }, 401);
  const { results } = await db
    .prepare(
      `SELECT subscriptions.id,
              subscriptions.status,
              subscriptions.started_at,
              subscriptions.expires_at,
              devices.device_name,
              devices.mac_address,
              plans.name AS plan_name,
              plans.days AS plan_days
       FROM subscriptions
       JOIN devices ON devices.id = subscriptions.device_id
       JOIN plans ON plans.id = subscriptions.plan_id
       ORDER BY subscriptions.created_at DESC, subscriptions.id DESC
       LIMIT 100`,
    )
    .all();
  return jsonResponse({
    subscriptions: results.map((subscription) => ({
      id: subscription.id,
      status: subscription.status,
      startedAt: subscription.started_at,
      expiresAt: subscription.expires_at,
      deviceName: subscription.device_name,
      macAddress: subscription.mac_address,
      plan: { name: subscription.plan_name, days: subscription.plan_days },
    })),
  });
}

async function listAdminPayments(request, env, db) {
  const admin = await authenticatedAdmin(request, env, db);
  if (!admin) return jsonResponse({ error: "Sign-in required" }, 401);
  const { results } = await db
    .prepare(
      `SELECT payments.id,
              payments.status AS payment_status,
              payments.amount_xaf AS payment_amount_xaf,
              payments.created_at AS payment_created_at,
              orders.reference,
              orders.status AS order_status,
              orders.phone_number,
              orders.payment_network,
              orders.amount_xaf AS order_amount_xaf,
              plans.name AS plan_name,
              plans.days AS plan_days
       FROM payments
       JOIN orders ON orders.id = payments.order_id
       JOIN plans ON plans.id = orders.plan_id
       ORDER BY payments.created_at DESC, payments.id DESC
       LIMIT 100`,
    )
    .all();
  return jsonResponse({
    payments: results.map((payment) => ({
      id: payment.id,
      reference: payment.reference,
      status: payment.payment_status,
      orderStatus: payment.order_status,
      amountXaf: payment.payment_amount_xaf,
      orderAmountXaf: payment.order_amount_xaf,
      createdAt: payment.payment_created_at,
      phoneSuffix: payment.phone_number.slice(-2),
      network: payment.payment_network,
      plan: { name: payment.plan_name, days: payment.plan_days },
    })),
  });
}

async function listAdminAuditLogs(request, env, db) {
  const admin = await authenticatedAdmin(request, env, db);
  if (!admin) return jsonResponse({ error: "Sign-in required" }, 401);
  const { results } = await db
    .prepare(
      `SELECT id, actor, action, details, created_at
       FROM audit_logs
       ORDER BY created_at DESC, id DESC
       LIMIT 100`,
    )
    .all();
  return jsonResponse({
    entries: results.map((entry) => ({
      id: entry.id,
      actor: entry.actor ?? "System",
      actorType: entry.actor ? "owner" : "system",
      action: entry.action,
      details: entry.details,
      createdAt: entry.created_at,
      result: "Recorded",
    })),
  });
}

async function listAdminPlans(request, env, db) {
  const admin = await authenticatedAdmin(request, env, db);
  if (!admin) return jsonResponse({ error: "Sign-in required" }, 401);
  const { results } = await db
    .prepare(
      `SELECT plans.id, plans.name, plans.days, plans.price_xaf,
              plans.description, plans.is_active,
              EXISTS (
                SELECT 1 FROM orders WHERE orders.plan_id = plans.id
              ) AS has_orders,
              EXISTS (
                SELECT 1 FROM subscriptions WHERE subscriptions.plan_id = plans.id
              ) AS has_subscriptions,
              EXISTS (
                SELECT 1 FROM vouchers WHERE vouchers.plan_id = plans.id
              ) AS has_vouchers
       FROM plans
       ORDER BY plans.days ASC, plans.id ASC`,
    )
    .all();
  return jsonResponse({
    plans: results.map((plan) => ({
      id: plan.id,
      name: plan.name,
      days: plan.days,
      priceXaf: plan.price_xaf,
      description: plan.description,
      isActive: Boolean(plan.is_active),
      termsLocked: Boolean(plan.has_orders || plan.has_subscriptions || plan.has_vouchers),
    })),
  });
}

function readPlanInput(body) {
  if (
    !body ||
    typeof body.name !== "string" ||
    body.name.trim().length < 1 ||
    body.name.trim().length > 80 ||
    !Number.isInteger(body.days) ||
    body.days < 1 ||
    body.days > 365 ||
    !Number.isSafeInteger(body.priceXaf) ||
    body.priceXaf < 1 ||
    body.priceXaf > 5000000 ||
    typeof body.description !== "string" ||
    body.description.trim().length < 1 ||
    body.description.trim().length > 240 ||
    typeof body.isActive !== "boolean"
  ) {
    return null;
  }
  return {
    name: body.name.trim(),
    days: body.days,
    priceXaf: body.priceXaf,
    description: body.description.trim(),
    isActive: body.isActive,
  };
}

async function createAdminPlan(request, env, db) {
  if (!hasSameOrigin(request)) {
    return jsonResponse({ error: "Request origin rejected" }, 403);
  }
  const admin = await authenticatedAdmin(request, env, db);
  if (!admin) return jsonResponse({ error: "Sign-in required" }, 401);
  const body = await readJson(request);
  if (
    !body ||
    typeof body.id !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.id) ||
    body.id.length > 64
  ) {
    return jsonResponse(
      { error: "Provide a plan ID using lowercase letters, numbers, and hyphens" },
      400,
    );
  }
  const plan = readPlanInput(body);
  if (!plan) {
    return jsonResponse(
      { error: "Enter a name, duration from 1 to 365 days, price, description, and availability" },
      400,
    );
  }
  const existing = await db
    .prepare("SELECT id FROM plans WHERE id = ?")
    .bind(body.id)
    .first();
  if (existing) return jsonResponse({ error: "A plan with that ID already exists" }, 409);

  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO plans (id, name, days, price_xaf, description, is_active)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        body.id,
        plan.name,
        plan.days,
        plan.priceXaf,
        plan.description,
        Number(plan.isActive),
      ),
    db
      .prepare(
        `INSERT INTO audit_logs (id, actor, action, details)
         SELECT ?, ?, 'plan_created', ?
         WHERE EXISTS (SELECT 1 FROM plans WHERE id = ?)`,
      )
      .bind(
        crypto.randomUUID(),
        admin.username,
        JSON.stringify({ planId: body.id, days: plan.days, priceXaf: plan.priceXaf }),
        body.id,
      ),
  ]);
  if (Number(results[0]?.meta?.changes ?? results[0]?.changes ?? 0) !== 1) {
    return jsonResponse({ error: "Could not create the plan" }, 409);
  }
  return jsonResponse({ created: true, plan: { id: body.id, ...plan } }, 201);
}

async function updateAdminPlan(request, env, db, planId) {
  if (!hasSameOrigin(request)) {
    return jsonResponse({ error: "Request origin rejected" }, 403);
  }
  const admin = await authenticatedAdmin(request, env, db);
  if (!admin) return jsonResponse({ error: "Sign-in required" }, 401);
  const body = await readJson(request);
  const plan = readPlanInput(body);
  if (!plan) {
    return jsonResponse(
      { error: "Enter a name, duration from 1 to 365 days, price, description, and availability" },
      400,
    );
  }
  const existing = await db
    .prepare(
      `SELECT plans.name, plans.days,
              EXISTS (SELECT 1 FROM orders WHERE orders.plan_id = plans.id)
                OR EXISTS (
                  SELECT 1 FROM subscriptions
                  WHERE subscriptions.plan_id = plans.id
                  )
                  OR EXISTS (
                    SELECT 1 FROM vouchers WHERE vouchers.plan_id = plans.id
                  ) AS terms_locked
       FROM plans
       WHERE plans.id = ?`,
    )
    .bind(planId)
    .first();
  if (!existing) return jsonResponse({ error: "Plan not found" }, 404);
  if (
    existing.terms_locked &&
    (existing.name !== plan.name || existing.days !== plan.days)
  ) {
    return jsonResponse(
      { error: "This plan already has orders or subscriptions. Create a new plan to change its name or duration." },
      409,
    );
  }

  const results = await db.batch([
    db
      .prepare(
        `UPDATE plans
         SET name = ?, days = ?, price_xaf = ?, description = ?, is_active = ?
         WHERE id = ?
           AND (
             (name = ? AND days = ?)
             OR (
               NOT EXISTS (SELECT 1 FROM orders WHERE orders.plan_id = plans.id)
               AND NOT EXISTS (
                 SELECT 1 FROM subscriptions
                 WHERE subscriptions.plan_id = plans.id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM vouchers WHERE vouchers.plan_id = plans.id
               )
             )
           )`,
      )
      .bind(
        plan.name,
        plan.days,
        plan.priceXaf,
        plan.description,
        Number(plan.isActive),
        planId,
        plan.name,
        plan.days,
      ),
    db
      .prepare(
        `INSERT INTO audit_logs (id, actor, action, details)
         SELECT ?, ?, 'plan_updated', ?
         WHERE EXISTS (
           SELECT 1 FROM plans
           WHERE id = ? AND name = ? AND days = ?
         )`,
      )
      .bind(
        crypto.randomUUID(),
        admin.username,
        JSON.stringify({ planId, days: plan.days, priceXaf: plan.priceXaf, isActive: plan.isActive }),
        planId,
        plan.name,
        plan.days,
      ),
  ]);
  if (Number(results[0]?.meta?.changes ?? results[0]?.changes ?? 0) !== 1) {
    return jsonResponse({ error: "Plan was not changed" }, 409);
  }
  return jsonResponse({ updated: true, plan: { id: planId, ...plan } });
}

const voucherAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function createVoucherCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const characters = Array.from(bytes, (byte) => voucherAlphabet[byte & 31]).join("");
  return `FC-${characters.slice(0, 4)}-${characters.slice(4)}`;
}

async function voucherCodeHash(secret, code) {
  return encodeBase64Url(await hmac(secret, `fastconnect-voucher:${code}`));
}

async function listAdminVouchers(request, env, db) {
  const admin = await authenticatedAdmin(request, env, db);
  if (!admin) return jsonResponse({ error: "Sign-in required" }, 401);
  const { results } = await db
    .prepare(
      `SELECT vouchers.id, vouchers.plan_name, vouchers.plan_days,
              vouchers.amount_xaf, vouchers.note, vouchers.status,
              vouchers.created_at, vouchers.redeemed_at, vouchers.cancelled_at,
              devices.device_name AS redeemed_device_name,
              devices.mac_address AS redeemed_mac_address
       FROM vouchers
       LEFT JOIN devices ON devices.id = vouchers.redeemed_device_id
       ORDER BY vouchers.created_at DESC, vouchers.id DESC
       LIMIT 100`,
    )
    .all();
  return jsonResponse({
    vouchers: results.map((voucher) => ({
      id: voucher.id,
      plan: { name: voucher.plan_name, days: voucher.plan_days },
      amountXaf: voucher.amount_xaf,
      note: voucher.note,
      status: voucher.status,
      createdAt: voucher.created_at,
      redeemedAt: voucher.redeemed_at,
      cancelledAt: voucher.cancelled_at,
      redeemedBy: voucher.redeemed_device_name || voucher.redeemed_mac_address
        ? {
            name: voucher.redeemed_device_name,
            macAddress: voucher.redeemed_mac_address,
          }
        : null,
    })),
  });
}

async function createAdminVoucher(request, env, db) {
  if (!hasSameOrigin(request)) {
    return jsonResponse({ error: "Request origin rejected" }, 403);
  }
  const admin = await authenticatedAdmin(request, env, db);
  if (!admin) return jsonResponse({ error: "Sign-in required" }, 401);
  const body = await readJson(request);
  if (
    !body ||
    typeof body.planId !== "string" ||
    (body.note !== undefined &&
      (typeof body.note !== "string" || body.note.trim().length > 120))
  ) {
    return jsonResponse({ error: "Choose a plan and enter a note of at most 120 characters" }, 400);
  }
  const plan = await db
    .prepare(
      `SELECT id, name, days, price_xaf
       FROM plans WHERE id = ? AND is_active = 1`,
    )
    .bind(body.planId)
    .first();
  if (!plan) return jsonResponse({ error: "The selected plan is unavailable" }, 422);

  const secret = env.ADMIN_SESSION_SECRET;
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("Required admin secret is not configured for voucher code protection");
  }
  const note = body.note?.trim() || null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = createVoucherCode();
    const voucherId = crypto.randomUUID();
    const codeHash = await voucherCodeHash(secret, code);
    const results = await db.batch([
      db
        .prepare(
          `INSERT OR IGNORE INTO vouchers
             (id, code_hash, plan_id, plan_name, plan_days, amount_xaf,
              note, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          voucherId,
          codeHash,
          plan.id,
          plan.name,
          plan.days,
          plan.price_xaf,
          note,
          admin.username,
        ),
      db
        .prepare(
          `INSERT INTO audit_logs (id, actor, action, details)
           SELECT ?, ?, 'voucher_created', ?
           WHERE EXISTS (SELECT 1 FROM vouchers WHERE id = ?)`,
        )
        .bind(
          crypto.randomUUID(),
          admin.username,
          JSON.stringify({
            voucherId,
            planId: plan.id,
            planDays: plan.days,
            amountXaf: plan.price_xaf,
          }),
          voucherId,
        ),
    ]);
    if (Number(results[0]?.meta?.changes ?? results[0]?.changes ?? 0) === 1) {
      return jsonResponse(
        {
          created: true,
          voucher: {
            id: voucherId,
            code,
            plan: { name: plan.name, days: plan.days },
            amountXaf: plan.price_xaf,
            note,
            status: "unused",
            createdAt: new Date().toISOString(),
          },
          redemptionEnabled: false,
        },
        201,
      );
    }
  }
  throw new Error("Could not create a unique voucher code after multiple attempts");
}

async function cancelAdminVoucher(request, env, db, voucherId) {
  if (!hasSameOrigin(request)) {
    return jsonResponse({ error: "Request origin rejected" }, 403);
  }
  const admin = await authenticatedAdmin(request, env, db);
  if (!admin) return jsonResponse({ error: "Sign-in required" }, 401);
  const cancelledAt = new Date().toISOString();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE vouchers
         SET status = 'cancelled', cancelled_at = ?
         WHERE id = ? AND status = 'unused'`,
      )
      .bind(cancelledAt, voucherId),
    db
      .prepare(
        `INSERT INTO audit_logs (id, actor, action, details)
         SELECT ?, ?, 'voucher_cancelled', ?
         WHERE EXISTS (
           SELECT 1 FROM vouchers
           WHERE id = ? AND status = 'cancelled' AND cancelled_at = ?
         )`,
      )
      .bind(
        crypto.randomUUID(),
        admin.username,
        JSON.stringify({ voucherId }),
        voucherId,
        cancelledAt,
      ),
  ]);
  if (Number(results[0]?.meta?.changes ?? results[0]?.changes ?? 0) !== 1) {
    const voucher = await db
      .prepare("SELECT status FROM vouchers WHERE id = ?")
      .bind(voucherId)
      .first();
    return voucher
      ? jsonResponse({ error: "Only unused vouchers can be cancelled" }, 409)
      : jsonResponse({ error: "Voucher not found" }, 404);
  }
  return jsonResponse({ cancelled: true });
}


async function listAdminCustomers(request, env, db) {
  const admin = await authenticatedAdmin(request, env, db);
  if (!admin) return jsonResponse({ error: "Sign-in required" }, 401);

  const { results } = await db.prepare(
    `SELECT id, email, full_name, phone_number, status, email_verified_at, created_at
     FROM customers
     ORDER BY created_at DESC, id DESC
     LIMIT 100`,
  ).all();

  return jsonResponse({
    customers: results.map((customer) => ({
      id: customer.id,
      email: customer.email,
      fullName: customer.full_name,
      phoneNumber: customer.phone_number,
      status: customer.status,
      emailVerified: Boolean(customer.email_verified_at),
      createdAt: customer.created_at,
    })),
  });
}

async function listAdminHouseholds(request, env, db) {
  const admin = await authenticatedAdmin(request, env, db);
  if (!admin) return jsonResponse({ error: "Sign-in required" }, 401);

  const { results } = await db.prepare(
    `SELECT households.id, households.name, households.status, households.created_at,
            customers.email AS owner_email, customers.full_name AS owner_name,
            (SELECT COUNT(*) FROM household_memberships
             WHERE household_id = households.id AND status = 'active') AS active_members,
            (SELECT COUNT(*) FROM household_memberships
             WHERE household_id = households.id AND status IN ('pending', 'invited')) AS pending_members
     FROM households
     JOIN customers ON customers.id = households.owner_customer_id
     ORDER BY households.created_at DESC, households.id DESC
     LIMIT 100`,
  ).all();

  return jsonResponse({
    households: results.map((household) => ({
      id: household.id,
      name: household.name,
      status: household.status,
      owner: { name: household.owner_name, email: household.owner_email },
      activeMembers: household.active_members,
      pendingMembers: household.pending_members,
      createdAt: household.created_at,
    })),
  });
}

async function createAdminHousehold(request, env, db) {
  if (!hasSameOrigin(request)) return jsonResponse({ error: "Request origin rejected" }, 403);
  const admin = await authenticatedAdmin(request, env, db);
  if (!admin) return jsonResponse({ error: "Sign-in required" }, 401);

  const body = await readJson(request);
  const name = typeof body?.name === "string" ? body.name.trim().replace(/\\s+/g, " ") : "";
  const ownerEmail = typeof body?.ownerEmail === "string" ? body.ownerEmail.trim().toLowerCase() : "";
  if (name.length < 2 || name.length > 80 || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(ownerEmail)) {
    return jsonResponse({ error: "Enter a household name and a valid owner email address." }, 400);
  }

  const owner = await db.prepare(
    "SELECT id, email FROM customers WHERE email = ? COLLATE NOCASE AND status = 'active'",
  ).bind(ownerEmail).first();
  if (!owner) return jsonResponse({ error: "An active customer account with that email was not found." }, 404);

  const householdId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const entitlementId = crypto.randomUUID();
  const now = new Date().toISOString();
  const results = await db.batch([
    db.prepare(
      `INSERT INTO households (id, name, owner_customer_id, status, created_by_admin_id, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?)`,
    ).bind(householdId, name, owner.id, admin.id, now, now),
    db.prepare(
      `INSERT INTO household_memberships
         (id, household_id, customer_id, status, approved_by_admin_id, approved_at, created_at, updated_at)
       SELECT ?, id, owner_customer_id, 'active', ?, ?, ?, ?
       FROM households WHERE id = ?`,
    ).bind(membershipId, admin.id, now, now, now, householdId),
    db.prepare(
      `INSERT INTO access_entitlements
         (id, customer_id, entitlement_type, source_id, status, starts_at, expires_at, created_at)
       SELECT ?, customer_id, 'household', id, 'active', ?, NULL, ?
       FROM household_memberships WHERE id = ? AND status = 'active'
       ON CONFLICT(entitlement_type, source_id, customer_id) DO NOTHING`,
    ).bind(entitlementId, now, now, membershipId),
    db.prepare(
      `INSERT INTO account_audit_logs
         (id, customer_id, actor_type, actor_id, action, details, created_at)
       VALUES (?, ?, 'admin', ?, 'household_created', ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      owner.id,
      admin.id,
      JSON.stringify({ householdId, name, ownerEmail: owner.email }),
      now,
    ),
  ]);

  if (Number(results[0]?.meta?.changes ?? results[0]?.changes ?? 0) !== 1) {
    throw new Error("Household could not be created");
  }
  return jsonResponse({
    created: true,
    household: { id: householdId, name, ownerEmail: owner.email },
    ownerAccess: "approved",
    message: "Household created. The owner has been approved for unlimited household access.",
  }, 201);
}

async function addAdminHouseholdMember(request, env, db, householdId) {
  if (!hasSameOrigin(request)) return jsonResponse({ error: "Request origin rejected" }, 403);
  const admin = await authenticatedAdmin(request, env, db);
  if (!admin) return jsonResponse({ error: "Sign-in required" }, 401);

  const body = await readJson(request);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
    return jsonResponse({ error: "Enter a valid email address for the family member." }, 400);
  }

  const customer = await db.prepare(
    "SELECT id, email FROM customers WHERE email = ? COLLATE NOCASE AND status = 'active'",
  ).bind(email).first();
  if (!customer) return jsonResponse({ error: "Create the family member's personal account first." }, 404);

  const membershipId = crypto.randomUUID();
  const now = new Date().toISOString();
  let result;
  try {
    result = await db.prepare(
      `INSERT INTO household_memberships
         (id, household_id, customer_id, status, created_at, updated_at)
       SELECT ?, households.id, customers.id, 'pending', ?, ?
       FROM households
       JOIN customers ON customers.id = ?
       WHERE households.id = ? AND households.status = 'active'
         AND customers.status = 'active'`,
    ).bind(membershipId, now, now, customer.id, householdId).run();
  } catch (error) {
    if (String(error?.message ?? "").includes("UNIQUE constraint failed: household_memberships.household_id, household_memberships.customer_id")) {
      return jsonResponse({ error: "This customer already has a membership in the household." }, 409);
    }
    throw error;
  }

  if (Number(result?.meta?.changes ?? result?.changes ?? 0) !== 1) {
    return jsonResponse({ error: "Active household not found." }, 404);
  }

  await db.prepare(
    `INSERT INTO account_audit_logs
       (id, customer_id, actor_type, actor_id, action, details, created_at)
     VALUES (?, ?, 'admin', ?, 'household_member_requested', ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    customer.id,
    admin.id,
    JSON.stringify({ householdId, membershipId, email }),
    now,
  ).run();

  return jsonResponse({
    created: true,
    membership: { id: membershipId, email: customer.email, status: "pending" },
    message: "Family membership is pending administrator approval.",
  }, 201);
}

async function listAdminHouseholdMemberships(request, env, db) {
  const admin = await authenticatedAdmin(request, env, db);
  if (!admin) return jsonResponse({ error: "Sign-in required" }, 401);

  const { results } = await db.prepare(
    `SELECT household_memberships.id, household_memberships.status,
            household_memberships.created_at, household_memberships.approved_at,
            households.id AS household_id, households.name AS household_name,
            customers.id AS customer_id, customers.full_name, customers.email,
            approver.username AS approved_by
     FROM household_memberships
     JOIN households ON households.id = household_memberships.household_id
     JOIN customers ON customers.id = household_memberships.customer_id
     LEFT JOIN admins AS approver ON approver.id = household_memberships.approved_by_admin_id
     ORDER BY CASE household_memberships.status WHEN 'pending' THEN 0 WHEN 'invited' THEN 1 ELSE 2 END,
              household_memberships.created_at DESC
     LIMIT 200`,
  ).all();

  return jsonResponse({
    memberships: results.map((membership) => ({
      id: membership.id,
      status: membership.status,
      createdAt: membership.created_at,
      approvedAt: membership.approved_at,
      approvedBy: membership.approved_by,
      household: { id: membership.household_id, name: membership.household_name },
      customer: { id: membership.customer_id, name: membership.full_name, email: membership.email },
    })),
  });
}

async function approveAdminHouseholdMembership(request, env, db, membershipId) {
  if (!hasSameOrigin(request)) return jsonResponse({ error: "Request origin rejected" }, 403);
  const admin = await authenticatedAdmin(request, env, db);
  if (!admin) return jsonResponse({ error: "Sign-in required" }, 401);

  const now = new Date().toISOString();
  const entitlementId = crypto.randomUUID();
  const results = await db.batch([
    db.prepare(
      `UPDATE household_memberships
       SET status = 'active', approved_by_admin_id = ?, approved_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('pending', 'invited')
         AND EXISTS (SELECT 1 FROM households WHERE id = household_id AND status = 'active')`,
    ).bind(admin.id, now, now, membershipId),
    db.prepare(
      `INSERT INTO access_entitlements
         (id, customer_id, entitlement_type, source_id, status, starts_at, expires_at, created_at)
       SELECT ?, household_memberships.customer_id, 'household', household_memberships.id,
              'active', ?, NULL, ?
       FROM household_memberships
       JOIN households ON households.id = household_memberships.household_id
       WHERE household_memberships.id = ? AND household_memberships.status = 'active'
         AND households.status = 'active'
       ON CONFLICT(entitlement_type, source_id, customer_id) DO NOTHING`,
    ).bind(entitlementId, now, now, membershipId),
  ]);

  if (Number(results[0]?.meta?.changes ?? results[0]?.changes ?? 0) !== 1) {
    const membership = await db.prepare(
      "SELECT status FROM household_memberships WHERE id = ?",
    ).bind(membershipId).first();
    return membership
      ? jsonResponse({ error: "Membership is not pending or its household is unavailable." }, 409)
      : jsonResponse({ error: "Membership not found." }, 404);
  }

  const membership = await db.prepare(
    "SELECT customer_id FROM household_memberships WHERE id = ?",
  ).bind(membershipId).first();
  await db.prepare(
    `INSERT INTO account_audit_logs
       (id, customer_id, actor_type, actor_id, action, details, created_at)
     VALUES (?, ?, 'admin', ?, 'household_membership_approved', ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    membership.customer_id,
    admin.id,
    JSON.stringify({ membershipId }),
    now,
  ).run();

  return jsonResponse({ approved: true, membershipId, access: "unlimited_household" });
}

async function revokeAdminHouseholdMembership(request, env, db, membershipId) {
  if (!hasSameOrigin(request)) return jsonResponse({ error: "Request origin rejected" }, 403);
  const admin = await authenticatedAdmin(request, env, db);
  if (!admin) return jsonResponse({ error: "Sign-in required" }, 401);

  const now = new Date().toISOString();
  const result = await db.prepare(
    `UPDATE household_memberships
     SET status = 'removed', updated_at = ?
     WHERE id = ? AND status IN ('active', 'pending', 'invited', 'suspended')`,
  ).bind(now, membershipId).run();
  if (Number(result?.meta?.changes ?? result?.changes ?? 0) !== 1) {
    const membership = await db.prepare(
      "SELECT id FROM household_memberships WHERE id = ?",
    ).bind(membershipId).first();
    return membership
      ? jsonResponse({ error: "Membership is already removed." }, 409)
      : jsonResponse({ error: "Membership not found." }, 404);
  }

  const membership = await db.prepare(
    "SELECT customer_id FROM household_memberships WHERE id = ?",
  ).bind(membershipId).first();
  await db.batch([
    db.prepare(
      `UPDATE access_entitlements SET status = 'revoked'
       WHERE entitlement_type = 'household' AND source_id = ? AND status = 'active'`,
    ).bind(membershipId),
    db.prepare(
      `INSERT INTO account_audit_logs
         (id, customer_id, actor_type, actor_id, action, details, created_at)
       VALUES (?, ?, 'admin', ?, 'household_membership_revoked', ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      membership.customer_id,
      admin.id,
      JSON.stringify({ membershipId }),
      now,
    ),
  ]);

  return jsonResponse({ revoked: true, membershipId });
}

export async function handleAdminRequest(request, env, db, pathname) {
  if (!db || typeof db.prepare !== "function") {
    throw new Error("Cloudflare D1 binding DB is unavailable for admin access");
  }

  const routes = new Map([
    ["/api/admin/setup", { method: "POST", handler: setupFirstAdmin }],
    ["/api/admin/login", { method: "POST", handler: login }],
    ["/api/admin/password", { method: "POST", handler: changeAdminPassword }],
    ["/api/admin/logout", { method: "POST", handler: null }],
    ["/api/admin/session", { method: "GET", handler: null }],
    ["/api/admin/overview", { method: "GET", handler: adminOverview }],
    ["/api/admin/orders", { method: "GET", handler: listAdminOrders }],
    ["/api/admin/devices", { method: "GET", handler: listAdminDevices }],
    ["/api/admin/subscriptions", { method: "GET", handler: listAdminSubscriptions }],
    ["/api/admin/payments", { method: "GET", handler: listAdminPayments }],
    ["/api/admin/audit", { method: "GET", handler: listAdminAuditLogs }],
    ["/api/admin/plans", { method: "GET", handler: listAdminPlans }],
    ["/api/admin/vouchers", { method: "GET", handler: listAdminVouchers }],
    ["/api/admin/customers", { method: "GET", handler: listAdminCustomers }],
    ["/api/admin/households", { method: "GET", handler: listAdminHouseholds }],
    ["/api/admin/household-memberships", { method: "GET", handler: listAdminHouseholdMemberships }],
  ]);
  const planIdMatch = /^\/api\/admin\/plans\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(pathname);
  const voucherIdMatch = /^\/api\/admin\/vouchers\/([0-9a-f-]{36})\/cancel$/.exec(pathname);
  const householdMembersMatch = /^\/api\/admin\/households\/([0-9a-f-]{36})\/members$/.exec(pathname);
  const householdMembershipActionMatch = /^\/api\/admin\/household-memberships\/([0-9a-f-]{36})\/(approve|revoke)$/.exec(pathname);
  const route =
    pathname === "/api/admin/households" && request.method === "POST"
      ? { method: "POST", handler: createAdminHousehold }
      : householdMembersMatch
        ? {
            method: "POST",
            handler: (request, requestEnv, requestDb) =>
              addAdminHouseholdMember(request, requestEnv, requestDb, householdMembersMatch[1]),
          }
        : householdMembershipActionMatch
          ? {
              method: "POST",
              handler: (request, requestEnv, requestDb) =>
                householdMembershipActionMatch[2] === "approve"
                  ? approveAdminHouseholdMembership(request, requestEnv, requestDb, householdMembershipActionMatch[1])
                  : revokeAdminHouseholdMembership(request, requestEnv, requestDb, householdMembershipActionMatch[1]),
            }
          : pathname === "/api/admin/plans" && request.method === "POST"
      ? { method: "POST", handler: createAdminPlan }
      : pathname === "/api/admin/vouchers" && request.method === "POST"
        ? { method: "POST", handler: createAdminVoucher }
        : planIdMatch
          ? {
              method: "PUT",
              handler: (request, requestEnv, requestDb) =>
                updateAdminPlan(request, requestEnv, requestDb, planIdMatch[1]),
            }
          : voucherIdMatch
            ? {
                method: "POST",
                handler: (request, requestEnv, requestDb) =>
                  cancelAdminVoucher(request, requestEnv, requestDb, voucherIdMatch[1]),
              }
            : routes.get(pathname);
  if (!route) return jsonResponse({ error: "Not found" }, 404);
  if (request.method !== route.method) {
    return jsonResponse({ error: "Method not allowed" }, 405, { allow: route.method });
  }
  if (route.handler) return route.handler(request, env, db);

  if (pathname === "/api/admin/logout") {
    if (!hasSameOrigin(request)) {
      return jsonResponse({ error: "Request origin rejected" }, 403);
    }
    const admin = await authenticatedAdmin(request, env, db);
    if (admin) {
      await db
        .prepare(
          `UPDATE admins SET session_version = session_version + 1 WHERE id = ?`,
        )
        .bind(admin.id)
        .run();
      await db
        .prepare(
          `INSERT INTO audit_logs (id, actor, action)
           VALUES (?, ?, 'admin_logout')`,
        )
        .bind(crypto.randomUUID(), admin.username)
        .run();
    }
    return jsonResponse(
      { loggedOut: true },
      200,
      { "set-cookie": sessionCookie(request, "", 0) },
    );
  }

  if (pathname === "/api/admin/session") {
    const admin = await authenticatedAdmin(request, env, db);
    return jsonResponse(
      admin
        ? {
            authenticated: true,
            admin: { username: admin.username, fullName: admin.full_name },
          }
        : { authenticated: false },
    );
  }

  return adminOverview(request, env, db);
}
