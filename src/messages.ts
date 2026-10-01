import { createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FetchMessageObject, MessageAddressObject, MessageStructureObject, SearchObject } from "imapflow";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import { requireConfig } from "./config.js";
import { mailboxSummary, resolveSpecial, withImap, withMailbox } from "./session.js";
import {
  LIMITS,
  assertMailbox,
  assertUids,
  isoDate,
  mapFlags,
  parseImapDate,
  resolveInside,
  truncate,
  stripHtml,
} from "./text.js";

export type Address = { name: string | null; address: string | null };

export type AttachmentInfo = {
  index: number;
  part: string;
  filename: string | null;
  contentType: string;
  size: number | null;
};

const SUMMARY_QUERY = {
  uid: true,
  flags: true,
  envelope: true,
  internalDate: true,
  size: true,
  bodyStructure: true,
} as const;

function addresses(value: MessageAddressObject[] | undefined): Address[] {
  return (value ?? []).map((item) => ({
    name: item.name || null,
    address: item.address || null,
  }));
}

function parsedAddresses(value: AddressObject | AddressObject[] | undefined): Address[] {
  if (!value) return [];
  const objects = Array.isArray(value) ? value : [value];
  return objects.flatMap((item) =>
    item.value.map((entry) => ({
      name: entry.name || null,
      address: entry.address || null,
    })),
  );
}

function stringList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function listAttachments(node: MessageStructureObject | undefined, acc: AttachmentInfo[] = []): AttachmentInfo[] {
  if (!node) return acc;
  if (node.childNodes?.length) {
    for (const child of node.childNodes) listAttachments(child, acc);
    return acc;
  }

  const filename = node.dispositionParameters?.filename || node.parameters?.name || null;
  const disposition = node.disposition?.toLowerCase() ?? "";
  const type = node.type.toLowerCase();
  const isText = type === "text" || type.startsWith("text/");
  const attached = disposition === "attachment" || (Boolean(filename) && disposition !== "inline" && !isText);
  if (!attached || !node.part) return acc;

  acc.push({
    index: acc.length,
    part: node.part,
    filename,
    contentType: node.type,
    size: node.size ?? null,
  });
  return acc;
}

function summarize(message: FetchMessageObject, mailbox: string): Record<string, unknown> {
  const envelope = message.envelope;
  const attachments = listAttachments(message.bodyStructure);
  return {
    mailbox,
    uid: message.uid,
    date: isoDate(envelope?.date ?? message.internalDate),
    from: addresses(envelope?.from),
    to: addresses(envelope?.to),
    subject: envelope?.subject ?? null,
    flags: message.flags ? [...message.flags] : [],
    size: message.size ?? null,
    seen: message.flags?.has("\\Seen") ?? false,
    flagged: message.flags?.has("\\Flagged") ?? false,
    answered: message.flags?.has("\\Answered") ?? false,
    attachments: attachments.length,
  };
}

function sortByDate(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  return messages.sort((left, right) => {
    const leftDate = typeof left.date === "string" ? left.date : "";
    const rightDate = typeof right.date === "string" ? right.date : "";
    if (leftDate === rightDate) return Number(right.uid) - Number(left.uid);
    if (!leftDate) return 1;
    if (!rightDate) return -1;
    return leftDate < rightDate ? 1 : -1;
  });
}

export async function listMailboxes(): Promise<Record<string, unknown>> {
  return withImap(async (client) => {
    let boxes;
    try {
      boxes = await client.list({ statusQuery: { messages: true, unseen: true } });
    } catch {
      boxes = await client.list();
    }
    const mailboxes = boxes
      .filter((box) => !box.flags.has("\\Noselect") && !box.flags.has("\\NonExistent"))
      .map(mailboxSummary);
    return { count: mailboxes.length, mailboxes };
  });
}

export async function unseenSummary(): Promise<Record<string, unknown>> {
  const listed = await listMailboxes();
  const mailboxes = (listed.mailboxes as Record<string, unknown>[]).filter(
    (box) => typeof box.unseen === "number" && box.unseen > 0,
  );
  return { count: mailboxes.length, mailboxes };
}

