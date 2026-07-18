// Конфиг из окружения. Секреты только из .env (chmod 600), никогда в репозиторий.
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} не задан (см. .env.sample)`);
  return v;
}

function num(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export const CONFIG = {
  port: num("PORT", 8788),
  // Вход: Bearer владельца — им клиент (телефон/Claude, curl/скрипты) аутентифицируется на /mcp.
  inboundToken: req("POCHVA_MCP_INBOUND_TOKEN"),
  // Выход: сервисный токен к pochva-core. Другой рубеж — компрометация одного не даёт второго.
  coreBaseUrl: (process.env.POCHVA_CORE_URL ?? "http://pochva-core:3000").replace(/\/+$/, ""),
  coreToken: req("POCHVA_MCP_TOKEN"),

  // ── ТРЕТИЙ рубеж: OAuth 2.0 для коннектора Claude (диалог claude.ai не умеет headers) ──
  // Независим от Bearer владельца и от сервисного токена: свой ключ, свой отзыв.
  oauth: {
    // issuer = хост, по которому Claude находит /.well-known/oauth-authorization-server.
    issuer: (process.env.POCHVA_MCP_OAUTH_ISSUER ?? "https://d.pavellevdin.ru").replace(/\/+$/, ""),
    // resource = MCP-URL РОВНО как его вводит владелец в диалоге (RFC 9728, должен совпасть байт-в-байт).
    resource: process.env.POCHVA_MCP_OAUTH_RESOURCE ?? "https://d.pavellevdin.ru/mcp",
    // Пред-регистрированный клиент (владелец вписывает в Advanced settings). DCR не нужен.
    clientId: req("POCHVA_MCP_OAUTH_CLIENT_ID"),
    clientSecret: req("POCHVA_MCP_OAUTH_CLIENT_SECRET"),
    // Ключ подписи access/refresh (HS256). Ротация ключа = отзыв всех токенов.
    signingKey: req("POCHVA_MCP_OAUTH_SIGNING_KEY"),
    // scrypt-хеш кодовой фразы владельца (гейт на экране согласия). Формат: scrypt$N$r$p$saltB64url$hashB64url.
    passwordHash: req("POCHVA_MCP_OAUTH_PASSWORD_HASH"),
    // Единственный субъект. Жёстко зашит в токен — сервер однопользовательский.
    ownerSub: process.env.POCHVA_MCP_OWNER_SUB ?? "levdin.pavel@yandex.ru",
    // Поколение токенов. Bump в .env + recreate = мгновенный отзыв всех выданных токенов.
    tokenGen: num("POCHVA_MCP_OAUTH_TOKEN_GEN", 1),
    accessTtlSec: num("POCHVA_MCP_OAUTH_ACCESS_TTL", 3600), // 1 час; Claude рефрешит по 401.
    refreshTtlSec: num("POCHVA_MCP_OAUTH_REFRESH_TTL", 7_776_000), // 90 дней.
    // Куда разрешено редиректить код. Строгий allowlist — иначе код утечёт чужому сайту.
    redirectAllowlist: [
      "https://claude.ai/api/mcp/auth_callback", // hosted: web / mobile / Desktop / Cowork
      "https://claude.com/api/mcp/auth_callback", // на случай смены домена
    ],
  },
} as const;
