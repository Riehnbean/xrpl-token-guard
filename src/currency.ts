// Currency code helpers: decode XRPL codes and spot look-alike names.

export function decodeCurrency(code: string): string {
  if (/^[0-9A-F]{40}$/i.test(code)) {
    if (code.startsWith("01")) return code; // demurrage-style codes: leave raw
    const bytes = Buffer.from(code, "hex");
    const text = bytes.toString("utf8").replace(/\0+$/g, "").replace(/^\0+/g, "");
    return /^[\x20-\x7E]+$/.test(text) ? text : code;
  }
  return code;
}

/** Encode a human ticker into the on-ledger form (3-char standard or 40-hex). */
export function encodeCurrency(ticker: string): string {
  const t = ticker.trim();
  if (/^[0-9A-F]{40}$/i.test(t)) return t.toUpperCase();
  if (t.length === 3 && t.toUpperCase() !== "XRP") return t;
  const hex = Buffer.from(t, "utf8").toString("hex").toUpperCase();
  if (hex.length > 40) throw new Error(`Currency code too long: ${ticker}`);
  return hex.padEnd(40, "0");
}

const CONFUSABLES: Record<string, string> = { "0": "O", "1": "L", "I": "L", "|": "L", "5": "S", "$": "S", "3": "E", "4": "A", "@": "A", "7": "T", "8": "B" };

/** Normalise a ticker so that "RLU$D", "R1USD" and "rlusd." all collapse to "RLUSD". */
export function skeleton(ticker: string): string {
  return ticker
    .toUpperCase()
    .split("")
    .map((c) => CONFUSABLES[c] ?? c)
    .join("")
    .replace(/[^A-Z]/g, "");
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/**
 * True when `ticker` is the brand name or a close imitation of it
 * (exact skeleton match, brand plus a short prefix or suffix, or one edit away).
 */
export function looksLike(ticker: string, brand: string): boolean {
  const s = skeleton(ticker);
  const b = skeleton(brand);
  if (!s || !b) return false;
  if (s === b) return true;
  if (b.length >= 4 && s.includes(b) && s.length - b.length <= 3) return true;
  if (b.length >= 5 && s.length === b.length && editDistance(s, b) <= 1) return true;
  return false;
}