export async function mailboxStatus(mailbox: string): Promise<Record<string, unknown>> {
  const path = assertMailbox(mailbox);
  return withImap(async (client) => {
    const status = await client.status(path, { messages: true, unseen: true, recent: true });
    return {
      mailbox: path,
      messages: status.messages ?? 0,
      unseen: status.unseen ?? 0,
      recent: status.recent ?? 0,
    };
  });
}

async function fetchSummaries(
  mailbox: string,
  range: string | number[],
  limit: number,
): Promise<Record<string, unknown>> {
  return withMailbox(mailbox, async (client) => {
    const exists = client.mailbox && typeof client.mailbox === "object" ? client.mailbox.exists : 0;
    if (Array.isArray(range) && range.length === 0) {
      return { mailbox, exists, totalMatches: 0, returned: 0, messages: [] };
    }
    const fetched = await client.fetchAll(range, SUMMARY_QUERY, { uid: Array.isArray(range) });
    const messages = sortByDate(fetched.map((message) => summarize(message, mailbox))).slice(0, limit);
    return { mailbox, exists, returned: messages.length, messages };
  });
}

export async function listMessages(mailbox: string, limit: number, unreadOnly: boolean): Promise<Record<string, unknown>> {
  const path = assertMailbox(mailbox);
  if (unreadOnly) {
    const uids = await withMailbox(path, async (client) => {
      const found = await client.search({ seen: false }, { uid: true });
      if (!Array.isArray(found)) throw new Error("La búsqueda IMAP no devolvió resultados");
      return found;
    });
    const selected = uids.sort((a, b) => a - b).slice(-limit);
    const result = await fetchSummaries(path, selected, limit);
    return { ...result, totalMatches: uids.length, truncated: uids.length > selected.length };
  }

  return withMailbox(path, async (client) => {
    const exists = client.mailbox && typeof client.mailbox === "object" ? client.mailbox.exists : 0;
    if (exists === 0) return { mailbox: path, exists, returned: 0, messages: [] };
    const start = Math.max(1, exists - limit + 1);
    const fetched = await client.fetchAll(`${start}:*`, SUMMARY_QUERY);
    const messages = sortByDate(fetched.map((message) => summarize(message, path)));
    return { mailbox: path, exists, returned: messages.length, messages };
  });
}

export type MessageDetail = {
  mailbox: string;
  uid: number;
  subject: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: Address[];
  replyTo: Address[];
  to: Address[];
  cc: Address[];
  date: string | null;
  flags: string[];
  size: number | null;
  attachments: AttachmentInfo[];
  text: string | null;
  truncated: boolean;
  skippedBody: boolean;
};

function detailFromParsed(
  mailbox: string,
  uid: number,
  flags: string[],
  size: number | null,
  attachments: AttachmentInfo[],
  parsed: ParsedMail,
  maxChars: number,
): MessageDetail {
  const rawText = parsed.text?.trim() || (parsed.html ? stripHtml(parsed.html) : "");
  const body = rawText ? truncate(rawText, maxChars) : { text: "", truncated: false };
  return {
    mailbox,
    uid,
    subject: parsed.subject ?? null,
    messageId: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
    references: stringList(parsed.references),
    from: parsedAddresses(parsed.from),
    replyTo: parsedAddresses(parsed.replyTo),
    to: parsedAddresses(parsed.to),
    cc: parsedAddresses(parsed.cc),
    date: isoDate(parsed.date),
    flags,
    size,
    attachments,
    text: body.text || null,
    truncated: body.truncated,
    skippedBody: false,
  };
}

