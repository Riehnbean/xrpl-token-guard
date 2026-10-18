// Minimal read-only XRPL JSON-RPC client with endpoint fallback and timeouts.
// Never signs, never submits. Only public read methods are used.

export type RpcFn = (method: string, params: Record<string, unknown>) => Promise<any>;

const DEFAULT_ENDPOINTS = (process.env.XRPL_RPC_URLS ?? "https://xrplcluster.com,https://s1.ripple.com:51234,https://s2.ripple.com:51234")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export class XrplRpcError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
  }
}

export function createRpc(endpoints: string[] = DEFAULT_ENDPOINTS, timeoutMs = 8000): RpcFn {
  return async (method, params) => {
    let lastErr: unknown;
    for (const url of endpoints) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ method, params: [{ ledger_index: "validated", ...params }] }),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new XrplRpcError(`HTTP ${res.status} from ${url}`);
        const body: any = await res.json();
        const result = body?.result;
        if (!result) throw new XrplRpcError("empty response");
        if (result.status === "error") {
          // Ledger-level answers (like "account not found") are real answers: don't retry them.
          throw new XrplRpcError(result.error_message ?? result.error, result.error);
        }
        return result;
      } catch (err) {
        if (err instanceof XrplRpcError && err.code) throw err;
        lastErr = err;
      } finally {
        clearTimeout(t);
      }
    }
    throw new XrplRpcError(`All XRPL endpoints failed: ${String((lastErr as Error)?.message ?? lastErr)}`);
  };
}

const RIPPLE_EPOCH = 946684800;
export const rippleTimeToDate = (t: number) => new Date((t + RIPPLE_EPOCH) * 1000);

export const BLACKHOLE_ADDRESSES = new Set([
  "rrrrrrrrrrrrrrrrrrrrrhoLvTp", // ACCOUNT_ZERO
  "rrrrrrrrrrrrrrrrrrrrBZbvji", // ACCOUNT_ONE
  "rrrrrrrrrrrrrrrrrNAMEtxvNvQ", // name reservation black hole
  "rrrrrrrrrrrrrrrrrrrn5RM1rHd", // NaN address
]);

const ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
export const isAddress = (s: string) => ADDRESS_RE.test(s);
