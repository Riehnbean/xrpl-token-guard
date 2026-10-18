#!/usr/bin/env node
// stdio transport for local MCP clients (Claude Desktop, Claude Code, Cursor...).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const server = createServer();
await server.connect(new StdioServerTransport());
