import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Request, Response, Express } from "express";
import { CONFIG } from "./config.js";
import { signJwt, verifyJwt } from "./jwt.js";

const O = CONFIG.oauth;
const SCOPES = ["pochva", "offline_access"] as const;

// ── Постоянно-временное сравнение строк (клиентские креды, PKCE) ──────────────
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// ── Кодовая фраза: scrypt:N:r:p:saltB64url:hashB64url ─────────────────────────
// Разделитель ":" (НЕ "$"): docker compose интерполирует "$" в env_file и ломает значение.
export function verifyPassword(input: string, stored: string): boolean {
  const p = stored.split(":");
  if (p.length !== 6 || p[0] !== "scrypt") return false;
  const N = Number(p[1]);
  const r = Number(p[2]);
  const cost = Number(p[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(cost)) return false;
  const salt = Buffer.from(p[4], "base64url");
  const hash = Buffer.from(p[5], "base64url");
  let got: Buffer;
  try {
    got = scryptSync(input, salt, hash.length, { N, r, p: cost, maxmem: 128 * 1024 * 1024 });
  } catch {
    return false;
  }
  return got.length === hash.length && timingSafeEqual(got, hash);
}

// ── PKCE S256 ─────────────────────────────────────────────────────────────────
function verifyPkce(verifier: string, challenge: string): boolean {
  const computed = createHash("sha256").update(verifier).digest("base64url");
  return safeEqual(computed, challenge);
}

// ── Redirect_uri: строгий allowlist. Никогда не редиректим на непроверенный URI ─
function redirectAllowed(uri: string): boolean {
  return (O.redirectAllowlist as readonly string[]).includes(uri);
}

// ── Хранилище кодов: in-memory, короткий TTL, одноразовые ────────────────────
type CodeRec = { challenge: string; redirectUri: string; scope: string; exp: number };
const codes = new Map<string, CodeRec>();
const CODE_TTL_MS = 60_000;

function putCode(rec: CodeRec): string {
  const code = randomBytes(32).toString("base64url");
  codes.set(code, rec);
  return code;
}
function takeCode(code: string): CodeRec | null {
  const rec = codes.get(code);
  if (!rec) return null;
  codes.delete(code); // одноразовый — снимаем сразу
  if (Date.now() > rec.exp) return null;
  return rec;
}
// Периодическая чистка протухших кодов (сервер долгоживущий).
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of codes) if (now > v.exp) codes.delete(k);
}, 60_000).unref();

// ── Выпуск токенов ────────────────────────────────────────────────────────────
function issueTokens(scope: string): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const base = { iss: O.issuer, sub: O.ownerSub, aud: O.resource, gen: O.tokenGen };
  const access = signJwt(
    { ...base, typ: "access", scope, iat: now, exp: now + O.accessTtlSec },
    O.signingKey,
  );
  const out: Record<string, unknown> = {
    access_token: access,
    token_type: "Bearer",
    expires_in: O.accessTtlSec,
    scope,
  };
  if (scope.split(" ").includes("offline_access")) {
    out.refresh_token = signJwt(
      { ...base, typ: "refresh", scope, iat: now, exp: now + O.refreshTtlSec },
      O.signingKey,
    );
  }
  return out;
}

/** Проверка access-токена на /mcp. true = валиден и это владелец. */
export function verifyAccessToken(token: string): boolean {
  const p = verifyJwt(token, O.signingKey);
  if (!p) return false;
  return (
    p.typ === "access" &&
    p.iss === O.issuer &&
    p.aud === O.resource &&
    p.sub === O.ownerSub &&
    p.gen === O.tokenGen
  );
}

// ── Аутентификация клиента на /token (client_secret_post | client_secret_basic) ─
function authClient(req: Request): boolean {
  let id = "";
  let secret = "";
  const basic = req.header("authorization");
  if (basic && basic.startsWith("Basic ")) {
    const dec = Buffer.from(basic.slice(6).trim(), "base64").toString("utf8");
    const i = dec.indexOf(":");
    if (i >= 0) {
      id = decodeURIComponent(dec.slice(0, i));
      secret = decodeURIComponent(dec.slice(i + 1));
    }
  } else {
    id = String(req.body?.client_id ?? "");
    secret = String(req.body?.client_secret ?? "");
  }
  // Оба сравнения постоянно-временные; порядок && не выдаёт, что именно не совпало.
  const okId = safeEqual(id, O.clientId);
  const okSecret = safeEqual(secret, O.clientSecret);
  return okId && okSecret;
}

