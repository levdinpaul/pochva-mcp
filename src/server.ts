import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CONFIG } from "./config.js";
import { checkBearer } from "./auth.js";
import { mountOAuth, verifyAccessToken, wwwAuthenticate } from "./oauth.js";
import { registerTools } from "./tools.js";

const app = express();
// Тело /mcp — текст надиктовки, мегабайты ни к чему (nginx тоже режет на 256k).
app.use(express.json({ limit: "256kb" }));
// /token и POST /authorize — form-urlencoded (RFC 6749). Небольшой лимит.
app.use(express.urlencoded({ extended: false, limit: "16kb" }));

// Health — без авторизации, для docker healthcheck. Ничего не раскрывает.
app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// ── OAuth 2.0: discovery + /authorize + /token (для коннектора Claude) ────────
// Отдельный рубеж, независимый от Bearer владельца и сервисного токена к ядру.
mountOAuth(app);

/** Вход на /mcp принят, если: статический Bearer владельца ЛИБО валидный OAuth access-токен. */
function mcpAuthorized(header: string | undefined): boolean {
  if (checkBearer(header, CONFIG.inboundToken)) return true; // curl/скрипты — как было
  if (header && header.startsWith("Bearer ")) return verifyAccessToken(header.slice(7).trim());
  return false;
}

// ── Грубый rate limit: фиксированное окно на входящий токен ──────────────────
// Один пользователь, но публичный путь: защита от зациклившегося клиента и перебора.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 60;
const hits = new Map<string, { n: number; reset: number }>();
function rateLimited(key: string): boolean {
  const now = Date.now();
  const cur = hits.get(key);
  if (!cur || now > cur.reset) {
    hits.set(key, { n: 1, reset: now + WINDOW_MS });
    return false;
  }
  cur.n += 1;
  return cur.n > MAX_PER_WINDOW;
}

// ── Аудит: факт вызова, не тело (ПДн в лог не пишем) ─────────────────────────
function audit(event: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...extra }));
}

// Единственный публичный путь. Вход — Bearer владельца. Ни HTML, ни сессий, ни форм.
app.post("/mcp", async (req: Request, res: Response) => {
  const authHeader = req.header("authorization");
  if (!mcpAuthorized(authHeader)) {
    audit("mcp.unauthorized", { ip: req.ip });
    // WWW-Authenticate — точка входа в OAuth-discovery Claude (обязателен именно на 401).
    res.set("WWW-Authenticate", wwwAuthenticate(Boolean(authHeader?.startsWith("Bearer "))));
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (rateLimited("owner")) {
    audit("mcp.rate_limited");
    res.status(429).json({ error: "rate_limited" });
    return;
  }

  // Stateless: свой server+transport на запрос. Для одного пользователя дёшево и без сессий/SSE.
  const server = new McpServer({ name: "opora-mcp", version: "0.1.0" });
  registerTools(server);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    audit("mcp.request");
  } catch (e) {
    audit("mcp.error", { message: (e as Error).message });
    if (!res.headersSent) res.status(500).json({ error: "internal" });
  }
});

// В stateless-режиме GET (SSE) и DELETE (закрытие сессии) не нужны.
app.all("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({ error: "method_not_allowed" });
});

app.listen(CONFIG.port, () => {
  audit("mcp.listening", { port: CONFIG.port, core: CONFIG.coreBaseUrl });
});
