import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkToken, checkWallet, isItReal, TokenReport, WalletReport } from "./checks.js";
import { BRANDS } from "./brands.js";
import { RpcFn, createRpc } from "./xrpl.js";

export const SERVER_INFO = { name: "xrpl-token-guard", version: "0.1.0" };

const finding = z.object({ code: z.string(), severity: z.enum(["high", "caution", "good", "info"]), message: z.string(), spoken: z.string() });
const verdict = z.enum(["high_risk", "caution", "no_red_flags", "not_enough_data"]);

const tokenOutput = {
  verdict,
  verdict_label: z.string(),
  score: z.number().describe("0-100 mechanical score; not a safety probability. Clawback is a high-risk control-policy failure."),
  token: z.object({ ticker: z.string(), currency_code: z.string(), issuer: z.string() }),
  spoken_summary: z.string().describe("One or two sentences ready for text-to-speech."),
  reasons: z.array(finding).describe("The top reasons behind the verdict, most important first."),
  findings: z.array(finding),
  facts: z.record(z.string(), z.unknown()),
  more_info_url: z.string().nullable(),
  checked_at: z.string(),
  ledger_index: z.number().nullable(),
  disclaimer: z.string(),
};

const walletOutput = {
  verdict,
  verdict_label: z.string(),
  address: z.string(),
  spoken_summary: z.string(),
  findings: z.array(finding),
  facts: z.record(z.string(), z.unknown()),
  checked_at: z.string(),
  disclaimer: z.string(),
};

const realOutput = {
  ticker: z.string(),
  known_brand: z.boolean(),
  official: z.object({ name: z.string(), ticker: z.string(), issuer: z.string(), domain: z.string() }).nullable(),
  is_official: z.boolean().nullable(),
  spoken_summary: z.string(),
  message: z.string(),
};

const ICON: Record<string, string> = { high: "⛔", caution: "⚠️", good: "✅", info: "ℹ️" };

export function tokenText(r: TokenReport): string {
  const lines = [
    `**${r.verdict_label}** for ${r.token.ticker} (issuer ${r.token.issuer}) · score ${r.score}/100`,
    "",
    ...r.reasons.map((f) => `- ${ICON[f.severity]} ${f.message}`),
    "",
    `Say it out loud: "${r.spoken_summary}"`,
  ];
  if (r.more_info_url) lines.push("", `Full ledger evidence: ${r.more_info_url}`);
  lines.push("", `_${r.disclaimer}_`);
  return lines.join("\n");
}

export function walletText(r: WalletReport): string {
  return [`**${r.verdict_label}** for wallet ${r.address}`, "", ...r.findings.map((f) => `- ${ICON[f.severity]} ${f.message}`), "", `Say it out loud: "${r.spoken_summary}"`, "", `_${r.disclaimer}_`].join("\n");
}

const errorResult = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: `Couldn't run the check: ${(e as Error).message ?? String(e)}` }] });

export function createServer(rpc: RpcFn = createRpc()): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "XRPL Token Guard checks XRP Ledger tokens and wallets using live, read-only ledger data. " +
      "Use check_token_safety before anyone buys or accepts an XRPL token, is_it_the_real_token when a user names a famous token (RLUSD, USDC, SOLO), " +
      "and check_wallet_security when someone worries their wallet was compromised. Always relay the verdict, the reasons and the disclaimer. " +
      "For voice assistants, read spoken_summary as-is. Never give buy/sell advice. This server never signs or sends transactions.",
  });

  server.registerTool(
    "check_token_safety",
    {
      title: "Check an XRPL token's safety",
      description:
        "Live safety check of an XRP Ledger token (issued currency). Detects fake look-alikes of famous tokens (e.g. a fake RLUSD), " +
        "issuers that can still mint, freeze or claw back, global freezes, transfer fees, unverified domains, whale concentration, thin AMM liquidity and brand-new issuers. " +
        "Returns a verdict (High risk / Caution / No red flags found / Not enough data), the reasons behind it with the exact ledger facts, and a one-sentence spoken summary.",
      inputSchema: {
        currency: z.string().min(1).max(40).describe("Token ticker as shown in wallets (e.g. RLUSD, SOLO) or its 40-character hex currency code."),
        issuer: z.string().min(25).max(35).describe("The token issuer's XRPL address (starts with r)."),
      },
      outputSchema: tokenOutput,
      annotations: { title: "Check XRPL token safety", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ currency, issuer }) => {
      try {
        const r = await checkToken(rpc, { currency, issuer });
        return { content: [{ type: "text", text: tokenText(r) }], structuredContent: r as unknown as Record<string, unknown> };
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "is_it_the_real_token",
    {
      title: "Is this the real token?",
      description:
        `Answers "is this the real RLUSD / USDC / SOLO?" using the verified official issuers (${BRANDS.map((b) => `${b.ticker}: ${b.issuer}`).join("; ")}). ` +
        "Give the ticker alone to learn the official issuer, or ticker + issuer to confirm or expose an imitation. Instant, no ledger call.",
      inputSchema: {
        ticker: z.string().min(1).max(40).describe("The token name or ticker the user mentioned, e.g. RLUSD."),
        issuer: z.string().min(25).max(35).optional().describe("Optional issuer address to verify."),
      },
      outputSchema: realOutput,
      annotations: { title: "Verify an official XRPL token", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ ticker, issuer }) => {
      const r = isItReal(ticker, issuer);
      return { content: [{ type: "text", text: `${r.message}\n\nSay it out loud: "${r.spoken_summary}"` }], structuredContent: r as unknown as Record<string, unknown> };
    },
  );

  server.registerTool(
    "check_wallet_security",
    {
      title: "Check an XRPL wallet for takeover signs",
      description:
        "Checks whether anyone besides the owner can sign for an XRPL wallet: an unexpected regular key or multisig signer list (the classic drainer setup), " +
        "and flags changes made in the last 7 days as urgent. Read-only.",
      inputSchema: { address: z.string().min(25).max(35).describe("The wallet's XRPL address (starts with r).") },
      outputSchema: walletOutput,
      annotations: { title: "Check XRPL wallet security", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ address }) => {
      try {
        const r = await checkWallet(rpc, address);
        return { content: [{ type: "text", text: walletText(r) }], structuredContent: r as unknown as Record<string, unknown> };
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerPrompt(
    "voice_token_check",
    {
      title: "Answer a spoken 'is this token safe?' question",
      description: "Guides a voice assistant to answer token-safety questions briefly and honestly.",
      argsSchema: { question: z.string().describe("What the user asked, e.g. 'Is RLUSD from rp2Dsk… safe?'") },
    },
    ({ question }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `The user asked: "${question}". If they named a famous token without an issuer, call is_it_the_real_token first. ` +
              "If you have an issuer, call check_token_safety. Reply in at most two short spoken sentences: the verdict and the main reason, using spoken_summary. " +
              "Never tell them to buy or sell. End with: 'Not financial advice.'",
          },
        },
      ],
    }),
  );

  return server;
}
