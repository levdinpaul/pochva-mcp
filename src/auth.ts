import { timingSafeEqual } from "node:crypto";

/**
 * Проверка входящего Bearer без утечки по времени. Обычное === выходит на первом
 * различающемся байте и по времени ответа выдаёт префикс токена.
 */
export function checkBearer(header: string | undefined, expected: string): boolean {
  if (!header || !header.startsWith("Bearer ")) return false;
  const got = Buffer.from(header.slice(7).trim(), "utf8");
  const exp = Buffer.from(expected, "utf8");
  if (got.length !== exp.length) return false;
  return timingSafeEqual(got, exp);
}
