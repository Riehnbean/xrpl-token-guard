// Well-known XRPL tokens whose real issuer is public and verifiable on-ledger
// (the issuer's Domain field points at the brand's own site).
// A token that uses one of these names but a different issuer is an impersonation.

export interface Brand {
  ticker: string;
  name: string;
  issuer: string;
  domain: string;
  kind: "stablecoin" | "token";
  /** Regulated stablecoins are expected to keep freeze/clawback powers. */
  regulated: boolean;
}

export const BRANDS: Brand[] = [
  { ticker: "RLUSD", name: "Ripple USD", issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", domain: "ripple.com", kind: "stablecoin", regulated: true },
  { ticker: "USDC", name: "USD Coin (Circle)", issuer: "rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE", domain: "circle.com", kind: "stablecoin", regulated: true },
  { ticker: "SOLO", name: "Sologenic", issuer: "rsoLo2S1kiGeCcn6hCUXVrCpGMWLrRrLZz", domain: "sologenic.com", kind: "token", regulated: false },
];

export const brandByIssuer = (issuer: string) => BRANDS.find((b) => b.issuer === issuer);
export const brandByTicker = (ticker: string) => BRANDS.find((b) => b.ticker.toUpperCase() === ticker.trim().toUpperCase());

/** Spoken names people use for the brands ("ripple dollar", "circle usdc"...). */
export const BRAND_ALIASES: Record<string, string> = {
  "rlusd": "RLUSD", "ripple usd": "RLUSD", "ripple dollar": "RLUSD", "are l usd": "RLUSD", "r l u s d": "RLUSD",
  "usdc": "USDC", "usd coin": "USDC", "circle": "USDC", "u s d c": "USDC",
  "solo": "SOLO", "sologenic": "SOLO",
};
