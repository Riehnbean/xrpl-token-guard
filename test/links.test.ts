import { test } from "node:test";
import assert from "node:assert/strict";
import { fullReportUrl } from "../src/links.js";
import { checkToken } from "../src/checks.js";
import { tokenText } from "../src/server.js";

test("report previews preserve token identity and isolate wallet fields", () => {
  const token = new URL(fullReportUrl("token", { currency: "A&B", issuer: "rExample", address: "ignore" })!);
  assert.equal(token.searchParams.get("currency"), "A&B");
  assert.equal(token.searchParams.get("issuer"), "rExample");
  assert.equal(token.searchParams.get("kind"), "token");
  assert.equal(token.searchParams.has("address"), false);
  const wallet = new URL(fullReportUrl("wallet", { address: "rExample", currency: "ignore" })!);
  assert.equal(wallet.searchParams.get("kind"), "wallet");
  assert.equal(wallet.searchParams.get("address"), "rExample");
  assert.equal(wallet.searchParams.has("currency"), false);
});

test("token failure result keeps distinct free evidence and paid preview links", async () => {
  const issuer = "rp2DskzVGGz6iDw8ViSVjcMabqJJ2wA2S6";
  const r = await checkToken(async () => { throw new Error("offline fixture"); }, { currency: "USD", issuer }, { linkLookup: async () => "https://example.org/evidence" });
  assert.equal(r.more_info_url, "https://example.org/evidence");
  assert.equal(new URL(r.full_report_url!).searchParams.get("issuer"), issuer);
  assert.match(tokenText(r), /Free ledger evidence: https:\/\/example.org\/evidence/);
  assert.match(tokenText(r), /Full Token Report \(5 XRP; preview before payment\)/);
});
