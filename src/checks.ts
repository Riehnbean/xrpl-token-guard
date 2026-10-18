// The safety checks. Every finding cites the on-ledger fact behind it,
// so an agent (or a voice assistant) can explain *why*, not just say "risky".

import { BLACKHOLE_ADDRESSES, RpcFn, XrplRpcError, isAddress, rippleTimeToDate } from "./xrpl.js";
import { decodeCurrency, encodeCurrency, looksLike, skeleton } from "./currency.js";
import { BRANDS, Brand, brandByIssuer } from "./brands.js";
import { deepReportUrl } from "./links.js";

export type Severity = "high" | "caution" | "good" | "info";
export type Verdict = "high_risk" | "caution" | "no_red_flags" | "not_enough_data";

export interface Finding {
  code: string;
  severity: Severity;
  /** One plain sentence naming the exact ledger fact. */
  message: string;
  /** Short version for text-to-speech. */
  spoken: string;
}

export interface TokenReport {
  verdict: Verdict;
  verdict_label: string;
  score: number;
  token: { ticker: string; currency_code: string; issuer: string };
  spoken_summary: string;
  reasons: Finding[];
  findings: Finding[];
  facts: Record<string, unknown>;
  more_info_url: string | null;
  checked_at: string;
  ledger_index: number | null;
  disclaimer: string;
}

const LABELS: Record<Verdict, string> = {
  high_risk: "High risk",
  caution: "Caution",
  no_red_flags: "No red flags found",
  not_enough_data: "Not enough data",
};
export const DISCLAIMER = "Not a promise and not financial advice. Read-only ledger facts at the time of the check. Check before you buy.";
const ORDER: Record<Severity, number> = { high: 0, caution: 1, good: 2, info: 3 };

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmt = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} billion` : n >= 1e6 ? `${(n / 1e6).toFixed(2)} million` : n >= 1e3 ? `${Math.round(n).toLocaleString("en-US")}` : `${+n.toFixed(2)}`);
const pct = (x: number) => `${Math.round(x * 100)}%`;

async function settle<T>(p: Promise<T>): Promise<{ ok: true; v: T } | { ok: false; e: unknown }> {
  try {
    return { ok: true, v: await p };
  } catch (e) {
    return { ok: false, e };
  }
}

/** Check that the issuer is listed in its domain's xrp-ledger.toml. */
export async function verifyToml(domain: string, issuer: string, timeoutMs = 5000): Promise<"verified" | "not_listed" | "unreachable"> {
  const host = domain.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").trim();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return "unreachable";
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://${host}/.well-known/xrp-ledger.toml`, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) return "unreachable";
    const text = (await res.text()).slice(0, 200_000);
    return text.includes(issuer) ? "verified" : "not_listed";
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(t);
  }
}

export interface CheckOptions {
  maxLinePages?: number;
  tomlCheck?: (domain: string, issuer: string) => Promise<"verified" | "not_listed" | "unreachable">;
  now?: Date;
  linkLookup?: (ticker: string, issuer: string) => Promise<string | null>;
}

export function findBrandImitated(ticker: string): Brand | undefined {
  return BRANDS.find((b) => looksLike(ticker, b.ticker));
}

