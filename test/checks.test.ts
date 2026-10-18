import { test } from "node:test";
import assert from "node:assert/strict";
import { checkToken, checkWallet, isItReal } from "../src/checks.js";
import { decodeCurrency, encodeCurrency, looksLike } from "../src/currency.js";
import { XrplRpcError, RpcFn } from "../src/xrpl.js";

const RLUSD_HEX = "524C555344000000000000000000000000000000";
const REAL = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const FAKE = "rp2DskzVGGz6iDw8ViSVjcMabqJJ2wA2S6";
const MEME = "rhCAT4hRdi2Y9puNdkpMzxrdKa5wkppR62";
const now = new Date("2026-10-17T12:00:00Z");
const noLinks = { linkLookup: async () => null, tomlCheck: async () => "verified" as const, now };

/** Build a fake XRPL RPC from a table of canned responses. */
function mockRpc(table: Record<string, (p: any) => any>): RpcFn {
  return async (method, params) => {
    const fn = table[method];
    if (!fn) throw new XrplRpcError("not mocked", "unknownCmd");
    const r = fn(params);
    if (r instanceof Error) throw r;
    return r;
  };
}

const blackholed = (domainHex = "") => ({
  ledger_index: 1,
  account_data: { Domain: domainHex || undefined, RegularKey: "rrrrrrrrrrrrrrrrrrrrBZbvji" },
  account_flags: { disableMasterKey: true, noFreeze: false, globalFreeze: false, allowTrustLineClawback: false },
});

test("currency helpers", () => {
  assert.equal(encodeCurrency("RLUSD"), RLUSD_HEX);
  assert.equal(decodeCurrency(RLUSD_HEX), "RLUSD");
  assert.equal(encodeCurrency("USD"), "USD");
  assert.ok(looksLike("RLU$D", "RLUSD"));
  assert.ok(looksLike("R1USD", "RLUSD"));
  assert.ok(looksLike("RLUSD2", "RLUSD"));
  assert.ok(!looksLike("USDT", "USDC"), "USDT is its own brand, not a USDC look-alike");
  assert.ok(!looksLike("SOLAR", "SOLO"));
});

test("a blackholed fake RLUSD is still HIGH RISK (locked supply doesn't make a copy real)", async () => {
  const rpc = mockRpc({
    account_info: () => blackholed(),
    gateway_balances: () => ({ obligations: { [RLUSD_HEX]: "1000000" } }),
    amm_info: () => ({ amm: { account: "rAMM", amount: "900000000", asset2_frozen: false } }),
    account_lines: () => ({ lines: [{ account: "rA", currency: RLUSD_HEX, balance: "-600000" }, { account: "rAMM", currency: RLUSD_HEX, balance: "-400000" }] }),
    account_tx: () => ({ transactions: [] }),
  });
  const r = await checkToken(rpc, { currency: "RLUSD", issuer: FAKE }, noLinks);
  assert.equal(r.verdict, "high_risk");
  assert.equal(r.reasons[0].code, "IMPERSONATION");
  assert.match(r.spoken_summary, /not the real Ripple USD/);
  assert.equal(r.findings.find((f) => f.code === "SUPPLY_LOCKED")?.severity, "info");
});

test("official RLUSD identity remains true but clawback fails control policy", async () => {
  const rpc = mockRpc({
    account_info: () => ({
      ledger_index: 1,
      account_data: {},
      account_flags: { disableMasterKey: true, allowTrustLineClawback: true },
      signer_lists: [{ SignerEntries: [{}, {}, {}], SignerQuorum: 2 }],
    }),
    gateway_balances: () => ({ obligations: { [RLUSD_HEX]: "1000000000" } }),
    amm_info: () => ({ amm: { account: "rAMM", amount: "1800000000000" } }),
    account_lines: () => ({ lines: [], marker: "more" }),
    account_tx: () => ({ transactions: [] }),
  });
  const r = await checkToken(rpc, { currency: "rlusd", issuer: REAL }, noLinks);
  assert.equal(r.verdict, "high_risk");
  assert.ok(r.findings.some((f) => f.code === "OFFICIAL_ISSUER"));
  assert.ok(r.findings.some((f) => f.code === "CONTROLLED_ISSUER"));
  assert.ok(!r.findings.some((f) => f.code === "SUPPLY_LOCKED"), "a multisig issuer is not black-holed");
});

