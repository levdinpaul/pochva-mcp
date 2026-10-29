# pochva-mcp — remote-MCP над pochva-core (Опора / vestoralife)

Карта кода — `FILE_MAP.md` (первой → Grep/Glob → точечный Read). Что сделано — KB `/opt/knowledge-base/Projects/pochva/` (`LAST_SESSION.md`/`LEARNINGS.md`: head -40 + tail -40, grep по теме).
Описание, границы auth, tools — `README.md`.

## Стек
Node (ESM, TypeScript ^5.7.3, tsx ^4.19.2), `@modelcontextprotocol/sdk` ^1.29.0, express ^5.1.0, zod ^3.25.0.
Код: `src/{server,auth,oauth,jwt,tools,coreClient,config}.ts`. Скрипты: `scripts/e2e-oauth.mjs`, `scripts/gen-oauth-secrets.mjs`.

## Команды
`npm run dev` (tsx watch) · `npm run build` (tsc) · `npm run typecheck` · `npm start` (node dist/server.js).
Тестов и линтера в package.json нет.

## Правила
- В БД напрямую НЕ ходить: только HTTP к `pochva-core` (RLS и валидация — в ядре).
- Два рубежа auth не смешивать: вход `/mcp` (Bearer владельца) и выход к ядру (сервисный токен). Не переиспользовать OAuth `vl-vps-mcp`.
- Порт наружу не публиковать; в логи — без тела запросов и ПДн.
- Секреты — только `.env` (600), значения не читать и не писать в git/отчёты/KB.

## Прод и деплой
- Публично: https://d.pavellevdin.ru/mcp (nginx `vl-nginx` → контейнер на `pochva-network` + `vl-network`). Сервер: основной VPS.
- Репо: `levdinpaul/pochva-mcp` (master). Деплой-цель: `~/bin/deploy pochva-mcp` (алиас `opora-mcp`, `d.pavellevdin.ru`).
- Compose живёт в `~/pochva-core`; здесь только `deploy/` (сниппеты nginx и compose) и `Dockerfile`.
- Бэкап БД — `~/pochva-core/scripts/pochva-db-backup.sh`.

Агентов и скиллы в проект не класть — только канон mega-brain; знания проекта — docs/.
