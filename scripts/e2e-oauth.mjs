#!/usr/bin/env node
// E2E OAuth-flow снаружи (через реальный nginx+TLS). Секреты читаются из handover-файла
// и .env, отправляются ТОЛЬКО по TLS — в stdout только PASS/FAIL и не-секретные факты.
//
//   E2E_CONNECT=127.0.0.1:443 node scripts/e2e-oauth.mjs
//
// E2E_CONNECT — куда реально коннектиться (минуя внешний DNS). SNI/Host остаются = issuer.

import { request as httpsRequest } from "node:https";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const HANDOVER = join(homedir(), "pochva-oauth-connector.txt");

function parseKv(text) {
  const o = {};
  for (const l of text.split("\n")) {
    if (l.startsWith("#") || !l.includes("=")) continue;
    const i = l.indexOf("=");
    o[l.slice(0, i).trim()] = l.slice(i + 1);
  }
  return o;
}
const H = parseKv(readFileSync(HANDOVER, "utf8"));
const ENV = parseKv(readFileSync(join(HERE, "..", ".env"), "utf8"));

const ISSUER = new URL(H.ISSUER);
const RESOURCE = H.CONNECTOR_URL; // https://host/mcp
const RES_PATH = new URL(RESOURCE).pathname;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const [CONN_HOST, CONN_PORT] = (process.env.E2E_CONNECT ?? `${ISSUER.hostname}:443`).split(":");

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log("  PASS", name, detail && `(${detail})`);
  } else {
    fail++;
    console.log("  FAIL", name, detail && `(${detail})`);
  }
}

function req(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = httpsRequest(
      {
        host: CONN_HOST,
        port: Number(CONN_PORT),
        servername: ISSUER.hostname, // SNI
        method,
        path,
        headers: { Host: ISSUER.hostname, ...headers },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
      },
    );
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}
const form = (obj) => new URLSearchParams(obj).toString();
const initBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } } });
const JSON_HDR = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const FORM_HDR = { "content-type": "application/x-www-form-urlencoded" };