export async function getMessage(mailbox: string, uid: number, maxChars: number, markSeen: boolean): Promise<MessageDetail> {
  const path = assertMailbox(mailbox);
  assertUids([uid]);
  const chars = Math.min(Math.max(maxChars, 1), LIMITS.bodyMax);

  return withMailbox(path, async (client) => {
    const meta = await client.fetchOne(
      String(uid),
      { uid: true, flags: true, size: true, bodyStructure: true, envelope: true, internalDate: true },
      { uid: true },
    );
    if (!meta) throw new Error(`No hay un mensaje UID ${uid} en ${path}`);

    const flags = meta.flags ? [...meta.flags] : [];
    const attachments = listAttachments(meta.bodyStructure);
    const size = meta.size ?? 0;
    if (size > LIMITS.maxParseBytes) {
      if (markSeen) await client.messageFlagsAdd([uid], ["\\Seen"], { uid: true });
      return {
        mailbox: path,
        uid,
        subject: meta.envelope?.subject ?? null,
        messageId: meta.envelope?.messageId ?? null,
        inReplyTo: meta.envelope?.inReplyTo ?? null,
        references: [],
        from: addresses(meta.envelope?.from),
        replyTo: addresses(meta.envelope?.replyTo),
        to: addresses(meta.envelope?.to),
        cc: addresses(meta.envelope?.cc),
        date: isoDate(meta.envelope?.date ?? meta.internalDate),
        flags: markSeen ? [...new Set([...flags, "\\Seen"])] : flags,
        size,
        attachments,
        text: null,
        truncated: false,
        skippedBody: true,
      };
    }

    const full = await client.fetchOne(String(uid), { source: true, uid: true }, { uid: true });
    if (full === false || !full.source) throw new Error(`No pude descargar el mensaje UID ${uid}`);
    const parsed = await simpleParser(full.source);
    if (markSeen) await client.messageFlagsAdd([uid], ["\\Seen"], { uid: true });
    return detailFromParsed(path, uid, markSeen ? [...new Set([...flags, "\\Seen"])] : flags, size, attachments, parsed, chars);
  });
}

export async function searchMessages(input: {
  mailbox: string;
  limit: number;
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  since?: string;
  before?: string;
  unreadOnly?: boolean;
  flagged?: boolean;
}): Promise<Record<string, unknown>> {
  const path = assertMailbox(input.mailbox);
  const query: SearchObject = {};
  if (input.from) query.from = input.from;
  if (input.to) query.to = input.to;
  if (input.subject) query.subject = input.subject;
  if (input.text) query.text = input.text;
  if (input.since) query.since = parseImapDate(input.since, "since");
  if (input.before) query.before = parseImapDate(input.before, "before");
  if (input.unreadOnly) query.seen = false;
  if (input.flagged) query.flagged = true;
  if (Object.keys(query).length === 0) {
    throw new Error("Indica al menos un criterio: from, to, subject, text, since, before, unread_only o flagged.");
  }

  const found = await withMailbox(path, async (client) => client.search(query, { uid: true }));
  if (!Array.isArray(found)) throw new Error("La búsqueda IMAP no devolvió resultados");
  const uids = found;
  const selected = uids.sort((a, b) => a - b).slice(-input.limit);
  const result = await fetchSummaries(path, selected, input.limit);
  return { ...result, totalMatches: uids.length, truncated: uids.length > selected.length };
}

export async function moveMessages(mailbox: string, destination: string, uids: number[]): Promise<Record<string, unknown>> {
  const source = assertMailbox(mailbox);
  const target = assertMailbox(destination);
  const ids = assertUids(uids);
  if (source.toLowerCase() === target.toLowerCase()) {
    throw new Error("La carpeta de origen y la de destino son la misma");
  }

  return withMailbox(source, async (client) => {
    const moved = await client.messageMove(ids, target, { uid: true });
    if (!moved) throw new Error("El servidor no confirmó el traslado");
    const uidMap = moved.uidMap
      ? Object.fromEntries([...moved.uidMap].map(([from, to]) => [String(from), to]))
      : null;
    return { source, destination: moved.destination || target, uids: ids, uidMap };
  });
}

export async function setFlags(
  mailbox: string,
  uids: number[],
  add: string[],
  remove: string[],
): Promise<Record<string, unknown>> {
  const path = assertMailbox(mailbox);
  const ids = assertUids(uids);
  const addFlags = mapFlags(add);
  const removeFlags = mapFlags(remove);
  if (addFlags.length === 0 && removeFlags.length === 0) {
    throw new Error("Indica banderas en add o remove");
  }

  return withMailbox(path, async (client) => {
    if (addFlags.length > 0) {
      const added = await client.messageFlagsAdd(ids, addFlags, { uid: true });
      if (!added) throw new Error("El servidor no confirmó las banderas añadidas");
    }
    if (removeFlags.length > 0) {
      const removed = await client.messageFlagsRemove(ids, removeFlags, { uid: true });
      if (!removed) throw new Error("El servidor no confirmó las banderas quitadas");
    }
    return { mailbox: path, uids: ids, added: addFlags, removed: removeFlags };
  });
}

