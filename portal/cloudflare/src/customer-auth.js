const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const SESSION_SECONDS = 60 * 60 * 24 * 14;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const PASSWORD_ITERATIONS = 210_000;
const MAX_BODY_BYTES = 4096;
const encoder = new TextEncoder();

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...jsonHeaders, ...headers },
  });
}

function cookieName(request) {
  return new URL(request.url).protocol === "https:"
    ? "__Host-fastconnect-customer"
    : "fastconnect-customer";
}

function sessionCookie(request, token, maxAge) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${cookieName(request)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function clearSessionCookie(request) {
  return sessionCookie(request, "", 0);
}

function readCookie(request, name) {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator >= 0 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

function hasSameOrigin(request) {
  return request.headers.get("origin") === new URL(request.url).origin;
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return null;
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) return null;

  try {
    const raw = await request.arrayBuffer();
    if (raw.byteLength > MAX_BODY_BYTES) return null;
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
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

async function digest(value) {
  return encodeBase64Url(new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  ));
}

async function derivePassword(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return encodeBase64Url(new Uint8Array(bits));
}

async function createPasswordHash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePassword(password, salt, PASSWORD_ITERATIONS);
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${encodeBase64Url(salt)}$${hash}`;
}

function constantTimeEqual(left, right) {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function verifyPassword(password, record) {
  const [algorithm, iterationsValue, saltValue, expected] = String(record ?? "").split("$");
  const iterations = Number(iterationsValue);
  if (
    algorithm !== "pbkdf2-sha256" ||
    !Number.isSafeInteger(iterations) ||
    iterations < 100_000 ||
    iterations > 1_000_000 ||
    !saltValue ||
    !expected
  ) {
    return false;
  }

  try {
    const actual = await derivePassword(password, decodeBase64Url(saltValue), iterations);
    return constantTimeEqual(encoder.encode(actual), encoder.encode(expected));
  } catch {
    return false;
  }
}

function validEmail(value) {
  return typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function validPassword(value) {
  return typeof value === "string" && value.length >= 12 && value.length <= 256;
}

function normalizeName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  return name.length >= 2 && name.length <= 100 ? name : null;
}

function loginKey(email) {
  return `email:${email.toLowerCase()}`;
}

async function isRateLimited(db, key, now) {
  const row = await db
    .prepare("SELECT failures, window_started_at FROM customer_login_attempts WHERE attempt_key = ?")
    .bind(key)
    .first();

  if (!row) return false;
  const started = Date.parse(row.window_started_at);
  if (!Number.isFinite(started) || now.getTime() - started >= LOGIN_WINDOW_MS) return false;
  return row.failures >= MAX_LOGIN_FAILURES;
}

async function recordLoginFailure(db, key, now) {
  const current = await db
    .prepare("SELECT failures, window_started_at FROM customer_login_attempts WHERE attempt_key = ?")
    .bind(key)
    .first();
  const windowStart = current && now.getTime() - Date.parse(current.window_started_at) < LOGIN_WINDOW_MS
    ? current.window_started_at
    : now.toISOString();
  const failures = windowStart === current?.window_started_at ? current.failures + 1 : 1;

  await db.prepare(
    `INSERT INTO customer_login_attempts (attempt_key, failures, window_started_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(attempt_key) DO UPDATE SET
       failures = excluded.failures,
       window_started_at = excluded.window_started_at,
       updated_at = excluded.updated_at`,
  ).bind(key, failures, windowStart, now.toISOString()).run();
}

async function clearLoginFailures(db, key) {
  await db.prepare("DELETE FROM customer_login_attempts WHERE attempt_key = ?").bind(key).run();
}

async function getCurrentCustomer(request, db) {
  const token = readCookie(request, cookieName(request));
  if (!token || !/^[A-Za-z0-9_-]{40,64}$/.test(token)) return null;

  const tokenHash = await digest(token);
  const now = new Date().toISOString();
  const customer = await db.prepare(
    `SELECT customers.id, customers.email, customers.full_name, customers.phone_number,
            customers.status, customers.email_verified_at, customer_sessions.id AS session_id
     FROM customer_sessions
     JOIN customers ON customers.id = customer_sessions.customer_id
     WHERE customer_sessions.token_hash = ?
       AND customer_sessions.revoked_at IS NULL
       AND customer_sessions.expires_at > ?
       AND customers.status = 'active'`,
  ).bind(tokenHash, now).first();

  if (!customer) return null;

  await db.prepare(
    "UPDATE customer_sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL",
  ).bind(now, customer.session_id).run();

  return {
    id: customer.id,
    email: customer.email,
    fullName: customer.full_name,
    phoneNumber: customer.phone_number,
    emailVerified: Boolean(customer.email_verified_at),
  };
}

async function register(request, db) {
  if (!hasSameOrigin(request)) return jsonResponse({ error: "Request origin rejected" }, 403);
  const body = await readJson(request);
  const fullName = normalizeName(body?.fullName);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const phoneNumber = typeof body?.phoneNumber === "string" ? body.phoneNumber.trim() : null;

  if (!fullName || !validEmail(email) || !validPassword(body?.password)) {
    return jsonResponse({
      error: "Enter your name, a valid email address, and a password of at least 12 characters.",
    }, 400);
  }
  if (phoneNumber && !/^\+?2376\d{8}$/.test(phoneNumber.replace(/[\s()-]/g, ""))) {
    return jsonResponse({ error: "Enter a valid Cameroon mobile number or leave it blank." }, 400);
  }

  const customerId = crypto.randomUUID();
  const passwordHash = await createPasswordHash(body.password);
  const now = new Date().toISOString();

  try {
    await db.prepare(
      `INSERT INTO customers (id, email, full_name, phone_number, password_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).bind(
      customerId,
      email,
      fullName,
      phoneNumber ? phoneNumber.replace(/[\s()-]/g, "") : null,
      passwordHash,
      now,
      now,
    ).run();
  } catch (error) {
    if (String(error?.message ?? "").includes("UNIQUE constraint failed: customers.email")) {
      return jsonResponse({ error: "An account with this email already exists. Try signing in." }, 409);
    }
    throw error;
  }

  await db.prepare(
    `INSERT INTO account_audit_logs (id, customer_id, actor_type, actor_id, action, details, created_at)
     VALUES (?, ?, 'customer', ?, 'account_registered', ?, ?)`,
  ).bind(crypto.randomUUID(), customerId, customerId, JSON.stringify({ email }), now).run();

  return jsonResponse({
    created: true,
    customer: { id: customerId, email, fullName, phoneNumber: phoneNumber || null },
    message: "Account created. Email verification and password recovery must be configured before production launch.",
  }, 201);
}

async function login(request, db) {
  if (!hasSameOrigin(request)) return jsonResponse({ error: "Request origin rejected" }, 403);
  const body = await readJson(request);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = body?.password;
  if (!validEmail(email) || typeof password !== "string" || password.length > 256) {
    return jsonResponse({ error: "Enter a valid email and password." }, 400);
  }

  const key = loginKey(email);
  const nowDate = new Date();
  if (await isRateLimited(db, key, nowDate)) {
    return jsonResponse({ error: "Too many sign-in attempts. Try again in 15 minutes." }, 429);
  }

  const customer = await db.prepare(
    "SELECT id, email, full_name, phone_number, password_hash, status FROM customers WHERE email = ? COLLATE NOCASE",
  ).bind(email).first();

  const verified = await verifyPassword(password, customer?.password_hash);
  if (!customer || customer.status !== "active" || !verified) {
    await recordLoginFailure(db, key, nowDate);
    return jsonResponse({ error: "Email or password is incorrect." }, 401);
  }

  await clearLoginFailures(db, key);

  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = encodeBase64Url(tokenBytes);
  const tokenHash = await digest(token);
  const now = nowDate.toISOString();
  const expiresAt = new Date(nowDate.getTime() + SESSION_SECONDS * 1000).toISOString();
  const sessionId = crypto.randomUUID();

  await db.batch([
    db.prepare(
      "UPDATE customer_sessions SET revoked_at = ? WHERE customer_id = ? AND revoked_at IS NULL",
    ).bind(now, customer.id),
    db.prepare(
      `INSERT INTO customer_sessions (id, customer_id, token_hash, expires_at, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(sessionId, customer.id, tokenHash, expiresAt, now, now),
    db.prepare(
      `INSERT INTO account_audit_logs (id, customer_id, actor_type, actor_id, action, details, created_at)
       VALUES (?, ?, 'customer', ?, 'account_login', '{}', ?)`,
    ).bind(crypto.randomUUID(), customer.id, customer.id, now),
  ]);

  return jsonResponse({
    authenticated: true,
    customer: {
      id: customer.id,
      email: customer.email,
      fullName: customer.full_name,
      phoneNumber: customer.phone_number,
    },
  }, 200, { "set-cookie": sessionCookie(request, token, SESSION_SECONDS) });
}

async function session(request, db) {
  const customer = await getCurrentCustomer(request, db);
  return customer
    ? jsonResponse({ authenticated: true, customer })
    : jsonResponse({ authenticated: false, customer: null }, 200, {
        "set-cookie": clearSessionCookie(request),
      });
}

async function logout(request, db) {
  if (!hasSameOrigin(request)) return jsonResponse({ error: "Request origin rejected" }, 403);
  const token = readCookie(request, cookieName(request));
  if (token && /^[A-Za-z0-9_-]{40,64}$/.test(token)) {
    const tokenHash = await digest(token);
    const now = new Date().toISOString();
    await db.prepare(
      "UPDATE customer_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
    ).bind(now, tokenHash).run();
  }
  return jsonResponse({ loggedOut: true }, 200, { "set-cookie": clearSessionCookie(request) });
}

async function listCustomerSubscriptions(request, db) {
  const customer = await getCurrentCustomer(request, db);
  if (!customer) {
    return jsonResponse({ error: "Sign in to view your subscriptions." }, 401, {
      "set-cookie": clearSessionCookie(request),
    });
  }

  const { results } = await db.prepare(
    `SELECT subscriptions.id, subscriptions.status, subscriptions.started_at,
            subscriptions.expires_at, plans.id AS plan_id, plans.name AS plan_name,
            plans.days AS plan_days, orders.reference AS order_reference,
            orders.amount_xaf, orders.created_at AS ordered_at
     FROM subscriptions
     JOIN orders ON orders.id = subscriptions.order_id
     JOIN plans ON plans.id = subscriptions.plan_id
     WHERE subscriptions.customer_id = ?
     ORDER BY subscriptions.created_at DESC
     LIMIT 100`,
  ).bind(customer.id).all();

  return jsonResponse({
    subscriptions: results.map((row) => ({
      id: row.id,
      status: row.status,
      startedAt: row.started_at,
      expiresAt: row.expires_at,
      plan: { id: row.plan_id, name: row.plan_name, days: row.plan_days },
      orderReference: row.order_reference,
      amountXaf: row.amount_xaf,
      orderedAt: row.ordered_at,
    })),
  });
}

export async function handleCustomerAuthRequest(request, env, db, pathname) {
  if (!db || typeof db.prepare !== "function") {
    throw new Error("Cloudflare D1 binding DB is unavailable for customer accounts");
  }

  const routes = new Map([
    ["/api/account/register", { method: "POST", handler: register }],
    ["/api/account/login", { method: "POST", handler: login }],
    ["/api/account/session", { method: "GET", handler: session }],
    ["/api/account/subscriptions", { method: "GET", handler: listCustomerSubscriptions }],
    ["/api/account/logout", { method: "POST", handler: logout }],
  ]);
  const route = routes.get(pathname);
  if (!route) return jsonResponse({ error: "Not found" }, 404);
  if (request.method !== route.method) {
    return jsonResponse({ error: "Method not allowed" }, 405, { allow: route.method });
  }

  const health = await db.prepare("SELECT 1 AS ok").first();
  if (health?.ok !== 1) throw new Error("D1 health check failed");
  return route.handler(request, db);
}