(async () => {
  console.log(`E2E → connect ${CONN_HOST}:${CONN_PORT}, SNI/Host ${ISSUER.hostname}`);

  // 1. AS metadata
  let as = await req("GET", "/.well-known/oauth-authorization-server");
  let asj = safeJson(as.text);
  check("AS metadata 200", as.status === 200, String(as.status));
  check("AS token_endpoint", asj?.token_endpoint === `${H.ISSUER}/token`);
  check("AS S256 advertised", Array.isArray(asj?.code_challenge_methods_supported) && asj.code_challenge_methods_supported.includes("S256"));

  // 2. Protected resource metadata (root + /mcp fallback)
  let prm = await req("GET", "/.well-known/oauth-protected-resource");
  let prmj = safeJson(prm.text);
  check("PRM 200", prm.status === 200, String(prm.status));
  check("PRM resource == URL коннектора", prmj?.resource === RESOURCE, prmj?.resource);
  check("PRM authorization_servers[0]==issuer", prmj?.authorization_servers?.[0] === H.ISSUER);
  let prmMcp = await req("GET", "/.well-known/oauth-protected-resource/mcp");
  check("PRM /mcp fallback 200", prmMcp.status === 200, String(prmMcp.status));

  // 3. /mcp без токена → 401 + WWW-Authenticate с resource_metadata
  let un = await req("POST", RES_PATH, { headers: JSON_HDR, body: initBody });
  check("/mcp без токена → 401", un.status === 401, String(un.status));
  check("WWW-Authenticate → resource_metadata", String(un.headers["www-authenticate"] ?? "").includes("resource_metadata"), un.headers["www-authenticate"]);

  // 4. PKCE
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const azQuery = form({ response_type: "code", client_id: H.CLIENT_ID, redirect_uri: REDIRECT, scope: "pochva offline_access", state: "xyz", code_challenge: challenge, code_challenge_method: "S256" });

  // 5. GET /authorize → форма
  let azGet = await req("GET", "/authorize?" + azQuery);
  check("GET /authorize 200 форма", azGet.status === 200 && azGet.text.includes("<form"), String(azGet.status));

  // 6a. Неверная фраза → 401, без кода
  let bad = await req("POST", "/authorize", { headers: FORM_HDR, body: form({ response_type: "code", client_id: H.CLIENT_ID, redirect_uri: REDIRECT, scope: "pochva offline_access", state: "xyz", code_challenge: challenge, code_challenge_method: "S256", password: "definitely-wrong" }) });
  check("Неверная фраза → 401 (нет редиректа)", bad.status === 401 && !bad.headers.location);

  // 6b. Верная фраза → 302 с code
  let ok = await req("POST", "/authorize", { headers: FORM_HDR, body: form({ response_type: "code", client_id: H.CLIENT_ID, redirect_uri: REDIRECT, scope: "pochva offline_access", state: "xyz", code_challenge: challenge, code_challenge_method: "S256", password: H.PASSPHRASE }) });
  check("Верная фраза → 302", ok.status === 302, String(ok.status));
  const loc = ok.headers.location ?? "";
  check("Редирект на claude.ai callback", loc.startsWith(REDIRECT), loc.split("?")[0]);
  const code = new URL(loc).searchParams.get("code");
  check("В редиректе есть code", Boolean(code));
  check("state сохранён", new URL(loc).searchParams.get("state") === "xyz");

  // 7. /token authorization_code
  let tok = await req("POST", "/token", { headers: FORM_HDR, body: form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: H.CLIENT_ID, client_secret: H.CLIENT_SECRET }) });
  let tokj = safeJson(tok.text);
  check("/token 200", tok.status === 200, String(tok.status));
  check("access_token выдан", Boolean(tokj?.access_token));
  check("refresh_token выдан", Boolean(tokj?.refresh_token));
  const access = tokj?.access_token;

  // 7b. code одноразовый — повтор не проходит
  let reuse = await req("POST", "/token", { headers: FORM_HDR, body: form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: H.CLIENT_ID, client_secret: H.CLIENT_SECRET }) });
  check("Повтор кода → invalid_grant", reuse.status === 400 && safeJson(reuse.text)?.error === "invalid_grant");

  // 7c. неверный client_secret → invalid_client
  let badc = await req("POST", "/token", { headers: FORM_HDR, body: form({ grant_type: "refresh_token", refresh_token: tokj?.refresh_token ?? "x", client_id: H.CLIENT_ID, client_secret: "wrong" }) });
  check("Неверный client_secret → 401 invalid_client", badc.status === 401 && safeJson(badc.text)?.error === "invalid_client");

  // 8. /mcp с OAuth access-токеном → 200 initialize
  let good = await req("POST", RES_PATH, { headers: { ...JSON_HDR, authorization: `Bearer ${access}` }, body: initBody });
  check("/mcp с OAuth-токеном → 200", good.status === 200, String(good.status));
  check("initialize вернул serverInfo", good.text.includes("pochva-mcp"));

  // 8b. подделанный токен → 401
  const tampered = access.slice(0, -2) + (access.endsWith("a") ? "b" : "a");
  let tam = await req("POST", RES_PATH, { headers: { ...JSON_HDR, authorization: `Bearer ${tampered}` }, body: initBody });
  check("Подделанный токен → 401", tam.status === 401, String(tam.status));

  // 9. статический Bearer владельца (curl/скрипты) всё ещё работает
  if (ENV.POCHVA_MCP_INBOUND_TOKEN && !ENV.POCHVA_MCP_INBOUND_TOKEN.startsWith("CHANGE_ME")) {
    let leg = await req("POST", RES_PATH, { headers: { ...JSON_HDR, authorization: `Bearer ${ENV.POCHVA_MCP_INBOUND_TOKEN}` }, body: initBody });
    check("Статический Bearer → 200 (curl не сломан)", leg.status === 200, String(leg.status));
  }

  // 10. refresh_token → новый access
  let rf = await req("POST", "/token", { headers: FORM_HDR, body: form({ grant_type: "refresh_token", refresh_token: tokj?.refresh_token, client_id: H.CLIENT_ID, client_secret: H.CLIENT_SECRET }) });
  check("refresh_token → 200 новый access", rf.status === 200 && Boolean(safeJson(rf.text)?.access_token));

  // 11. default-deny сохранён
  let deny = await req("GET", "/random-nonsense-path");
  check("Посторонний путь → 404 (default-deny)", deny.status === 404, String(deny.status));

  console.log(`\nИТОГО: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("E2E упал:", e.message);
  process.exit(1);
});

function safeJson(t) {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}
