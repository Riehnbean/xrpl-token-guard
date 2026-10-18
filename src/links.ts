// Optional "more info" link: Launch Lab publishes a free ledger-evidence page for
// ~2,000 XRPL tokens. Set TOKEN_GUARD_LINKS=off to disable, or point
// TOKEN_GUARD_SITEMAP at another sitemap index with the same slug format
// (<ticker>-<first 8 chars of issuer>-<hash>).

const SITEMAP = process.env.TOKEN_GUARD_SITEMAP ?? "https://cocoeatsai.com/area4/token/sitemap.xml";
const FALLBACK = process.env.TOKEN_GUARD_FALLBACK_URL ?? "https://cocoeatsai.com/area4/tools/";
const ENABLED = (process.env.TOKEN_GUARD_LINKS ?? "on") !== "off";
const TTL_MS = 24 * 3600 * 1000;

let cache: { at: number; urls: string[] } | null = null;
let inflight: Promise<string[]> | null = null;

async function get(url: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());

async function loadUrls(): Promise<string[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.urls;
  if (!inflight) {
    inflight = (async () => {
      const index = locs(await get(SITEMAP));
      const children = index.filter((u) => u.endsWith(".xml"));
      const pages = children.length ? (await Promise.all(children.slice(0, 10).map((u) => get(u).then(locs).catch(() => [])))).flat() : index;
      cache = { at: Date.now(), urls: pages };
      return pages;
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

export async function deepReportUrl(ticker: string, issuer: string): Promise<string | null> {
  if (!ENABLED) return null;
  try {
    const urls = await loadUrls();
    const slug = ticker.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const needle = `/${slug}-${issuer.slice(0, 8)}-`;
    return urls.find((u) => u.includes(needle)) ?? FALLBACK;
  } catch {
    return FALLBACK;
  }
}
