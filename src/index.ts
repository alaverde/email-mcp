import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { configStatus, loadEnvFile } from "./config.js";
import {
  createMailbox,
  deleteMessages,
  getMessage,
  listMailboxes,
  listMessages,
  mailboxStatus,
  moveMessages,
  saveAttachment,
  searchMessages,
  setFlags,
  unseenSummary,
} from "./messages.js";
import { createDraft, replyToMessage, sendMessage, verifySmtp } from "./outbound.js";
import { LIMITS, scrub } from "./text.js";

const INSTRUCTIONS = `
Servidor de correo cPanel. IMAP lee y organiza; SMTP envía solo si MAIL_ALLOW_SEND=true.
La contraseña llega por el entorno y no debe mostrarse nunca.

Para organizar:
1. check_connection.
2. unseen_summary o list_mailboxes. En cPanel las rutas suelen ser INBOX, INBOX.Sent, INBOX.Drafts, INBOX.Trash e INBOX.Junk. Usa el path exacto.
3. list_messages o search_messages.
4. get_message solo cuando el asunto no baste para clasificar.
5. create_mailbox si hace falta una carpeta, luego move_messages y set_flags.
6. delete_messages mueve a la papelera. El borrado permanente exige MAIL_ALLOW_EXPUNGE=true y permanent=true, y solo dentro de la papelera.

No envíes ni respondas correo si la persona no lo pidió en este turno. Antes de un lote grande, resume qué vas a mover y a qué carpeta.
`.trim();

const mailbox = z.string().min(1).max(200).describe("Ruta exacta de la carpeta, por ejemplo INBOX o INBOX.Trabajo");
const uids = z.array(z.number().int().positive()).min(1).max(LIMITS.maxUids).describe("UID de IMAP, no el número de secuencia");
const limit = z.number().int().min(1).max(LIMITS.listMax).optional().describe(`Cantidad máxima, entre 1 y ${LIMITS.listMax}`);
const flags = z.array(z.enum(["seen", "flagged", "answered", "deleted", "draft"])).optional().describe("Banderas IMAP");

type ToolResult = { content: [{ type: "text"; text: string }]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : "Error desconocido";
  return { content: [{ type: "text", text: scrub(message) }], isError: true };
}

