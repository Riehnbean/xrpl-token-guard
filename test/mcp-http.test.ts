// End-to-end: a real MCP client talks to the Streamable HTTP server over the network.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/http.js";

let server: Server;
let base: string;

before(async () => {
  await new Promise<void>((resolve) => {
    server = buildApp().listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
after(() => server.close());

test("health endpoint reports the transport and protocol", async () => {
  const h = await (await fetch(`${base}/health`)).json();
  assert.equal(h.transport, "streamable-http");
  assert.equal(h.protocol, "2025-11-25");
});

test("MCP client can list tools and prompts over Streamable HTTP", async () => {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["check_token_safety", "check_wallet_security", "is_it_the_real_token"]);
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, true, `${t.name} must be read-only`);
    assert.ok(t.outputSchema, `${t.name} declares an output schema`);
  }
  const { prompts } = await client.listPrompts();
  assert.ok(prompts.some((p) => p.name === "voice_token_check"));

  const real = await client.callTool({ name: "is_it_the_real_token", arguments: { ticker: "RLUSD", issuer: "rp2DskzVGGz6iDw8ViSVjcMabqJJ2wA2S6" } });
  assert.equal((real.structuredContent as any).is_official, false);
  const report = new URL((real.structuredContent as any).full_report_url);
  assert.equal(report.searchParams.get("issuer"), "rp2DskzVGGz6iDw8ViSVjcMabqJJ2wA2S6");
  assert.equal(report.searchParams.get("kind"), "token");
  await client.close();
});

test("GET /mcp is refused on a stateless server", async () => {
  const r = await fetch(`${base}/mcp`);
  assert.equal(r.status, 405);
});

test("live mainnet check (set LIVE=1)", { skip: process.env.LIVE !== "1" }, async () => {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const r = await client.callTool({ name: "check_token_safety", arguments: { currency: "RLUSD", issuer: "rp2DskzVGGz6iDw8ViSVjcMabqJJ2wA2S6" } });
  assert.equal((r.structuredContent as any).verdict, "high_risk");
  await client.close();
});
