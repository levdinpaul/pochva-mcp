# FILE_MAP — pochva-mcp (remote-MCP над API pochva-core)
Карта «тема -> путь». Порядок работы: эта карта -> Grep/Glob -> точечный Read (файлы >200 строк — offset/limit).
Обновлено: 2026-10-27 (prompt-31). Новое место в коде -> добавить строку сюда.

## Где что
- Точка входа/HTTP-сервер -> `src/server.ts` (express, Streamable HTTP `/mcp`, rate limit)
- MCP-tools (opora_*/pochva_*) -> `src/tools.ts` (описания tools -> вызовы REST ядра)
- Клиент к ядру pochva-core -> `src/coreClient.ts` (сервисный Bearer, HTTP к `/api/*`)
- Auth входа (Bearer владельца) -> `src/auth.ts`
- OAuth для Claude-коннектора -> `src/oauth.ts`, `src/jwt.ts`
- Конфиг/env-переменные -> `src/config.ts`, пример `.env.sample`
- Формы/лиды -> нет в проекте
- Конфигуратор -> нет в проекте
- Дизайн-токены/стили -> нет в проекте (только JSON API)
- Переводы/тексты -> нет в проекте (тексты описаний tools — в `src/tools.ts`)
- API/эндпойнты -> `src/server.ts` (маршруты), контракт tools -> эндпойнты ядра в `README.md`
- Деплой -> `Dockerfile`, `deploy/pochva-mcp.compose-snippet.yml`, `deploy/nginx-mcp-location.conf`
- Контент/CMS -> нет в проекте
- Тесты -> `scripts/e2e-oauth.mjs` (e2e OAuth-потока); юнит-тестов нет
- Генерация секретов OAuth -> `scripts/gen-oauth-secrets.mjs`
- Сборка/скрипты npm -> `package.json` (dev/build/start/typecheck), `tsconfig.json`
- Документация -> `README.md` (границы auth, сеть, контракт tools)
- Связанные репо -> ядро `/home/claudeuser/pochva-core` (`src/app/api/`), бот `/home/claudeuser/pochva-bot`

## Куда НЕ ходить
- `node_modules/`, `dist/` (зависимости и скомпилированный JS — исходники только в `src/`)
- `package-lock.json`, `.env` (секреты), `*.log`