export async function checkToken(rpc: RpcFn, input: { currency: string; issuer: string }, opts: CheckOptions = {}): Promise<TokenReport> {
  const issuer = input.issuer.trim();
  if (!isAddress(issuer)) throw new Error(`"${input.issuer}" is not a valid XRPL address (it should start with r).`);
  let code = encodeCurrency(input.currency.trim());
  let ticker = decodeCurrency(code);
  const now = opts.now ?? new Date();
  const findings: Finding[] = [];
  const facts: Record<string, unknown> = {};
  const add = (f: Finding) => findings.push(f);

  // 0. Resolve the exact on-ledger code: tickers are case-sensitive on XRPL, and people say
  //    "bigds" when the token is "$BIGDS". Match the issuer's real obligations first.
  const [infoR, gwR] = await Promise.all([
    settle(rpc("account_info", { account: issuer, signer_lists: true })),
    settle(rpc("gateway_balances", { account: issuer })),
  ]);
  if (gwR.ok && gwR.v.obligations && !gwR.v.obligations[code]) {
    const norm = (t: string) => t.toUpperCase().replace(/^\$/, "");
    const hit = Object.keys(gwR.v.obligations).find((k) => norm(decodeCurrency(k)) === norm(ticker));
    if (hit) {
      code = hit;
      ticker = decodeCurrency(hit);
    }
  }

  // 1. Impersonation: a famous name with the wrong issuer.
  const imitated = findBrandImitated(ticker);
  const officialBrand = brandByIssuer(issuer);
  const wrapped = imitated && imitated.issuer !== issuer && /^[^.]+\.[A-Za-z0-9]{1,8}$/.test(ticker) && skeleton(ticker.split(".")[0]) === skeleton(imitated.ticker);
  if (imitated && imitated.issuer !== issuer && wrapped) {
    add({
      code: "NOT_OFFICIAL_VARIANT",
      severity: "caution",
      message: `"${ticker}" is a variant of ${imitated.ticker} from a different issuer (${issuer}), not ${imitated.name} itself (official issuer ${imitated.issuer}, ${imitated.domain}). Its value depends on whoever runs this issuer.`,
      spoken: `This isn't ${imitated.name} itself. It's a separate version from another issuer.`,
    });
    facts.variant_of = { ticker: imitated.ticker, official_issuer: imitated.issuer };
  } else if (imitated && imitated.issuer !== issuer) {
    add({
      code: "IMPERSONATION",
      severity: "high",
      message: `The name "${ticker}" imitates ${imitated.name} (${imitated.ticker}), but the real ${imitated.ticker} is issued by ${imitated.issuer} (${imitated.domain}); this token's issuer is ${issuer}.`,
      spoken: `This token calls itself ${ticker}, but it is not the real ${imitated.name}. The real one comes from a different issuer.`,
    });
    facts.imitates = { ticker: imitated.ticker, official_issuer: imitated.issuer, official_domain: imitated.domain };
  } else if (officialBrand && looksLike(ticker, officialBrand.ticker)) {
    add({
      code: "OFFICIAL_ISSUER",
      severity: "good",
      message: `This is the official ${officialBrand.name} issuer (${issuer}, domain ${officialBrand.domain}).`,
      spoken: `This is the real ${officialBrand.name}, from the official issuer.`,
    });
  }

  const [ammR, linesR, txR] = await Promise.all([
    settle(rpc("amm_info", { asset: { currency: "XRP" }, asset2: { currency: code, issuer } })),
    settle(fetchLines(rpc, issuer, code, opts.maxLinePages ?? 5)),
    settle(rpc("account_tx", { account: issuer, forward: true, limit: 1, ledger_index_min: -1, ledger_index_max: -1, ledger_index: undefined })),
  ]);

  let ledgerIndex: number | null = null;
  if (!infoR.ok) {
    const notFound = infoR.e instanceof XrplRpcError && infoR.e.code === "actNotFound";
    if (notFound) {
      add({ code: "ISSUER_NOT_FOUND", severity: "high", message: `No account ${issuer} exists on the XRP Ledger, so this token cannot be real.`, spoken: "The issuer account doesn't exist on the XRP Ledger." });
    }
    return finish({ findings, facts, ticker, code, issuer, ledgerIndex, now, missingCore: !notFound, opts });
  }

  const info = infoR.v;
  ledgerIndex = info.ledger_index ?? null;
  const acct = info.account_data ?? {};
  const f = Number(acct.Flags ?? 0);
  const flags = info.account_flags ?? {disableMasterKey:!!(f&0x100000),noFreeze:!!(f&0x200000),globalFreeze:!!(f&0x400000),allowTrustLineClawback:!!(f&0x80000000),requireAuthorization:!!(f&0x40000),defaultRipple:!!(f&0x800000)};
  const domain = acct.Domain ? Buffer.from(acct.Domain, "hex").toString("utf8") : null;
  const regularKey: string | undefined = acct.RegularKey;
  const signerList = signerListOf(info);
  const brand = officialBrand && !(imitated && imitated.issuer !== issuer) && looksLike(ticker, officialBrand.ticker) ? officialBrand : undefined;

  facts.issuer_domain = domain;
  facts.master_key_disabled = !!flags.disableMasterKey;
  facts.regular_key = regularKey ?? null;
  facts.signer_list = signerList ? { signers: signerList.SignerEntries?.length ?? 0, quorum: signerList.SignerQuorum } : null;
  facts.flags = { globalFreeze: !!flags.globalFreeze, noFreeze: !!flags.noFreeze, allowTrustLineClawback: !!flags.allowTrustLineClawback, requireAuthorization: !!flags.requireAuthorization, defaultRipple: !!flags.defaultRipple };

  // 2. Supply
  const supplyStr = gwR.ok ? gwR.v.obligations?.[code] : undefined;
  const supply = supplyStr ? Number(supplyStr) : 0;
  facts.total_supply = supplyStr ?? (gwR.ok ? "0" : null);
  if (gwR.ok && !supplyStr) {
    add({ code: "NO_SUPPLY", severity: "high", message: `Issuer ${issuer} has no ${ticker} in circulation, so there is nothing real to buy under this name.`, spoken: `This issuer hasn't issued any ${ticker}.` });
  } else if (supply > 0) {
    add({ code: "SUPPLY", severity: "info", message: `${fmt(supply)} ${ticker} are in circulation.`, spoken: `About ${fmt(supply)} tokens exist.` });
  }

  // 3. Freeze switch
  if (flags.globalFreeze) {
    add({ code: "GLOBAL_FREEZE", severity: "high", message: `The issuer has Global Freeze switched on: ${ticker} cannot be sent or traded right now.`, spoken: "The issuer has frozen this token. Nobody can move it right now." });
  }

  // 4. Who controls the issuer?
  const keyBlackholed = regularKey === "rrrrrrrrrrrrrrrrrrrrBZbvji";
  const blackholed = !!flags.disableMasterKey && keyBlackholed && !signerList;
  facts.blackholed = blackholed;
  facts.freeze_control_pass = !!flags.noFreeze || blackholed;
  facts.issuer_controls_pass = (!!flags.noFreeze || blackholed) && !flags.allowTrustLineClawback && !flags.globalFreeze;
  facts.issuer_control_rule = "NoFreeze OR (master disabled AND RegularKey rrrrrrrrrrrrrrrrrrrrBZbvji AND no signer list); clawback and active global freeze fail. NoFreeze alone does not remove minting or global-freeze powers.";
  if (blackholed) {
    const sev: Severity = imitated && imitated.issuer !== issuer ? "info" : "good";
    add({
      code: "SUPPLY_LOCKED",
      severity: sev,
      message: `The issuer's master key is disabled${regularKey ? ` and its regular key is the black-hole address ${regularKey}` : " with no regular key"}, so nobody can mint more ${ticker} or change its settings.${sev === "info" ? " Locked supply does not make an imitation genuine." : ""}`,
      spoken: sev === "info" ? "Its supply is locked, but that doesn't make a copy real." : "The issuer is black-holed, so no one can mint more.",
    });
  } else if (brand?.regulated) {
    add({ code: "CONTROLLED_ISSUER", severity: "info", message: `${brand.name} keeps an active, controlled issuer${signerList ? ` (multisig: ${facts.signer_list && (facts.signer_list as any).signers} signers)` : ""}, which is expected for a regulated stablecoin.`, spoken: "As a regulated stablecoin, its issuer stays in control, which is normal." });
  } else {
    const how = signerList ? `a multisig of ${signerList.SignerEntries?.length ?? "?"} signers` : flags.disableMasterKey ? `the regular key ${regularKey}` : "its master key";
    add({ code: "ISSUER_CAN_MINT", severity: "caution", message: `The issuer is still controlled by ${how}, so it can mint more ${ticker} or change token settings at any time.`, spoken: "The issuer can still mint more tokens whenever it wants." });
  }

  // 5. Holder-level powers
  if (flags.allowTrustLineClawback) {
    add({ code: "CLAWBACK", severity: "high", message: `Clawback permission is enabled: this fails the issuer-control policy, including for regulated issuers. It does not imply impersonation.`, spoken: "Clawback is enabled and fails this control policy." });
  }
  if (!flags.noFreeze && !blackholed) {
    add({ code: "CAN_FREEZE", severity: "caution", message: `The issuer has not given up its freeze power (No Freeze is off), so it can freeze holders' ${ticker} trust lines.`, spoken: "The issuer can freeze holders' tokens." });
  }
  if (flags.requireAuthorization) add({ code: "REQUIRE_AUTH", severity: "info", message: "Holders must be approved by the issuer before they can hold this token.", spoken: "Holders need the issuer's approval." });

  const rate = acct.TransferRate ? acct.TransferRate / 1e9 - 1 : 0;
  facts.transfer_fee = rate;
  if (rate > 0.01) add({ code: "TRANSFER_FEE", severity: "caution", message: `Every transfer of ${ticker} burns a ${pct(rate)} issuer fee (TransferRate).`, spoken: `There's a ${pct(rate)} fee on every transfer.` });
  else if (rate > 0) add({ code: "SMALL_TRANSFER_FEE", severity: "info", message: `Transfers carry a ${(rate * 100).toFixed(2)}% issuer fee.`, spoken: "There's a small transfer fee." });

  // 6. Domain proof
  if (domain && !brand) {
    const toml = await (opts.tomlCheck ?? verifyToml)(domain, issuer);
    facts.domain_toml = toml;
    const launchpad = /(^|\.)firstledger\.net$/i.test(domain.replace(/^https?:\/\//i, "").replace(/\/.*$/, ""));
    if (toml === "verified" && launchpad) add({ code: "LAUNCHPAD_DOMAIN", severity: "info", message: `The issuer's domain ${domain} is a launchpad-hosted page that lists it; that confirms the launchpad, not a project website.`, spoken: "It was made on a launchpad, with no project website of its own." });
    else if (toml === "verified") add({ code: "DOMAIN_VERIFIED", severity: "good", message: `The issuer's domain ${domain} lists this issuer in its xrp-ledger.toml file.`, spoken: "Its website confirms this issuer." });
    else if (toml === "not_listed") add({ code: "DOMAIN_UNVERIFIED", severity: "caution", message: `The issuer points to ${domain}, but that site's xrp-ledger.toml does not list ${issuer}.`, spoken: "The website it claims doesn't confirm it." });
    else add({ code: "DOMAIN_UNCHECKED", severity: "info", message: `The issuer points to ${domain}; its xrp-ledger.toml could not be reached to confirm it.`, spoken: "I couldn't confirm its website." });
  } else if (!domain && !brand) {
    add({ code: "NO_DOMAIN", severity: "info", message: "The issuer has no domain set, so there is no on-ledger link to a project website.", spoken: "It has no website linked on the ledger." });
  }

  // 7. Liquidity (first, so the AMM pool's own balance isn't mistaken for a whale)
  const ammAccount: string | undefined = ammR.ok ? ammR.v.amm?.account : undefined;
  if (ammR.ok && ammR.v.amm) {
    const xrp = Number(ammR.v.amm.amount) / 1e6;
    facts.amm = { account: ammR.v.amm.account, xrp_liquidity: xrp, frozen: !!ammR.v.amm.asset2_frozen };
    if (xrp < 500) add({ code: "THIN_LIQUIDITY", severity: "caution", message: `Its XRP AMM pool holds only ${fmt(xrp)} XRP, so selling even a small amount will move the price a lot.`, spoken: `Its trading pool is tiny, about ${fmt(xrp)} XRP.` });
    else add({ code: "LIQUIDITY", severity: "good", message: `Its XRP AMM pool holds about ${fmt(xrp)} XRP of liquidity.`, spoken: `It has a trading pool with about ${fmt(xrp)} XRP.` });
  } else if (ammR.ok || (ammR as any).e?.code === "actNotFound") {
    facts.amm = null;
    add({ code: "NO_AMM", severity: "info", message: `No XRP/${ticker} AMM pool exists; it can only trade on the order book, if at all.`, spoken: "There's no XRP trading pool for it." });
  }

  // 8. Holders and concentration (the AMM pool account is excluded: it belongs to all liquidity providers)
  if (linesR.ok) {
    const { complete } = linesR.v;
    const all = linesR.v.holders;
    const pool = all.find((h) => h.account === ammAccount);
    const holders = all.filter((h) => h.account !== ammAccount);
    facts.holders = complete ? holders.length : `${holders.length}+`;
    if (complete && supply > 0 && pool) facts.amm_pool_share = +(pool.bal / supply).toFixed(4);
    if (complete && supply > 0 && holders.length > 0) {
      const sorted = holders.map((h) => h.bal).sort((a, b) => b - a);
      const top1 = sorted[0] / supply;
      const top10 = sorted.slice(0, 10).reduce((s, x) => s + x, 0) / supply;
      facts.top_holder_share = +top1.toFixed(4);
      facts.top10_share = +top10.toFixed(4);
      if (top1 > 0.5) add({ code: "WHALE", severity: "caution", message: `One wallet (${holders.find((h) => h.bal === sorted[0])?.account}) holds ${pct(top1)} of all ${ticker}, not counting the AMM pool (${holders.length} holders in total).`, spoken: `One wallet holds ${pct(top1)} of the supply.` });
      else if (top10 > 0.8) add({ code: "CONCENTRATED", severity: "caution", message: `The top 10 wallets hold ${pct(top10)} of all ${ticker}, not counting the AMM pool (${holders.length} holders in total).`, spoken: `Ten wallets hold ${pct(top10)} of the supply.` });
      else add({ code: "DISTRIBUTION", severity: "info", message: `${holders.length} holders; the top 10 hold ${pct(top10)} of the supply (AMM pool excluded).`, spoken: `It has ${holders.length} holders.` });
      if (holders.length < 25 && !brand) add({ code: "FEW_HOLDERS", severity: "caution", message: `Only ${holders.length} wallets hold ${ticker}.`, spoken: `Only ${holders.length} wallets hold it.` });
    } else if (!complete) {
      add({ code: "MANY_HOLDERS", severity: "info", message: `More than ${holders.length} trust lines hold ${ticker}.`, spoken: "It has many holders." });
    }
  }

  // 9. Age of the issuer
  if (txR.ok) {
    const first = txR.v.transactions?.[0];
    const date = first?.tx?.date ?? first?.tx_json?.date;
    if (typeof date === "number") {
      const created = rippleTimeToDate(date);
      const days = Math.floor((now.getTime() - created.getTime()) / 86_400_000);
      facts.issuer_age_days = days;
      if (days < 14 && !brand) add({ code: "NEW_ISSUER", severity: "caution", message: `The issuer account is only ${days} day${days === 1 ? "" : "s"} old (first activity ${created.toISOString().slice(0, 10)}).`, spoken: `The issuer is brand new, only ${days} days old.` });
    }
  }

  return finish({ findings, facts, ticker, code, issuer, ledgerIndex, now, missingCore: false, opts });
}

/** account_info with signer_lists:true puts the list at result level (API v2) or inside account_data (API v1). */
function signerListOf(info: any): any | undefined {
  const lists = info?.signer_lists ?? info?.account_data?.signer_lists ?? [];
  return lists[0];
}

async function fetchLines(rpc: RpcFn, issuer: string, code: string, maxPages: number) {
  const holders: { account: string; bal: number }[] = [];
  let marker: unknown;
  for (let page = 0; page < maxPages; page++) {
    const r = await rpc("account_lines", { account: issuer, limit: 400, ...(marker ? { marker } : {}) });
    for (const l of r.lines ?? []) {
      if (l.currency !== code) continue;
      const bal = -Number(l.balance); // issuer's view: holders' balances are negative
      if (bal > 0) holders.push({ account: l.account, bal });
    }
    marker = r.marker;
    if (!marker) return { holders, complete: true };
  }
  return { holders, complete: false };
}

async function finish(a: { findings: Finding[]; facts: Record<string, unknown>; ticker: string; code: string; issuer: string; ledgerIndex: number | null; now: Date; missingCore: boolean; opts: CheckOptions }): Promise<TokenReport> {
  const sorted = [...a.findings].sort((x, y) => ORDER[x.severity] - ORDER[y.severity]);
  const highs = sorted.filter((f) => f.severity === "high");
  const cautions = sorted.filter((f) => f.severity === "caution");
  const goods = sorted.filter((f) => f.severity === "good");
  const verdict: Verdict = highs.length ? "high_risk" : a.missingCore ? "not_enough_data" : cautions.length ? "caution" : "no_red_flags";
  const score = verdict === "not_enough_data" ? 0 : Math.max(0, Math.min(highs.length ? 35 : 100, 100 - 60 * highs.length - 12 * cautions.length));
  // Reasons explain the verdict: for a bad verdict show only the problems (never a green tick next to a fake).
  const reasons = (verdict === "no_red_flags" ? [...goods, ...sorted.filter((f) => f.severity === "info")] : verdict === "not_enough_data" ? sorted : [...highs, ...cautions]).slice(0, 3);

  let spoken: string;
  if (verdict === "high_risk") spoken = `Warning, high risk. ${highs[0].spoken}${highs[1] ? " " + highs[1].spoken : ""} I would not buy it.`;
  else if (verdict === "caution") spoken = `Caution. ${cautions.slice(0, 2).map((c) => c.spoken).join(" ")}`;
  else if (verdict === "no_red_flags") spoken = `No red flags found. ${(goods[0] ?? sorted[0])?.spoken ?? ""} That's not a promise, so still check before you buy.`;
  else spoken = "I couldn't read enough from the XRP Ledger to judge this token. Please try again in a minute.";

  const lookup = a.opts.linkLookup ?? deepReportUrl;
  let url: string | null = null;
  try {
    url = await lookup(a.ticker, a.issuer);
  } catch {
    url = null;
  }

  return {
    verdict,
    verdict_label: LABELS[verdict],
    score,
    token: { ticker: a.ticker, currency_code: a.code, issuer: a.issuer },
    spoken_summary: spoken.replace(/\s+/g, " ").trim(),
    reasons,
    findings: sorted,
    facts: a.facts,
    more_info_url: url,
    checked_at: a.now.toISOString(),
    ledger_index: a.ledgerIndex,
    disclaimer: DISCLAIMER,
  };
}

// ---------------------------------------------------------------------------
// Is it the real one?

export interface RealCheck {
  ticker: string;
  known_brand: boolean;
  official: { name: string; ticker: string; issuer: string; domain: string } | null;
  is_official: boolean | null;
  spoken_summary: string;
  message: string;
}

export function isItReal(ticker: string, issuer?: string): RealCheck {
  const brand = findBrandImitated(ticker);
  if (!brand) {
    return {
      ticker,
      known_brand: false,
      official: null,
      is_official: null,
      message: `"${ticker}" is not on the built-in list of verified XRPL brands (${BRANDS.map((b) => b.ticker).join(", ")}). Run check_token_safety with its issuer for a full check.`,
      spoken_summary: `I don't have an official issuer on file for ${ticker}. Give me its issuer address and I'll run a full safety check.`,
    };
  }
  const official = { name: brand.name, ticker: brand.ticker, issuer: brand.issuer, domain: brand.domain };
  if (!issuer) {
    return { ticker, known_brand: true, official, is_official: null, message: `The official ${brand.ticker} is issued by ${brand.issuer} (${brand.domain}). Any other issuer using this name is an imitation.`, spoken_summary: `The real ${brand.name} comes from one issuer only, ending in ${brand.issuer.slice(-4)}, run by ${brand.domain}. Anything else with that name is a copy.` };
  }
  const match = issuer.trim() === brand.issuer;
  return {
    ticker,
    known_brand: true,
    official,
    is_official: match,
    message: match ? `Yes: ${issuer} is the official ${brand.name} issuer (${brand.domain}).` : `No: ${issuer} is not the official ${brand.ticker} issuer. The real one is ${brand.issuer} (${brand.domain}).`,
    spoken_summary: match ? `Yes, that's the real ${brand.name}.` : `No. That is not the real ${brand.name}. It's an imitation from a different issuer.`,
  };
}

// ---------------------------------------------------------------------------
// Wallet security: catches the classic drainer setups (a stranger's regular key or signer list).

export interface WalletReport {
  verdict: Verdict;
  verdict_label: string;
  address: string;
  spoken_summary: string;
  findings: Finding[];
  facts: Record<string, unknown>;
  checked_at: string;
  disclaimer: string;
}

export async function checkWallet(rpc: RpcFn, address: string, opts: { now?: Date } = {}): Promise<WalletReport> {
  const addr = address.trim();
  if (!isAddress(addr)) throw new Error(`"${address}" is not a valid XRPL address (it should start with r).`);
  const now = opts.now ?? new Date();
  const findings: Finding[] = [];
  const facts: Record<string, unknown> = {};
  const [infoR, txR] = await Promise.all([
    settle(rpc("account_info", { account: addr, signer_lists: true })),
    settle(rpc("account_tx", { account: addr, limit: 50, ledger_index: undefined, ledger_index_min: -1, ledger_index_max: -1 })),
  ]);
  const done = (verdict: Verdict, spoken: string): WalletReport => ({
    verdict,
    verdict_label: LABELS[verdict],
    address: addr,
    spoken_summary: spoken,
    findings: findings.sort((x, y) => ORDER[x.severity] - ORDER[y.severity]),
    facts,
    checked_at: now.toISOString(),
    disclaimer: DISCLAIMER,
  });
  if (!infoR.ok) {
    if (infoR.e instanceof XrplRpcError && infoR.e.code === "actNotFound") {
      findings.push({ code: "NOT_ACTIVATED", severity: "info", message: `${addr} is not activated on the XRP Ledger yet (it has never received the XRP reserve).`, spoken: "This wallet isn't activated yet." });
      return done("no_red_flags", "This wallet isn't activated yet, so there's nothing to check.");
    }
    return done("not_enough_data", "I couldn't read this wallet from the XRP Ledger right now.");
  }
  const acct = infoR.v.account_data ?? {};
  const flags = infoR.v.account_flags ?? {};
  facts.xrp_balance = Number(acct.Balance ?? 0) / 1e6;
  facts.owner_count = acct.OwnerCount ?? 0;
  facts.regular_key = acct.RegularKey ?? null;
  facts.master_key_disabled = !!flags.disableMasterKey;

  const recent = new Map<string, Date>();
  if (txR.ok) {
    for (const t of txR.v.transactions ?? []) {
      const tx = t.tx ?? t.tx_json ?? {};
      if ((tx.TransactionType === "SetRegularKey" || tx.TransactionType === "SignerListSet") && tx.Account === addr && typeof tx.date === "number") {
        const d = rippleTimeToDate(tx.date);
        if (!recent.has(tx.TransactionType)) recent.set(tx.TransactionType, d);
      }
    }
  }
  const daysAgo = (d?: Date) => (d ? Math.floor((now.getTime() - d.getTime()) / 86_400_000) : null);

  if (acct.RegularKey && !BLACKHOLE_ADDRESSES.has(acct.RegularKey)) {
    const age = daysAgo(recent.get("SetRegularKey"));
    const isRecent = age !== null && age <= 7;
    findings.push({
      code: isRecent ? "RECENT_REGULAR_KEY" : "REGULAR_KEY_SET",
      severity: isRecent ? "high" : "caution",
      message: `Another key (${acct.RegularKey}) can sign transactions for this wallet${isRecent ? `; it was set ${age} day${age === 1 ? "" : "s"} ago` : ""}. If you didn't set it, someone else can empty this wallet.`,
      spoken: isRecent ? "Someone added a new key that can control this wallet in the last week. If that wasn't you, move your funds now." : "A second key can sign for this wallet. Make sure it's yours.",
    });
  }
  const sl = signerListOf(infoR.v);
  if (sl) {
    const age = daysAgo(recent.get("SignerListSet"));
    const isRecent = age !== null && age <= 7;
    facts.signer_list = { signers: sl.SignerEntries?.length ?? 0, quorum: sl.SignerQuorum };
    findings.push({
      code: isRecent ? "RECENT_SIGNER_LIST" : "SIGNER_LIST",
      severity: isRecent ? "high" : "caution",
      message: `A multisig signer list (${sl.SignerEntries?.length ?? "?"} signers, quorum ${sl.SignerQuorum}) can sign for this wallet${isRecent ? `; it was set ${age} day${age === 1 ? "" : "s"} ago` : ""}.`,
      spoken: isRecent ? "A new group of signers was added to this wallet in the last week. If that wasn't you, act now." : "A group of other signers can control this wallet. Make sure you know them.",
    });
  }
  if (flags.disableMasterKey && !acct.RegularKey && !sl) {
    findings.push({ code: "LOCKED", severity: "info", message: "The master key is disabled and no other key can sign: this wallet is permanently locked.", spoken: "This wallet is permanently locked. No one can move its funds." });
  } else if (flags.disableMasterKey) {
    findings.push({ code: "MASTER_DISABLED", severity: "info", message: "The master key is disabled; only the regular key or signer list can sign.", spoken: "The original key is turned off." });
  }
  if (flags.requireDestinationTag) findings.push({ code: "DEST_TAG", severity: "info", message: "Payments to this wallet require a destination tag (typical for exchanges).", spoken: "Payments here need a destination tag." });
  if (flags.depositAuth) findings.push({ code: "DEPOSIT_AUTH", severity: "info", message: "Deposit Authorization is on: only pre-approved senders can pay this wallet.", spoken: "Only approved senders can pay this wallet." });

  const highs = findings.filter((f) => f.severity === "high");
  const cautions = findings.filter((f) => f.severity === "caution");
  if (highs.length) return done("high_risk", `Warning. ${highs[0].spoken}`);
  if (cautions.length) return done("caution", `Caution. ${cautions[0].spoken}`);
  findings.push({ code: "ONLY_MASTER_KEY", severity: "good", message: "Only this wallet's own master key can sign for it: no extra keys or signer lists.", spoken: "Only your own key controls this wallet." });
  return done("no_red_flags", "No red flags found. Only your own key controls this wallet.");
}

export { short };
