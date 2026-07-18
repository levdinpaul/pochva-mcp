import { CONFIG } from "./config.js";

/**
 * Единственный путь MCP к данным — HTTP к opora-core. В БД напрямую НЕ ходим:
 * вся RLS, валидация и парсинг живут в ядре. На выходе — сервисный Bearer OPORA_MCP_TOKEN.
 */
async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${CONFIG.coreBaseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${CONFIG.coreToken}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new Error(`opora-core недоступен (${method} ${path}): ${(e as Error).message}`);
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? res.statusText;
    throw new Error(`opora-core ${method} ${path} → ${res.status}: ${msg}`);
  }
  return data;
}

export const core = {
  get: (path: string) => call("GET", path),
  post: (path: string, body?: unknown) => call("POST", path, body),
  patch: (path: string, body?: unknown) => call("PATCH", path, body),
  del: (path: string, body?: unknown) => call("DELETE", path, body),
};

/** Отбросить null/undefined и собрать query-строку. */
export function query(params: Record<string, unknown>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== "") usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}
