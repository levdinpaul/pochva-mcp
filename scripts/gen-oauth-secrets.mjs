#!/usr/bin/env node
// Генерация OAuth-секретов для коннектора Claude. Секреты пишутся ТОЛЬКО в .env (chmod 600)
// и в handover-файл (chmod 600) — НИКОГДА в stdout/argv (правило после двух утечек пароля).
//
//   node scripts/gen-oauth-secrets.mjs            # первичная генерация (откажется затирать активные)
//   node scripts/gen-oauth-secrets.mjs --force    # ротация (инвалидирует старые токены и фразу)
//
// Печатает только ПУТЬ к handover-файлу и немаскированные не-секретные факты.

import { randomBytes, randomInt, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(HERE, "..", ".env");
const HANDOVER = join(homedir(), "pochva-oauth-connector.txt");
const FORCE = process.argv.includes("--force");

const ISSUER = process.env.POCHVA_MCP_OAUTH_ISSUER ?? "https://d.pavellevdin.ru";
const RESOURCE = process.env.POCHVA_MCP_OAUTH_RESOURCE ?? "https://d.pavellevdin.ru/mcp";
const OWNER = process.env.POCHVA_MCP_OWNER_SUB ?? "levdin.pavel@yandex.ru";

// ── читаем текущий .env ───────────────────────────────────────────────────────
if (!existsSync(ENV_PATH)) {
  console.error(".env не найден рядом со скриптом:", ENV_PATH);
  process.exit(1);
}
const raw = readFileSync(ENV_PATH, "utf8");
const lines = raw.split("\n");
const getVal = (k) => {
  const m = lines.find((l) => l.startsWith(k + "="));
  return m ? m.slice(k.length + 1) : "";
};
const isSet = (k) => {
  const v = getVal(k);
  return v && !v.startsWith("CHANGE_ME");
};

const alreadyActive =
  isSet("POCHVA_MCP_OAUTH_CLIENT_SECRET") &&
  isSet("POCHVA_MCP_OAUTH_SIGNING_KEY") &&
  isSet("POCHVA_MCP_OAUTH_PASSWORD_HASH");
if (alreadyActive && !FORCE) {
  console.error("OAuth уже настроен. Ротация затрёт токены и кодовую фразу. Повтори с --force, если это осознанно.");
  process.exit(2);
}

// ── генерация ─────────────────────────────────────────────────────────────────
const clientId = "pochva-mcp-" + randomBytes(6).toString("hex");
const clientSecret = randomBytes(32).toString("base64url");
const signingKey = randomBytes(48).toString("hex");

// Кодовая фраза: 4 группы по 4 символа без неоднозначных знаков (~79 бит), терпимо набрать на телефоне.
const ALPHA = "abcdefghjkmnpqrstuvwxyz23456789"; // без 0 o 1 l i
const grp = () => Array.from({ length: 4 }, () => ALPHA[randomInt(ALPHA.length)]).join("");
const passphrase = [grp(), grp(), grp(), grp()].join("-");

// scrypt-хеш фразы (в .env кладём хеш, не фразу).
const N = 16384, r = 8, p = 1;
const salt = randomBytes(16);
const hash = scryptSync(passphrase, salt, 32, { N, r, p, maxmem: 128 * 1024 * 1024 });
// Разделитель ":" — НЕ "$": docker compose интерполирует "$" в env_file и ломает значение.
const passwordHash = `scrypt:${N}:${r}:${p}:${salt.toString("base64url")}:${hash.toString("base64url")}`;

// Поколение токенов: сохраняем текущее (ротация ключа и так инвалидирует), иначе 1.
const tokenGen = getVal("POCHVA_MCP_OAUTH_TOKEN_GEN") || "1";

// ── перезаписываем управляемые ключи в .env, остальное не трогаем ─────────────
const MANAGED = {
  POCHVA_MCP_OAUTH_ISSUER: ISSUER,
  POCHVA_MCP_OAUTH_RESOURCE: RESOURCE,
  POCHVA_MCP_OWNER_SUB: OWNER,
  POCHVA_MCP_OAUTH_CLIENT_ID: clientId,
  POCHVA_MCP_OAUTH_CLIENT_SECRET: clientSecret,
  POCHVA_MCP_OAUTH_SIGNING_KEY: signingKey,
  POCHVA_MCP_OAUTH_PASSWORD_HASH: passwordHash,
  POCHVA_MCP_OAUTH_TOKEN_GEN: tokenGen,
  POCHVA_MCP_OAUTH_ACCESS_TTL: getVal("POCHVA_MCP_OAUTH_ACCESS_TTL") || "3600",
  POCHVA_MCP_OAUTH_REFRESH_TTL: getVal("POCHVA_MCP_OAUTH_REFRESH_TTL") || "7776000",
};
const managedKeys = new Set(Object.keys(MANAGED));
const kept = lines.filter((l) => {
  const eq = l.indexOf("=");
  const key = eq >= 0 ? l.slice(0, eq) : "";
  return !managedKeys.has(key);
});
// собираем: сохранённые строки (без хвостовых пустых) + блок managed
while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
const block = [
  "",
  "# ── OAuth 2.0 (сгенерировано gen-oauth-secrets.mjs — не редактировать вручную) ──",
  ...Object.entries(MANAGED).map(([k, v]) => `${k}=${v}`),
  "",
];
writeFileSync(ENV_PATH, kept.concat(block).join("\n"), { mode: 0o600 });
chmodSync(ENV_PATH, 0o600);

// ── handover-файл (что вписать в диалог + кодовая фраза + шаги). chmod 600. ────
const handover = `# ─────────────────────────────────────────────────────────────────
# Pochva-MCP — данные для «Add custom connector (BETA)» в claude.ai
# ЭТОТ ФАЙЛ СОДЕРЖИТ СЕКРЕТЫ. Прочитай, настрой коннектор, затем УДАЛИ файл.
# Никому не пересылать, в чат не вставлять.
# ─────────────────────────────────────────────────────────────────
#
# В диалоге claude.ai:
#   URL коннектора:            ${RESOURCE}
#   Advanced → OAuth Client ID:     (см. CLIENT_ID ниже)
#   Advanced → OAuth Client Secret: (см. CLIENT_SECRET ниже)
#
# При подключении откроется экран «Почва под ногами» — введи кодовую фразу (PASSPHRASE ниже).
#
CONNECTOR_URL=${RESOURCE}
CLIENT_ID=${clientId}
CLIENT_SECRET=${clientSecret}
PASSPHRASE=${passphrase}
#
# Служебное (для e2e-проверки; не нужно вписывать в диалог):
ISSUER=${ISSUER}
OWNER=${OWNER}
`;
writeFileSync(HANDOVER, handover, { mode: 0o600 });
chmodSync(HANDOVER, 0o600);

// ── stdout: только не-секретные факты ────────────────────────────────────────
console.log("OK: OAuth-секреты записаны в .env (chmod 600).");
console.log("client_id length:", clientId.length, "| client_secret length:", clientSecret.length, "| signing_key length:", signingKey.length);
console.log("password_hash format:", /^scrypt:\d+:\d+:\d+:[\w-]+:[\w-]+$/.test(passwordHash) ? "ok" : "BAD");
console.log("passphrase entropy: 4×4 из 31 символа (~79 бит)");
console.log("Данные для диалога и кодовая фраза — в файле (chmod 600):");
console.log(" ", HANDOVER);
