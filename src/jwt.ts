import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Минимальный HS256 JWT — только то, что нужно нам (свой эмитент = свой верификатор).
 * Никакой внешней либы: меньше supply-chain-поверхности для рубежа auth.
 * Жёстко фиксируем alg=HS256 при верификации — защита от alg-confusion (none/RS↔HS).
 */

function b64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

export function signJwt(payload: Record<string, unknown>, key: string): string {
  const head = b64urlJson({ alg: "HS256", typ: "JWT" });
  const body = b64urlJson(payload);
  const data = `${head}.${body}`;
  const sig = createHmac("sha256", key).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifyJwt(token: string, key: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;

  // Подпись проверяем ДО парсинга тела, без утечки по времени.
  const expected = createHmac("sha256", key).update(`${head}.${body}`).digest("base64url");
  const got = Buffer.from(sig, "utf8");
  const exp = Buffer.from(expected, "utf8");
  if (got.length !== exp.length || !timingSafeEqual(got, exp)) return null;

  let header: unknown;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(head, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!header || (header as { alg?: string }).alg !== "HS256") return null;

  const exp2 = payload.exp;
  if (typeof exp2 === "number" && Math.floor(Date.now() / 1000) > exp2) return null;
  return payload;
}
