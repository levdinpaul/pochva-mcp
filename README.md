# pochva-mcp

**A thin, stateless MCP (Model Context Protocol) server** that bridges Claude AI and the Opora / Vestora Life personal life-tracker backend.

Dictate tasks, deadlines, and notes to Claude — it forwards them through this MCP server to the core API, which parses and stores them. The server never touches the database directly; all validation, RLS, and entity parsing live in the core.

## Architecture

```
Claude (phone / desktop)
        │  Bearer token (inbound)
        ▼
  pochva-mcp   ◄─── this repo
        │  Service token (outbound)
        ▼
  pochva-core API
        │
        ▼
  PostgreSQL
```

Two independent auth boundaries — compromising one token does not expose the other.

## Tools exposed to Claude

| Tool | Endpoint | Description |
|---|---|---|
| `pochva_ingest` | `POST /api/ingest` | Free-text → parsed entities (AI pipeline) |
| `pochva_add` | `POST /api/items` | Explicitly create task / deadline / document / event / entry |
| `pochva_list` | `GET /api/list` | List open items by direction/status |
| `pochva_close` | `POST /api/tasks/:id/close` | Close a task |
| `pochva_digest` | `GET /api/digest` | What's urgent today |
| `pochva_doc_add` | `POST /api/documents` | Add a document (metadata) |
| `pochva_doc_expiring` | `GET /api/documents/expiring` | Documents expiring within N days |

## Stack

- **Runtime:** Node.js 20, TypeScript
- **MCP transport:** Streamable HTTP (stateless) via `@modelcontextprotocol/sdk`
- **Deployment:** Docker, behind nginx reverse proxy
- **Auth:** Bearer tokens (SHA-256), OAuth 2.0 for Claude connector

## Quick start

```bash
git clone https://github.com/levdinpaul/pochva-mcp.git
cd pochva-mcp
npm install
cp sample.txt myconfig   # rename .env.sample → fill in your tokens
npm run dev              # listens on :8788, POST /mcp
```

See `.env.sample` for all required environment variables.

## Security

- Inbound token (Claude → MCP) and outbound service token (MCP → core) are separate and independently revocable.
- The server port is never exposed publicly — only routed via nginx at `https://your-domain/mcp`.
- No request body or personal data is written to logs (only the fact of each call is audited).

## License

MIT © Pavel Levdin — https://pavellevdin.ru
