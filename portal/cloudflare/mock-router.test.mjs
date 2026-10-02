import assert from "node:assert/strict";
import test from "node:test";
import worker from "./mock-worker.mjs";

test("health endpoint returns the expected live-test message", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/health"),
    {},
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ROUTER-CLOUD-TEST-OK");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("mock router grants and then revokes a test device", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/mock-router/commands"),
    {},
  );
  const payload = await response.json();
  const simulatedHotspotUsers = new Map();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(payload.mode, "simulation-only");
  assert.deepEqual(
    payload.commands.map(({ action }) => action),
    ["grant", "revoke"],
  );

  for (const command of payload.commands) {
    assert.equal(command.macAddress, "02:00:00:00:00:01");

    if (command.action === "grant") {
      simulatedHotspotUsers.set(command.macAddress, {
        profile: command.profile,
        expiresAt: command.expiresAt,
      });
    } else if (command.action === "revoke") {
      simulatedHotspotUsers.delete(command.macAddress);
    } else {
      assert.fail(`Unexpected mock command: ${command.action}`);
    }

    if (command.id === "demo-grant-001") {
      assert.deepEqual(simulatedHotspotUsers.get(command.macAddress), {
        profile: "demo-10-minute",
        expiresAt: "2030-01-01T00:10:00.000Z",
      });
    }
  }

  assert.equal(simulatedHotspotUsers.size, 0);
});

test("unknown paths and unsupported methods are rejected", async () => {
  const unknownPath = await worker.fetch(
    new Request("https://example.test/not-a-route"),
    {},
  );
  const wrongMethod = await worker.fetch(
    new Request("https://example.test/health", { method: "POST" }),
    {},
  );

  assert.equal(unknownPath.status, 404);
  assert.equal(wrongMethod.status, 405);
});