// ── HTML экрана согласия (без JS; inline-стиль — CSP на /authorize ослаблен) ──
function loginPage(params: Record<string, string>, error?: string): string {
  const hidden = ["response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method"]
    .map((k) => `<input type="hidden" name="${k}" value="${escapeAttr(params[k] ?? "")}">`)
    .join("");
  const err = error ? `<p class="err">${escapeHtml(error)}</p>` : "";
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Почва — доступ</title>
<style>
  :root{color-scheme:light dark}
  body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1115;color:#e8eaed}
  form{width:min(92vw,360px);padding:28px 24px;border:1px solid #2a2f3a;border-radius:14px;background:#161a22}
  h1{font-size:18px;margin:0 0 4px}
  p.sub{margin:0 0 18px;color:#9aa4b2;font-size:13px}
  label{display:block;font-size:13px;color:#9aa4b2;margin:14px 0 6px}
  input[type=password]{width:100%;box-sizing:border-box;padding:12px;border:1px solid #2a2f3a;border-radius:9px;background:#0f1115;color:#e8eaed;font-size:16px}
  button{width:100%;margin-top:20px;padding:12px;border:0;border-radius:9px;background:#3b82f6;color:#fff;font-size:15px;font-weight:600}
  p.err{color:#f87171;font-size:13px;margin:14px 0 0}
  .who{font-variant-numeric:tabular-nums;color:#e8eaed}
</style></head><body>
<form method="post" action="/authorize" autocomplete="off">
  <h1>Почва под ногами</h1>
  <p class="sub">Доступ для <span class="who">${escapeHtml(O.ownerSub)}</span></p>
  ${hidden}
  <label for="pw">Кодовая фраза</label>
  <input id="pw" name="password" type="password" autofocus required inputmode="text">
  ${err}
  <button type="submit">Разрешить доступ</button>
</form></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function errorPage(res: Response, status: number, msg: string): void {
  res
    .status(status)
    .type("html")
    .send(`<!doctype html><meta charset="utf-8"><title>Ошибка</title><p style="font-family:system-ui;padding:24px">${escapeHtml(msg)}</p>`);
}

// ── Валидация общих параметров authorize (GET и POST) ────────────────────────
type AzParams = { response_type: string; client_id: string; redirect_uri: string; scope: string; state: string; code_challenge: string; code_challenge_method: string };
function readAzParams(src: Record<string, unknown>): AzParams {
  const s = (k: string) => String(src[k] ?? "");
  return {
    response_type: s("response_type"),
    client_id: s("client_id"),
    redirect_uri: s("redirect_uri"),
    scope: s("scope"),
    state: s("state"),
    code_challenge: s("code_challenge"),
    code_challenge_method: s("code_challenge_method"),
  };
}
/** Валидность параметров, независимая от redirect_uri (её проверяем отдельно, до любого редиректа). */
function azParamsError(p: AzParams): string | null {
  if (p.response_type !== "code") return "response_type должен быть code";
  if (!safeEqual(p.client_id, O.clientId)) return "неизвестный client_id";
  if (!p.code_challenge) return "нужен code_challenge (PKCE)";
  if (p.code_challenge_method !== "S256") return "code_challenge_method должен быть S256";
  return null;
}
/** Гранту всегда добавляем offline_access, чтобы Claude получил refresh (иначе на телефоне частый релогин). */
function grantedScope(requested: string): string {
  const set = new Set(requested.split(/\s+/).filter(Boolean));
  set.add("pochva");
  set.add("offline_access");
  return [...set].filter((s) => (SCOPES as readonly string[]).includes(s)).join(" ");
}

// ── Монтирование маршрутов ────────────────────────────────────────────────────
export function mountOAuth(app: Express): void {
  // RFC 8414 — метаданные authorization server.
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: O.issuer,
      authorization_endpoint: `${O.issuer}/authorize`,
      token_endpoint: `${O.issuer}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      scopes_supported: [...SCOPES],
    });
  });

  // RFC 9728 — метаданные protected resource. resource обязан совпасть с MCP-URL как введён.
  const prm = (_req: Request, res: Response) =>
    res.json({
      resource: O.resource,
      authorization_servers: [O.issuer],
      scopes_supported: [...SCOPES],
      bearer_methods_supported: ["header"],
    });
  app.get("/.well-known/oauth-protected-resource", prm);
  app.get("/.well-known/oauth-protected-resource/mcp", prm); // fallback-путь, который пробует Claude

  // Экран согласия.
  app.get("/authorize", (req, res) => {
    const p = readAzParams(req.query as Record<string, unknown>);
    // redirect_uri валидируем ПЕРВЫМ и никогда не редиректим на непроверенный.
    if (!redirectAllowed(p.redirect_uri)) return errorPage(res, 400, "redirect_uri не в списке разрешённых");
    const err = azParamsError(p);
    if (err) return errorPage(res, 400, err);
    res.type("html").send(loginPage(p as unknown as Record<string, string>));
  });

  app.post("/authorize", (req, res) => {
    const p = readAzParams(req.body as Record<string, unknown>);
    if (!redirectAllowed(p.redirect_uri)) return errorPage(res, 400, "redirect_uri не в списке разрешённых");
    const err = azParamsError(p);
    if (err) return errorPage(res, 400, err);

    const password = String((req.body as Record<string, unknown>)?.password ?? "");
    if (!verifyPassword(password, O.passwordHash)) {
      // Фраза неверна — форма заново, кода не выдаём.
      return res.status(401).type("html").send(loginPage(p as unknown as Record<string, string>, "Неверная кодовая фраза"));
    }

    const scope = grantedScope(p.scope);
    const code = putCode({ challenge: p.code_challenge, redirectUri: p.redirect_uri, scope, exp: Date.now() + CODE_TTL_MS });
    const url = new URL(p.redirect_uri);
    url.searchParams.set("code", code);
    if (p.state) url.searchParams.set("state", p.state);
    res.redirect(302, url.toString());
  });

  // /token — только form-urlencoded (RFC 6749).
  app.post("/token", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const grant = String(body.grant_type ?? "");

    if (!authClient(req)) {
      res.set("WWW-Authenticate", 'Basic realm="opora-mcp"');
      return res.status(401).json({ error: "invalid_client" });
    }

    if (grant === "authorization_code") {
      const code = String(body.code ?? "");
      const verifier = String(body.code_verifier ?? "");
      const redirectUri = String(body.redirect_uri ?? "");
      const rec = takeCode(code);
      if (!rec) return res.status(400).json({ error: "invalid_grant" });
      if (!safeEqual(redirectUri, rec.redirectUri)) return res.status(400).json({ error: "invalid_grant" });
      if (!verifier || !verifyPkce(verifier, rec.challenge)) return res.status(400).json({ error: "invalid_grant" });
      return res.json(issueTokens(rec.scope));
    }

    if (grant === "refresh_token") {
      const rt = String(body.refresh_token ?? "");
      const p = verifyJwt(rt, O.signingKey);
      if (!p || p.typ !== "refresh" || p.iss !== O.issuer || p.aud !== O.resource || p.sub !== O.ownerSub || p.gen !== O.tokenGen) {
        return res.status(400).json({ error: "invalid_grant" });
      }
      return res.json(issueTokens(String(p.scope ?? "pochva offline_access")));
    }

    return res.status(400).json({ error: "unsupported_grant_type" });
  });
}

/** Заголовок для 401 на /mcp — указывает Claude, где взять metadata для discovery. */
export function wwwAuthenticate(hadBearer: boolean): string {
  const base = `Bearer resource_metadata="${O.issuer}/.well-known/oauth-protected-resource"`;
  return hadBearer ? `${base}, error="invalid_token"` : base;
}
