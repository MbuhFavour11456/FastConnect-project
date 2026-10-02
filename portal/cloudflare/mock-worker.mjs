const testMacAddress = "02:00:00:00:00:01";

const mockCommands = [
  {
    id: "demo-grant-001",
    action: "grant",
    macAddress: testMacAddress,
    profile: "demo-10-minute",
    expiresAt: "2030-01-01T00:10:00.000Z",
  },
  {
    id: "demo-revoke-002",
    action: "revoke",
    macAddress: testMacAddress,
  },
];

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return new Response("ROUTER-CLOUD-TEST-OK", {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    if (url.pathname === "/mock-router/commands" && request.method === "GET") {
      return Response.json(
        {
          mode: "simulation-only",
          commands: mockCommands,
        },
        {
          headers: {
            "cache-control": "no-store",
          },
        },
      );
    }

    return new Response("Not found", {
      status: url.pathname === "/health" || url.pathname === "/mock-router/commands" ? 405 : 404,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  },
};