export async function createMailbox(mailbox: string): Promise<Record<string, unknown>> {
  const path = assertMailbox(mailbox);
  return withImap(async (client) => {
    const created = await client.mailboxCreate(path);
    let subscribed = true;
    try {
      subscribed = await client.mailboxSubscribe(created.path);
    } catch {
      subscribed = false;
    }
    return { path: created.path, subscribed };
  });
}

export async function deleteMessages(
  mailbox: string,
  uids: number[],
  permanent: boolean,
): Promise<Record<string, unknown>> {
  const path = assertMailbox(mailbox);
  const ids = assertUids(uids);
  const config = requireConfig();
  if (permanent && !config.allowExpunge) {
    throw new Error(
      "El borrado permanente está desactivado. delete_messages mueve a la papelera. Define MAIL_ALLOW_EXPUNGE=true y vuelve a llamar con permanent=true.",
    );
  }

  return withImap(async (client, current) => {
    const trash = await resolveSpecial(client, current, "trash");
    const alreadyTrash = path.toLowerCase() === trash.toLowerCase();
    if (permanent) {
      if (!alreadyTrash) {
        throw new Error(`permanent=true solo borra dentro de la papelera (${trash}). Muévelos antes.`);
      }
      const lock = await client.getMailboxLock(path);
      try {
        const deleted = await client.messageDelete(ids, { uid: true });
        if (!deleted) throw new Error("El servidor no confirmó el borrado");
        return { mailbox: path, trash, permanent: true, uids: ids };
      } finally {
        lock.release();
      }
    }

    if (alreadyTrash) {
      return {
        mailbox: path,
        trash,
        moved: false,
        uids: ids,
        note: "Esos mensajes ya están en la papelera. No se borraron de forma permanente.",
      };
    }

    const lock = await client.getMailboxLock(path);
    try {
      const moved = await client.messageMove(ids, trash, { uid: true });
      if (!moved) throw new Error("El servidor no confirmó el traslado a la papelera");
      return { mailbox: path, trash: moved.destination || trash, moved: true, uids: ids };
    } finally {
      lock.release();
    }
  });
}

function byteCap(maxBytes: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > maxBytes) {
        callback(new Error("El adjunto supera 15 MB"));
        return;
      }
      callback(null, chunk);
    },
  });
}

export async function saveAttachment(
  mailbox: string,
  uid: number,
  index: number,
  directory: string,
): Promise<Record<string, unknown>> {
  const path = assertMailbox(mailbox);
  assertUids([uid]);
  const folder = await stat(directory).catch(() => null);
  if (!folder?.isDirectory()) throw new Error("output_directory no existe o no es una carpeta");

  return withMailbox(path, async (client) => {
    const meta = await client.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
    if (!meta) throw new Error(`No hay un mensaje UID ${uid} en ${path}`);
    const attachments = listAttachments(meta.bodyStructure);
    const attachment = attachments.find((item) => item.index === index);
    if (!attachment) throw new Error(`El mensaje no tiene un adjunto con índice ${index}`);
    if (attachment.size !== null && attachment.size > LIMITS.maxAttachmentBytes) {
      throw new Error("El adjunto supera 15 MB");
    }

    const filename = attachment.filename || `adjunto-${index}.bin`;
    const destination = resolveInside(directory, filename);
    const downloaded = await client.download(String(uid), attachment.part, { uid: true });
    try {
      await pipeline(downloaded.content, byteCap(LIMITS.maxAttachmentBytes), createWriteStream(destination));
    } catch (error) {
      await rm(destination, { force: true });
      throw error;
    }
    return {
      mailbox: path,
      uid,
      index,
      filename,
      contentType: attachment.contentType,
      path: destination,
    };
  });
}
