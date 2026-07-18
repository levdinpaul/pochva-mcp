import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { core, query } from "./coreClient.js";

/** Единый формат ответа tool: текстовый блок с JSON от ядра. */
function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * Набор tools = тонкие обёртки над эндпоинтами pochva-core (см. контракт в README).
 * Никакой бизнес-логики здесь: распарсить аргументы, вызвать ядро, вернуть ответ.
 * Контракт эндпоинтов финализируется в Фазе 1 (M3) — при расхождении правим здесь и в ядре синхронно.
 */
export function registerTools(server: McpServer): void {
  server.registerTool(
    "pochva_ingest",
    {
      title: "Разобрать надиктовку",
      description:
        "Свободный текст → сущности (задача/событие/документ). Пример: «термин в Jobcenter 22 июля 11:00 кабинет 3.11» → событие.",
      inputSchema: { text: z.string().min(1).describe("Свободный текст надиктовки") },
    },
    async ({ text }) => ok(await core.post("/api/ingest", { text })),
  );

  server.registerTool(
    "pochva_add",
    {
      title: "Добавить явно",
      description: "Явно создать сущность, когда тип уже известен и парсер не нужен.",
      inputSchema: {
        type: z.enum(["task", "document", "event", "entry"]).describe("Тип сущности"),
        text: z.string().optional().describe("Текст задачи/записи"),
        direction: z.string().optional().describe("Код направления (doc/home/lang/money/kids/self)"),
        date: z.string().optional().describe("Дата YYYY-MM-DD (для задачи — due)"),
        size: z.enum(["big", "small"]).optional().describe("Размер задачи"),
      },
    },
    async (args) => ok(await core.post("/api/items", args)),
  );

  server.registerTool(
    "pochva_list",
    {
      title: "Что открыто",
      description: "Открытые задачи и ближайшие события, опционально по направлению.",
      inputSchema: {
        direction: z.string().optional().describe("Код направления"),
        status: z.enum(["open", "done"]).optional().describe("По умолчанию open"),
      },
    },
    async (args) => ok(await core.get(`/api/list${query(args)}`)),
  );

  server.registerTool(
    "pochva_close",
    {
      title: "Закрыть задачу",
      description: "Отметить задачу выполненной по её id.",
      inputSchema: { id: z.string().describe("id задачи") },
    },
    async ({ id }) => ok(await core.post(`/api/tasks/${encodeURIComponent(id)}/close`)),
  );

  server.registerTool(
    "pochva_digest",
    {
      title: "Что горит сегодня",
      description: "Сводка: задачи с датой, события и истекающие документы в горизонте.",
      inputSchema: {},
    },
    async () => ok(await core.get("/api/digest")),
  );

  server.registerTool(
    "pochva_doc_add",
    {
      title: "Добавить документ",
      description: "Документ (только метаданные): название, орган, номер, срок действия.",
      inputSchema: {
        title: z.string().describe("Название документа"),
        kind: z.string().optional(),
        number: z.string().optional().describe("Номер документа/дела"),
        authority: z.string().optional().describe("Орган"),
        expires_on: z.string().optional().describe("Срок действия YYYY-MM-DD"),
        note: z.string().optional(),
      },
    },
    async (args) => ok(await core.post("/api/documents", args)),
  );

  server.registerTool(
    "pochva_doc_expiring",
    {
      title: "Что истекает",
      description: "Документы с истекающим сроком действия.",
      inputSchema: {
        within: z.number().int().positive().optional().describe("В пределах N дней (по умолчанию 30)"),
      },
    },
    async ({ within }) => ok(await core.get(`/api/documents/expiring${query({ within })}`)),
  );

  // ── чек-листы (M4, шаг 2): проектные списки со стойкой отметкой «сделано» ──
  server.registerTool(
    "pochva_checklist_add",
    {
      title: "Создать чек-лист",
      description:
        "Проектный список пунктов (отметка «сделано» держится, не сбрасывается как практика дня). Можно привязать к задаче через task_id — тогда у задачи виден прогресс N/M.",
      inputSchema: {
        title: z.string().min(1).describe("Название чек-листа"),
        direction: z.string().optional().describe("Код направления (doc/home/lang/money/kids/self)"),
        task_id: z.string().optional().describe("id задачи, к которой привязать чек-лист"),
      },
    },
    async (args) => ok(await core.post("/api/checklists", args)),
  );

  server.registerTool(
    "pochva_checklist_item_add",
    {
      title: "Добавить пункт",
      description: "Добавить пункт в конец чек-листа.",
      inputSchema: {
        checklist_id: z.string().describe("id чек-листа"),
        text: z.string().min(1).describe("Текст пункта"),
      },
    },
    async (args) => ok(await core.post("/api/checklists/item", args)),
  );

  server.registerTool(
    "pochva_checklist_item_toggle",
    {
      title: "Отметить пункт",
      description: "Отметить/снять пункт чек-листа. Без done — переключает текущее состояние.",
      inputSchema: {
        item_id: z.string().describe("id пункта"),
        done: z.boolean().optional().describe("true — сделано, false — снять; без поля — переключить"),
      },
    },
    async (args) => ok(await core.post("/api/checklists/item/toggle", args)),
  );

  server.registerTool(
    "pochva_checklist_list",
    {
      title: "Чек-листы",
      description: "Все чек-листы с пунктами (по порядку) и прогрессом «сделано/всего».",
      inputSchema: {},
    },
    async () => ok(await core.get("/api/checklists")),
  );
}
