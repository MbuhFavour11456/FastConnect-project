const MAX_ATTEMPTS = 5;
const CLAIM_LEASE_SECONDS = 60;
const MAX_RESULT_BODY_BYTES = 1024;
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

function errorResponse(message, status, headers = {}) {
  return jsonResponse({ error: message }, status, headers);
}

async function tokensMatch(supplied, expected) {
  const encoder = new TextEncoder();
  const [suppliedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const suppliedBytes = new Uint8Array(suppliedDigest);
  const expectedBytes = new Uint8Array(expectedDigest);
  let difference = 0;

  for (let index = 0; index < expectedBytes.length; index += 1) {
    difference |= suppliedBytes[index] ^ expectedBytes[index];
  }

  return difference === 0;
}

async function authenticateSimulator(request, env) {
  if (env.ROUTER_SIMULATOR_ENABLED !== "true") {
    return errorResponse("Not found", 404);
  }

  const expectedToken = env.ROUTER_SIMULATOR_TOKEN;
  if (typeof expectedToken !== "string" || expectedToken.length < 32) {
    console.error("Router simulator is enabled without a valid secret token");
    return errorResponse("Service temporarily unavailable", 503);
  }

  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._~-]{32,256})$/.exec(authorization);
  if (!match || !(await tokensMatch(match[1], expectedToken))) {
    return errorResponse("Unauthorized", 401);
  }

  return null;
}

function parseCommandId(pathname) {
  const match = /^\/api\/router\/commands\/([0-9a-f-]{36})\/result$/i.exec(pathname);
  return match?.[1] ?? null;
}

async function claimNextCommand(db) {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const leaseUntil = new Date(
    nowDate.getTime() + CLAIM_LEASE_SECONDS * 1000,
  ).toISOString();

  // Recover a worker that died after its final allowed claim.
  await db.prepare(
    `UPDATE router_commands
     SET status = 'failed',
         last_error = COALESCE(last_error, 'claim_lease_expired_after_max_attempts')
     WHERE status = 'claimed'
       AND available_at <= ?
       AND attempts >= ?`,
  ).bind(now, MAX_ATTEMPTS).run();

  const claimed = await db
    .prepare(
      `UPDATE router_commands
       SET status = 'claimed',
           attempts = attempts + 1,
           claimed_at = ?,
           available_at = ?
       WHERE id = (
         SELECT id
         FROM router_commands
         WHERE status IN ('pending', 'claimed')
           AND available_at <= ?
           AND attempts < ?
         ORDER BY created_at ASC, id ASC
         LIMIT 1
       )
       AND status IN ('pending', 'claimed')
       AND available_at <= ?
       AND attempts < ?
       RETURNING id, subscription_id, action, attempts`,
    )
    .bind(
      now,
      leaseUntil,
      now,
      MAX_ATTEMPTS,
      now,
      MAX_ATTEMPTS,
    )
    .first();

  if (!claimed) {
    return null;
  }

  const details = await db
    .prepare(
      `SELECT devices.mac_address, plans.days, subscriptions.expires_at
       FROM subscriptions
       JOIN devices ON devices.id = subscriptions.device_id
       JOIN plans ON plans.id = subscriptions.plan_id
       WHERE subscriptions.id = ?`,
    )
    .bind(claimed.subscription_id)
    .first();

  if (!details) {
    throw new Error("Claimed router command has no associated subscription");
  }

  return {
    id: claimed.id,
    action: claimed.action,
    attempts: claimed.attempts,
    macAddress: details.mac_address,
    profile: `plan-${details.days}-days`,
    expiresAt: details.expires_at,
  };
}

async function readCommands(request, db) {
  if (request.headers.has("content-length")) {
    const contentLength = Number(request.headers.get("content-length"));
    if (!Number.isSafeInteger(contentLength) || contentLength !== 0) {
      return errorResponse("GET requests must not include a body", 400);
    }
  }

  const command = await claimNextCommand(db);
  if (!command) {
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "no-store" },
    });
  }

  return jsonResponse({ mode: "simulation-only", command });
}

