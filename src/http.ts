#!/usr/bin/env node
// Streamable HTTP transport (MCP spec 2025-11-25), stateless: every POST /mcp
// gets a fresh server + transport, so it scales horizontally and needs no sessions.

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, SERVER_INFO } from "./server.js";
import { createRpc } from "./xrpl.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const here = path.dirname(fileURLToPath(import.meta.url));
const rpc = createRpc();

export function buildApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  // Simple per-IP rate limit (in-memory) so a public deployment can't be used to hammer XRPL nodes.
  const hits = new Map<string, { n: number; reset: number }>();
  app.use("/mcp", (req, res, next) => {
    const ip = req.ip ?? "unknown";
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || h.reset < now) hits.set(ip, { n: 1, reset: now + 60_000 });
    else if (++h.n > 60) return void res.status(429).json({ jsonrpc: "2.0", error: { code: -32000, message: "Too many requests, slow down." }, id: null });
    next();
  });

  // Origin check (spec: servers MUST validate Origin to prevent DNS rebinding).
  app.use("/mcp", (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin)) {
      return void res.status(403).json({ jsonrpc: "2.0", error: { code: -32000, message: "Origin not allowed" }, id: null });
    }
    next();
  });

  app.post("/mcp", async (req, res) => {
    const server = createServer(rpc);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });
  const notAllowed = (_req: express.Request, res: express.Response) =>
    void res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: use POST)." }, id: null });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  app.get("/health", (_req, res) => void res.json({ ok: true, ...SERVER_INFO, transport: "streamable-http", protocol: "2025-11-25" }));
  app.use("/", express.static(path.join(here, "..", "public")));
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  buildApp().listen(PORT, HOST, () => {
    console.log(`XRPL Token Guard MCP on http://${HOST}:${PORT}/mcp  ·  voice demo on http://${HOST}:${PORT}/`);
  });
}