async function run(task: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await task());
  } catch (error) {
    return fail(error);
  }
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "cpanel-mail-mcp", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "mail_config_status",
    {
      title: "Estado de la configuración",
      description: "Muestra la configuración pública del correo, sin la contraseña, y qué variables faltan.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => ok(configStatus()),
  );

  server.registerTool(
    "check_connection",
    {
      title: "Probar IMAP y SMTP",
      description: "Inicia sesión en IMAP y comprueba la autenticación SMTP sin enviar correo. Úsala antes de organizar.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      run(async () => {
        const imap = await mailboxStatus("INBOX").then(
          (status) => ({ ok: true as const, ...status }),
          (error: unknown) => ({
            ok: false as const,
            error: scrub(error instanceof Error ? error.message : "Error IMAP"),
          }),
        );
        const smtp = await verifySmtp().then(
          (status) => status,
          (error: unknown) => ({
            ok: false as const,
            error: scrub(error instanceof Error ? error.message : "Error SMTP"),
          }),
        );
        return { ok: imap.ok && smtp.ok === true, imap, smtp };
      }),
  );

  server.registerTool(
    "list_mailboxes",
    {
      title: "Listar carpetas",
      description: "Lista las carpetas IMAP con su ruta exacta, el uso especial (\\Trash, \\Sent, \\Drafts, \\Junk) y, si el servidor lo permite, el total y los no leídos.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => run(() => listMailboxes()),
  );

  server.registerTool(
    "unseen_summary",
    {
      title: "Resumen de no leídos",
      description: "Devuelve solo las carpetas que tienen mensajes no leídos. Es el punto de partida para organizar.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => run(() => unseenSummary()),
  );

  server.registerTool(
    "mailbox_status",
    {
      title: "Estado de una carpeta",
      description: "Cuenta mensajes, no leídos y recientes de una carpeta.",
      inputSchema: { mailbox: mailbox.optional().describe("Por defecto INBOX") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ mailbox: box }) => run(() => mailboxStatus(box ?? "INBOX")),
  );

  server.registerTool(
    "list_messages",
    {
      title: "Listar mensajes",
      description: "Lista los mensajes más recientes de una carpeta: UID, fecha, remitente, asunto, banderas y si tiene adjuntos. No descarga el cuerpo.",
      inputSchema: {
        mailbox: mailbox.optional(),
        limit,
        unread_only: z.boolean().optional().describe("Si es true, solo mensajes sin la bandera \\Seen"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ mailbox: box, limit: count, unread_only }) =>
      run(() => listMessages(box ?? "INBOX", count ?? LIMITS.listDefault, unread_only ?? false)),
  );

  server.registerTool(
    "get_message",
    {
      title: "Leer un mensaje",
      description: "Lee un mensaje por UID. Devuelve texto plano recortado y la lista de adjuntos. No lo marca como leído salvo mark_seen=true. Si el mensaje supera 2 MB, omite el cuerpo.",
      inputSchema: {
        mailbox: mailbox.optional(),
        uid: z.number().int().positive(),
        max_chars: z.number().int().min(1).max(LIMITS.bodyMax).optional(),
        mark_seen: z.boolean().optional().describe("Marca el mensaje como leído"),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ mailbox: box, uid, max_chars, mark_seen }) =>
      run(() => getMessage(box ?? "INBOX", uid, max_chars ?? LIMITS.bodyDefault, mark_seen ?? false)),
  );

  server.registerTool(
    "search_messages",
    {
      title: "Buscar mensajes",
      description: "Busca dentro de una carpeta. Exige al menos un criterio. since y before usan YYYY-MM-DD. Devuelve los UID más altos, que en cPanel suelen ser los más nuevos.",
      inputSchema: {
        mailbox: mailbox.optional(),
        limit,
        from: z.string().optional(),
        to: z.string().optional(),
        subject: z.string().optional(),
        text: z.string().optional().describe("Texto en cabeceras o cuerpo"),
        since: z.string().optional().describe("YYYY-MM-DD, inclusive"),
        before: z.string().optional().describe("YYYY-MM-DD, anterior a ese día"),
        unread_only: z.boolean().optional(),
        flagged: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) =>
      run(() =>
        searchMessages({
          mailbox: input.mailbox ?? "INBOX",
          limit: input.limit ?? LIMITS.listDefault,
          from: input.from,
          to: input.to,
          subject: input.subject,
          text: input.text,
          since: input.since,
          before: input.before,
          unreadOnly: input.unread_only,
          flagged: input.flagged,
        }),
      ),
  );

  server.registerTool(
    "move_messages",
    {
      title: "Mover mensajes",
      description: "Mueve mensajes por UID de una carpeta a otra. La destino tiene que existir; créala antes con create_mailbox.",
      inputSchema: { mailbox, destination: mailbox, uids },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ mailbox: box, destination, uids: ids }) => run(() => moveMessages(box, destination, ids)),
  );

  server.registerTool(
    "set_flags",
    {
      title: "Cambiar banderas",
      description: "Añade o quita banderas: seen (leído), flagged (destacado), answered (respondido), deleted o draft.",
      inputSchema: { mailbox: mailbox.optional(), uids, add: flags, remove: flags },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ mailbox: box, uids: ids, add, remove }) =>
      run(() => setFlags(box ?? "INBOX", ids, add ?? [], remove ?? [])),
  );

  server.registerTool(
    "create_mailbox",
    {
      title: "Crear carpeta",
      description: "Crea una carpeta IMAP y la suscribe. En cPanel usa un prefijo como INBOX.Clientes o INBOX.Facturas.",
      inputSchema: { mailbox },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ mailbox: box }) => run(() => createMailbox(box)),
  );

  server.registerTool(
    "delete_messages",
    {
      title: "Enviar a la papelera",
      description: "Mueve los UID a la papelera. Si ya están ahí, no los borra. permanent=true los expulsa solo si MAIL_ALLOW_EXPUNGE=true y la carpeta es la papelera.",
      inputSchema: {
        mailbox: mailbox.optional(),
        uids,
        permanent: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ mailbox: box, uids: ids, permanent }) =>
      run(() => deleteMessages(box ?? "INBOX", ids, permanent ?? false)),
  );

  server.registerTool(
    "save_attachment",
    {
      title: "Guardar adjunto",
      description: "Guarda un adjunto en un directorio local que ya exista. El índice sale de get_message. El nombre se sanea y no puede salir de ese directorio.",
      inputSchema: {
        mailbox: mailbox.optional(),
        uid: z.number().int().positive(),
        index: z.number().int().min(0),
        output_directory: z.string().min(1),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ mailbox: box, uid, index, output_directory }) =>
      run(() => saveAttachment(box ?? "INBOX", uid, index, output_directory)),
  );

  server.registerTool(
    "create_draft",
    {
      title: "Crear borrador",
      description: "Guarda un borrador en la carpeta Drafts. No envía el correo.",
      inputSchema: {
        to: z.union([z.string(), z.array(z.string())]).optional(),
        cc: z.union([z.string(), z.array(z.string())]).optional(),
        bcc: z.union([z.string(), z.array(z.string())]).optional(),
        subject: z.string().optional(),
        text: z.string().optional(),
        html: z.string().optional(),
        attachment_paths: z.array(z.string()).max(LIMITS.maxAttachments).optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (input) =>
      run(() =>
        createDraft({
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject: input.subject,
          text: input.text,
          html: input.html,
          attachmentPaths: input.attachment_paths,
        }),
      ),
  );

  server.registerTool(
    "send_message",
    {
      title: "Enviar correo",
      description: "Envía un correo por SMTP y guarda copia en Enviados. Falla si MAIL_ALLOW_SEND no es true. No lo uses sin un pedido explícito de la persona en este turno.",
      inputSchema: {
        to: z.union([z.string(), z.array(z.string())]),
        cc: z.union([z.string(), z.array(z.string())]).optional(),
        bcc: z.union([z.string(), z.array(z.string())]).optional(),
        subject: z.string().min(1),
        text: z.string().optional(),
        html: z.string().optional(),
        attachment_paths: z.array(z.string()).max(LIMITS.maxAttachments).optional().describe("Rutas locales de archivos"),
        in_reply_to: z.string().optional(),
        references: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (input) =>
      run(() =>
        sendMessage({
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject: input.subject,
          text: input.text,
          html: input.html,
          attachmentPaths: input.attachment_paths,
          inReplyTo: input.in_reply_to,
          references: input.references,
        }),
      ),
  );

  server.registerTool(
    "reply_message",
    {
      title: "Responder",
      description: "Responde a un UID, cita el texto original y marca el mensaje como respondido. Exige MAIL_ALLOW_SEND=true y un pedido explícito de la persona.",
      inputSchema: {
        mailbox: mailbox.optional(),
        uid: z.number().int().positive(),
        text: z.string().min(1),
        reply_all: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ mailbox: box, uid, text, reply_all }) =>
      run(() => replyToMessage({ mailbox: box ?? "INBOX", uid, text, replyAll: reply_all ?? false })),
  );

  server.registerPrompt(
    "organizar_bandeja",
    {
      title: "Organizar la bandeja",
      description: "Pide un plan para clasificar INBOX sin borrar nada de forma permanente.",
    },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Organiza mi correo de cPanel. Empieza por check_connection y unseen_summary. Propón carpetas con el prefijo INBOX. antes de crearlas. Mueve solo cuando el asunto y el remitente basten; lee el cuerpo si hay duda. No borres de forma permanente y no envíes nada. Al final dame un resumen por carpeta.",
          },
        },
      ],
    }),
  );

  return server;
}

async function main(): Promise<void> {
  loadEnvFile();
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("cpanel-mail-mcp listo (stdio)");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Error al iniciar";
  console.error(scrub(message));
  process.exit(1);
});