test("an unknown issuer that can mint, freeze and claw back gets HIGH RISK with reasons", async () => {
  const rpc = mockRpc({
    account_info: () => ({ ledger_index: 1, account_data: { TransferRate: 1050000000 }, account_flags: { allowTrustLineClawback: true } }),
    gateway_balances: () => ({ obligations: { MEW: "5000" } }),
    amm_info: () => new XrplRpcError("Account not found.", "actNotFound"),
    account_lines: () => ({ lines: Array.from({ length: 30 }, (_, i) => ({ account: `r${i}`, currency: "MEW", balance: "-100" })) }),
    account_tx: () => ({ transactions: [{ tx: { date: (now.getTime() / 1000 - 946684800) - 2 * 86400 } }] }),
  });
  const r = await checkToken(rpc, { currency: "MEW", issuer: MEME }, noLinks);
  assert.equal(r.verdict, "high_risk");
  const codes = r.findings.map((f) => f.code);
  for (const c of ["ISSUER_CAN_MINT", "CLAWBACK", "CAN_FREEZE", "TRANSFER_FEE", "NEW_ISSUER", "NO_AMM"]) assert.ok(codes.includes(c), c);
  assert.ok(r.score < 60);
});

test("case-insensitive ticker resolution finds '$BIGDS' from 'bigds'", async () => {
  const hex = encodeCurrency("$BIGDS");
  const rpc = mockRpc({
    account_info: () => blackholed(),
    gateway_balances: () => ({ obligations: { [hex]: "1000" } }),
    amm_info: (p) => (p.asset2.currency === hex ? { amm: { account: "rAMM", amount: "100000000000" } } : new XrplRpcError("x", "actNotFound")),
    account_lines: () => ({ lines: Array.from({ length: 40 }, (_, i) => ({ account: `r${i}`, currency: hex, balance: "-25" })) }),
    account_tx: () => ({ transactions: [] }),
  });
  const r = await checkToken(rpc, { currency: "bigds", issuer: MEME }, noLinks);
  assert.equal(r.token.ticker, "$BIGDS");
  assert.equal(r.verdict, "no_red_flags");
});

test("the AMM pool's balance is not counted as a whale", async () => {
  const rpc = mockRpc({
    account_info: () => blackholed(),
    gateway_balances: () => ({ obligations: { CAT: "1000" } }),
    amm_info: () => ({ amm: { account: "rPOOL", amount: "5000000000" } }),
    account_lines: () => ({ lines: [{ account: "rPOOL", currency: "CAT", balance: "-900" }, ...Array.from({ length: 50 }, (_, i) => ({ account: `r${i}`, currency: "CAT", balance: "-2" }))] }),
    account_tx: () => ({ transactions: [] }),
  });
  const r = await checkToken(rpc, { currency: "CAT", issuer: MEME }, noLinks);
  assert.ok(!r.findings.some((f) => f.code === "WHALE" || f.code === "CONCENTRATED"));
});

