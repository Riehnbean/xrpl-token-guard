# XRPL Token Guard

**Ask your AI agent, or your voice assistant, "is this token safe?" and get an honest answer with reasons.**

XRPL Token Guard is an open-source [MCP](https://modelcontextprotocol.io) server. It checks XRP Ledger tokens and wallets using live, read-only mainnet data, and returns three things:

- a **verdict**: High risk / Caution / No red flags found / Not enough data
- the **reasons** behind it, each naming the exact ledger fact
- a **one-sentence spoken summary**, ready for text-to-speech on Alexa+ or any other voice assistant

It never signs, never sends a transaction and never asks for keys.

## Need more than a quick check?

Try the free [hosted demo](https://cocoeatsai.com/area4/guard/) or browse the [free token evidence pages](https://cocoeatsai.com/area4/token/). Launch Lab offers a [Token Report for 5 XRP](https://cocoeatsai.com/area4/report/?kind=token), a [Wallet Checkup for 3 XRP](https://cocoeatsai.com/area4/report/?kind=wallet), and a [Token Launch Kit for 10 XRP](https://cocoeatsai.com/area4/report/?kind=kit). Preview the findings before choosing a paid report. These are factual ledger checks, not buy/sell advice or a guarantee of safety; Token Guard stays free.

**Hosted MCP:** `https://cocoeatsai.com/area4/guard/mcp` (Streamable HTTP). The hosted demo supports typed questions and example buttons; microphone input is currently disabled by the hosting policy. It is a voice-assistant simulator, not an actual Alexa integration.

For **Claude Desktop** (`claude_desktop_config.json`) or **Cursor** (`.cursor/mcp.json`), build a local clone using the commands below, then replace the absolute path in this configuration:

```json
{"mcpServers": {
  "xrpl-token-guard": {"command": "node", "args": ["/absolute/path/to/xrpl-token-guard/dist/stdio.js"]}
}}
```

Example risk interpretation (not a trading recommendation):

```
You:    "Is this RLUSD real?"
Guard:  "Warning, high risk. This token calls itself RLUSD, but it is not the real Ripple USD.
         The real one comes from a different issuer. A matching name does not establish authenticity."
```

## Why it exists

Scammers on the XRP Ledger copy famous names. On mainnet today there are several tokens called **RLUSD** that aren't Ripple's. Many of them have a **black-holed issuer**, which naive checkers score as "safe" because nobody can mint more. Token Guard knows the official issuers and flags the copy first. It explains that a locked supply doesn't make an imitation genuine.

Answers have to be short enough to speak and specific enough to trust. Every finding carries both a precise `message` (for screens and agents) and a `spoken` line (for voice).

## Tools

| Tool | What it answers | Ledger calls |
|---|---|---|
| `check_token_safety` | "Is this token safe?" Checks for: imitations of RLUSD/USDC/SOLO, issuers that can still mint, freeze or claw back, Global Freeze, transfer fees, unverified or launchpad-only domains, whale concentration (AMM pool excluded), thin AMM liquidity, brand-new issuers. | `account_info`, `gateway_balances`, `amm_info`, `account_lines`, `account_tx` |
| `is_it_the_real_token` | "Is this the real RLUSD?" Answers instantly from verified official issuers (each issuer's on-ledger Domain points at the brand's own site). | none |
| `check_wallet_security` | "Was my wallet hacked?" Finds a stranger's regular key or multisig signer list (the classic drainer setup), and marks changes from the last 7 days as urgent. | `account_info`, `account_tx` |

There's also a prompt, `voice_token_check`, that tells a voice assistant how to answer: two sentences, the verdict and the main reason, no buy/sell advice.

Every tool has:

- `readOnlyHint: true`
- an `outputSchema`, with typed `structuredContent` in each response
- a human-readable text block

Tickers are resolved case-insensitively against the issuer's real obligations, so asking for "bigds" finds `$BIGDS`.

## Run it

```bash
npm install
npm run build
npm start                 # Streamable HTTP on http://127.0.0.1:8787/mcp, voice demo on http://127.0.0.1:8787/
npm run stdio             # stdio transport for Claude Desktop / Claude Code / Cursor
npm test                  # 14 unit + end-to-end MCP tests (LIVE=1 adds a mainnet check)
```

**Transport:** Streamable HTTP, MCP protocol **2025-11-25**.

- Stateless: every `POST /mcp` gets a fresh server, so it scales horizontally.
- JSON responses.
- Rate limit: 60 requests per minute per IP.
- Origin allow-list via `ALLOWED_ORIGINS`.
- `GET /health` reports the transport and protocol.

**Docker:**

```bash
docker build -t xrpl-token-guard . && docker run -p 8787:8787 xrpl-token-guard
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{ "mcpServers": { "xrpl-token-guard": { "command": "node", "args": ["/path/to/xrpl-token-guard/dist/stdio.js"] } } }
```

### Configuration

| Env | Default | Meaning |
|---|---|---|
| `XRPL_RPC_URLS` | `https://xrplcluster.com,https://s1.ripple.com:51234,https://s2.ripple.com:51234` | Public XRPL JSON-RPC endpoints, tried in order |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Bind address |
| `ALLOWED_ORIGINS` | (any) | Comma-separated Origin allow-list for `/mcp` |
| `TOKEN_GUARD_LINKS` | `on` | Adds a link to a free ledger-evidence page for the token when one exists; `off` disables it |

## Voice demo (Alexa+-style simulator)

Open `http://127.0.0.1:8787/` and tap the mic (Chrome), or type.

- The page is a small MCP client that speaks Streamable HTTP to `/mcp`. It turns the question into a tool call and reads `spoken_summary` aloud.
- The right-hand panel shows the live `tools/call` request and result.
- `/?demo=1` plays a scripted run with captions, for screen recording.

## How the verdict works

| Severity | Examples | Effect |
|---|---|---|
| ⛔ high | impersonation of an official token, Global Freeze on, issuer doesn't exist, nothing issued | verdict **High risk** |
| ⚠️ caution | issuer can mint / freeze / claw back, >1% transfer fee, one wallet >50% or top 10 >80% (AMM pool excluded), fewer than 25 holders, under 500 XRP of AMM liquidity, issuer under 14 days old, domain doesn't list the issuer | verdict **Caution** |
| ✅ good / ℹ️ info | official issuer, black-holed supply, verified domain, deep liquidity | context only |

Regulated stablecoins (RLUSD, USDC) are expected to keep freeze, clawback and multisig control, so those are reported as information, not warnings. The score (0–100) is a rough guide only. **Not financial advice.** These are ledger facts at the time of the check.

## Built by

Zach Riehn ([Launch Lab](https://cocoeatsai.com/area4/tools/), XRPL tools for people and AI agents). Launch Lab also runs a pay-per-call x402 API (XRP/RLUSD on XRPL, USDC on Base) for deeper wallet and token reports. Token Guard is the free, open core.

MIT licensed.
