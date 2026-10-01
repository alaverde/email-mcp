import { ImapFlow, type ListResponse } from "imapflow";
import { requireConfig, type MailConfig } from "./config.js";
import { scrub } from "./text.js";

let client: ImapFlow | null = null;
let queue: Promise<void> = Promise.resolve();

const SPECIAL = {
  trash: {
    flag: "\\Trash",
    env: "TRASH_MAILBOX",
    names: ["INBOX.Trash", "Trash", "INBOX.trash", "Deleted", "INBOX.Deleted", "Deleted Items"],
  },
  drafts: {
    flag: "\\Drafts",
    env: "DRAFTS_MAILBOX",
    names: ["INBOX.Drafts", "Drafts"],
  },
  sent: {
    flag: "\\Sent",
    env: "SENT_MAILBOX",
    names: ["INBOX.Sent", "Sent", "Sent Items", "INBOX.Sent Items"],
  },
} as const;

export type SpecialKind = keyof typeof SPECIAL;

function configuredSpecial(config: MailConfig, kind: SpecialKind): string | undefined {
  if (kind === "trash") return config.trashMailbox;
  if (kind === "drafts") return config.draftsMailbox;
  return config.sentMailbox;
}

function isAuthFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { authenticationFailed?: boolean; name?: string };
  return candidate.authenticationFailed === true || candidate.name === "AuthenticationFailure";
}

export function cleanError(error: unknown): Error {
  if (isAuthFailure(error)) {
    return new Error("El servidor rechazó el usuario o la contraseña.");
  }
  if (error instanceof Error) return new Error(scrub(error.message));
  return new Error("Error desconocido");
}

async function resetClient(): Promise<void> {
  const current = client;
  client = null;
  if (!current) return;
  try {
    current.close();
  } catch {
    // La conexión ya no se puede cerrar.
  }
}

async function ensureClient(): Promise<ImapFlow> {
  if (client?.usable) return client;
  await resetClient();
  const config = requireConfig();
  const next = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapPort === 993,
    servername: config.imapHost,
    logger: false,
    emitLogs: false,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 120_000,
    tls: {
      rejectUnauthorized: config.rejectUnauthorized,
      servername: config.imapHost,
    },
    auth: {
      user: config.user,
      pass: config.password,
    },
    clientInfo: {
      name: "cpanel-mail-mcp",
      version: "0.1.0",
    },
  });
  next.on("error", (error: Error) => {
    console.error(`IMAP: ${scrub(error.message)}`);
  });

  try {
    await next.connect();
  } catch (error) {
    try {
      next.close();
    } catch {
      // El socket no llegó a abrirse.
    }
    throw cleanError(error);
  }

  client = next;
  return next;
}

export function withImap<T>(task: (client: ImapFlow, config: MailConfig) => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const config = requireConfig();
    const current = await ensureClient();
    try {
      return await task(current, config);
    } catch (error) {
      if (!current.usable) await resetClient();
      throw cleanError(error);
    }
  });
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function withMailbox<T>(
  mailbox: string,
  task: (client: ImapFlow, config: MailConfig) => Promise<T>,
): Promise<T> {
  return withImap(async (current, config) => {
    const lock = await current.getMailboxLock(mailbox);
    try {
      return await task(current, config);
    } finally {
      lock.release();
    }
  });
}

export async function resolveSpecial(current: ImapFlow, config: MailConfig, kind: SpecialKind): Promise<string> {
  const spec = SPECIAL[kind];
  const configured = configuredSpecial(config, kind);
  if (configured) return configured;

  const boxes = await current.list();
  const byFlag = boxes.find((box) => box.specialUse?.toLowerCase() === spec.flag.toLowerCase());
  if (byFlag) return byFlag.path;

  const names = new Set(spec.names.map((name) => name.toLowerCase()));
  const byName = boxes.find((box) => names.has(box.path.toLowerCase()) || names.has(box.name.toLowerCase()));
  if (byName) return byName.path;

  throw new Error(
    `No encontré la carpeta ${spec.flag}. Créala en el webmail o define ${spec.env} con el nombre exacto.`,
  );
}

export function mailboxSummary(box: ListResponse): Record<string, unknown> {
  return {
    path: box.path,
    name: box.name,
    delimiter: box.delimiter,
    specialUse: box.specialUse ?? null,
    flags: [...box.flags],
    messages: box.status?.messages ?? null,
    unseen: box.status?.unseen ?? null,
  };
}