test("global freeze and a missing issuer are HIGH RISK; RPC outage is NOT ENOUGH DATA", async () => {
  const frozen = mockRpc({
    account_info: () => ({ ledger_index: 1, account_data: {}, account_flags: { globalFreeze: true } }),
    gateway_balances: () => ({ obligations: { ABC: "10" } }),
    amm_info: () => new XrplRpcError("x", "actNotFound"),
    account_lines: () => ({ lines: [] }),
    account_tx: () => ({ transactions: [] }),
  });
  assert.equal((await checkToken(frozen, { currency: "ABC", issuer: MEME }, noLinks)).verdict, "high_risk");

  const missing = mockRpc({ account_info: () => new XrplRpcError("Account not found.", "actNotFound"), gateway_balances: () => new XrplRpcError("Account not found.", "actNotFound") });
  const m = await checkToken(missing, { currency: "ABC", issuer: MEME }, noLinks);
  assert.equal(m.verdict, "high_risk");
  assert.equal(m.reasons[0].code, "ISSUER_NOT_FOUND");

  const down = mockRpc({ account_info: () => new XrplRpcError("All XRPL endpoints failed") , gateway_balances: () => new XrplRpcError("All XRPL endpoints failed") });
  assert.equal((await checkToken(down, { currency: "ABC", issuer: MEME }, noLinks)).verdict, "not_enough_data");
});

test("invalid addresses are rejected before any network call", async () => {
  await assert.rejects(() => checkToken(mockRpc({}), { currency: "X", issuer: "not-an-address" }), /not a valid XRPL address/);
});

test("is_it_the_real_token", () => {
  assert.equal(isItReal("RLUSD").official?.issuer, REAL);
  assert.equal(isItReal("RLUSD", REAL).is_official, true);
  assert.equal(isItReal("rlu$d", FAKE).is_official, false);
  assert.equal(isItReal("DOGE").known_brand, false);
});

test("wallet: a regular key added 2 days ago is HIGH RISK (drainer pattern)", async () => {
  const rpc = mockRpc({
    account_info: () => ({ account_data: { Balance: "25000000", RegularKey: "rStrangerKey1111111111111111111" }, account_flags: {} }),
    account_tx: () => ({ transactions: [{ tx: { TransactionType: "SetRegularKey", Account: MEME, date: now.getTime() / 1000 - 946684800 - 2 * 86400 } }] }),
  });
  const r = await checkWallet(rpc, MEME, { now });
  assert.equal(r.verdict, "high_risk");
  assert.equal(r.findings[0].code, "RECENT_REGULAR_KEY");
});

test("wallet: master key only is clean", async () => {
  const rpc = mockRpc({ account_info: () => ({ account_data: { Balance: "25000000" }, account_flags: {} }), account_tx: () => ({ transactions: [] }) });
  const r = await checkWallet(rpc, MEME, { now });
  assert.equal(r.verdict, "no_red_flags");
});

for (const [label, flags, key, lists, pass] of [
  ["exact blackhole", {disableMasterKey:true}, "rrrrrrrrrrrrrrrrrrrrBZbvji", [], true],
  ["NoFreeze active issuer", {noFreeze:true}, undefined, [], true],
  ["missing key", {disableMasterKey:true}, undefined, [], false],
  ["other sink", {disableMasterKey:true}, "rrrrrrrrrrrrrrrrrrrrrhoLvTp", [], false],
  ["master enabled", {}, "rrrrrrrrrrrrrrrrrrrrBZbvji", [], false],
  ["multisig", {disableMasterKey:true}, "rrrrrrrrrrrrrrrrrrrrBZbvji", [{SignerQuorum:1}], false],
  ["clawback overrides NoFreeze", {noFreeze:true,allowTrustLineClawback:true}, undefined, [], false],
  ["clawback overrides blackhole", {disableMasterKey:true,allowTrustLineClawback:true}, "rrrrrrrrrrrrrrrrrrrrBZbvji", [], false],
  ["global freeze", {noFreeze:true,globalFreeze:true}, undefined, [], false],
] as const) test(`issuer control policy: ${label}`, async () => {
  const rpc = mockRpc({account_info:()=>({account_data:{RegularKey:key},account_flags:flags,signer_lists:lists}),gateway_balances:()=>({obligations:{CAT:"1000"}}),amm_info:()=>({}),account_lines:()=>({lines:[]}),account_tx:()=>({transactions:[]})});
  const r=await checkToken(rpc,{currency:"CAT",issuer:MEME},noLinks);
  assert.equal(r.facts.issuer_controls_pass,pass);
  if ('allowTrustLineClawback' in flags) assert.equal(r.verdict,'high_risk');
});