async function readResult(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return errorResponse("Content-Type must be application/json", 400);
  }

  let body;
  try {
    const rawBody = await request.arrayBuffer();
    if (rawBody.byteLength > MAX_RESULT_BODY_BYTES) {
      return errorResponse("Request body is too large", 400);
    }

    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  } catch {
    return errorResponse("Request body must be valid JSON", 400);
  }

  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    (body.result !== "applied" && body.result !== "failed") ||
    (body.result === "failed" &&
      body.errorCode !== "temporary_failure" &&
      body.errorCode !== "invalid_command") ||
    (body.result === "applied" && body.errorCode !== undefined)
  ) {
    return errorResponse("Command result is invalid", 400);
  }

  return body;
}

async function recordCommandResult(request, db, commandId) {
  const result = await readResult(request);
  if (result instanceof Response) {
    return result;
  }

  const command = await db
    .prepare("SELECT id, subscription_id, action, status, attempts FROM router_commands WHERE id = ?")
    .bind(commandId)
    .first();
  if (!command) {
    return errorResponse("Command not found", 404);
  }

  if (command.status === "applied" && result.result === "applied") {
    return jsonResponse({ status: "applied", duplicate: true });
  }

  if (command.status !== "claimed") {
    return errorResponse("Command is not currently claimed", 409);
  }

  const nowDate = new Date();
  const now = nowDate.toISOString();
  if (result.result === "applied") {
    const updates = await db.batch([
      db
        .prepare(
          `UPDATE router_commands
           SET status = 'applied', applied_at = ?, last_error = NULL
           WHERE id = ? AND status = 'claimed'`,
        )
        .bind(now, commandId),
      db
        .prepare(
          `UPDATE subscriptions
           SET access_applied_at = ?
           WHERE id = ? AND ? = 'grant'`,
        )
        .bind(now, command.subscription_id, command.action),
      db
        .prepare(
          `UPDATE subscriptions
           SET access_applied_at = NULL
           WHERE id = ? AND ? = 'revoke'`,
        )
        .bind(command.subscription_id, command.action),
    ]);
    const update = updates[0];

    if ((update.meta?.changes ?? update.changes ?? 0) !== 1) {
      const current = await db
        .prepare("SELECT status FROM router_commands WHERE id = ?")
        .bind(commandId)
        .first();
      if (current?.status === "applied") {
        return jsonResponse({ status: "applied", duplicate: true });
      }

      return errorResponse("Command is not currently claimed", 409);
    }

    return jsonResponse({ status: "applied", duplicate: false });
  }

  const willRetry = command.attempts < MAX_ATTEMPTS;
  const retryDelaySeconds = Math.min(2 ** command.attempts, 60);
  const availableAt = new Date(
    nowDate.getTime() + retryDelaySeconds * 1000,
  ).toISOString();
  const update = await db
    .prepare(
      `UPDATE router_commands
       SET status = ?,
           available_at = ?,
           last_error = ?
       WHERE id = ? AND status = 'claimed'`,
    )
    .bind(
      willRetry ? "pending" : "failed",
      availableAt,
      result.errorCode,
      commandId,
    )
    .run();

  if ((update.meta?.changes ?? 0) !== 1) {
    return errorResponse("Command is not currently claimed", 409);
  }

  return jsonResponse({
    status: willRetry ? "retry_queued" : "failed",
    attempts: command.attempts,
    retryAfterSeconds: willRetry ? retryDelaySeconds : null,
  });
}

export async function handleRouterSimulatorRequest(request, env, db, pathname) {
  const unauthorized = await authenticateSimulator(request, env);
  if (unauthorized) {
    return unauthorized;
  }

  if (pathname === "/api/router/commands" && request.method === "GET") {
    if (!db || typeof db.prepare !== "function") {
      throw new Error("Cloudflare D1 binding DB is unavailable");
    }

    const databaseHealth = await db.prepare("SELECT 1 AS ok").first();
    if (databaseHealth?.ok !== 1) {
      throw new Error("Cloudflare D1 health check failed");
    }

    return readCommands(request, db);
  }

  const commandId = parseCommandId(pathname);
  if (commandId && request.method === "POST") {
    if (!db || typeof db.prepare !== "function") {
      throw new Error("Cloudflare D1 binding DB is unavailable");
    }

    const databaseHealth = await db.prepare("SELECT 1 AS ok").first();
    if (databaseHealth?.ok !== 1) {
      throw new Error("Cloudflare D1 health check failed");
    }

    return recordCommandResult(request, db, commandId);
  }

  const allow = pathname === "/api/router/commands" ? "GET" : "POST";
  return errorResponse("Method not allowed", 405, { allow });
}
