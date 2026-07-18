# pochva-mcp

Тонкий remote-MCP над **pochva-core API** для надиктовки из Claude (телефон/десктоп).
В БД напрямую НЕ ходит: вся RLS, валидация и парсинг — в ядре. MCP только транслирует
вызовы tools в HTTP-запросы к `pochva-core`.

## Границы (два рубежа auth — не смешивать)
- **Вход `/mcp`**: Bearer владельца (`POCHVA_MCP_INBOUND_TOKEN`). Телефон/Claude → MCP.
- **Выход к ядру**: сервисный токен (`POCHVA_MCP_TOKEN`). MCP → `pochva-core`.
- Компрометация одного токена не даёт второго. Оба отзываются независимо.
- НЕ переиспользует GitHub-OAuth от `vl-vps-mcp` (то — админский MCP другого контура).

## Сеть
- Контейнер на `pochva-network` (→ `http://pochva-core:3000`) **и** `vl-network` (← `vl-nginx`
  проксирует `/mcp`). Порт наружу НЕ публикуется. Публично — только `https://d.pavellevdin.ru/mcp`.

## Транспорт
- MCP Streamable HTTP (`@modelcontextprotocol/sdk`), stateless. Только JSON, без HTML/сессий/форм.
- Rate limit + аудит факта каждого вызова (тело/ПДн в лог не пишем).

## Tools → контракт эндпоинтов ядра (M3, финализируется в Фазе 1)
| tool | метод + путь | назначение |
|---|---|---|
| `pochva_ingest` | `POST /api/ingest` `{text}` | текст → сущности (Gemini→NVIDIA) |
| `pochva_add` | `POST /api/items` `{type,...}` | явно создать task/deadline/document/event/entry |
| `pochva_list` | `GET /api/list?direction=&status=` | что открыто |
| `pochva_close` | `POST /api/tasks/:id/close` | закрыть задачу |
| `pochva_digest` | `GET /api/digest` | что горит сегодня |
| `pochva_doc_add` | `POST /api/documents` | документ (метаданные) |
| `pochva_doc_expiring` | `GET /api/documents/expiring?within=30` | что истекает |

Все эндпоинты — Bearer (`api_tokens`, SHA-256), резолвятся в единственного владельца → `withUser()`.

## Локально
```bash
npm install
cp .env.sample .env    # заполнить токены, chmod 600
npm run typecheck
npm run dev            # слушает :8788, POST /mcp
```
