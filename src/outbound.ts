import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import type { MailConfig } from "./config.js";
import { requireConfig } from "./config.js";
import { getMessage } from "./messages.js";
import { setFlags } from "./messages.js";
import { resolveSpecial, withImap } from "./session.js";
import { LIMITS, parseRecipients, quoteText, scrub } from "./text.js";

type Attachment = { filename: string; content: Buffer };

export type OutboundMessage = {
  to?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject?: string;
  text?: string;
  html?: string;
  attachmentPaths?: string[];
  inReplyTo?: string;
  references?: string[];
};

const SEND_DISABLED =
  "El envío está desactivado. Define MAIL_ALLOW_SEND=true para usar send_message y reply_message.";

function fromHeader(config: MailConfig): string {
  if (!config.fromName) return config.user;
  return `"${config.fromName.replace(/["\r\n]/g, "")}" <${config.user}>`;
}

function emailAddress(value: string): string {
  const match = value.match(/<([^>]+)>\s*$/);
  return (match?.[1] ?? value).trim();
}

function assertBody(text: string | undefined, html: string | undefined, requireContent: boolean): void {
  if ((text?.length ?? 0) > LIMITS.maxTextChars || (html?.length ?? 0) > LIMITS.maxTextChars) {
    throw new Error("El cuerpo supera el máximo de 100000 caracteres");
  }
  if (requireContent && !text?.trim() && !html?.trim()) {
    throw new Error("Falta el cuerpo del mensaje");
  }
}

async function loadAttachments(paths: string[] | undefined): Promise<Attachment[]> {
  const files = paths ?? [];
  if (files.length > LIMITS.maxAttachments) {
    throw new Error(`Máximo ${LIMITS.maxAttachments} adjuntos`);
  }
  let total = 0;
  const attachments: Attachment[] = [];
  for (const filePath of files) {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error(`No es un archivo: ${filePath}`);
    if (info.size > LIMITS.maxAttachmentBytes) throw new Error(`El adjunto supera 15 MB: ${filePath}`);
    total += info.size;
    if (total > LIMITS.maxAttachmentTotalBytes) throw new Error("Los adjuntos superan 20 MB en total");
    attachments.push({ filename: basename(filePath), content: await readFile(filePath) });
  }
  return attachments;
}

function createTransport(config: MailConfig) {
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: { user: config.user, pass: config.password },
    logger: false,
    disableFileAccess: true,
    disableUrlAccess: true,
    tls: {
      rejectUnauthorized: config.rejectUnauthorized,
      servername: config.smtpHost,
    },
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

function listed(value: string | string[] | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = (Array.isArray(value) ? value : [value]).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

async function compileRaw(config: MailConfig, message: OutboundMessage, attachments: Attachment[]): Promise<Buffer> {
  const composer = new MailComposer({
    from: fromHeader(config),
    to: listed(message.to),
    cc: listed(message.cc),
    bcc: listed(message.bcc),
    subject: message.subject,
    text: message.text,
    html: message.html,
    inReplyTo: message.inReplyTo,
    references: message.references,
    attachments,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return composer.compile().build();
}

async function saveToSent(raw: Buffer): Promise<Record<string, unknown>> {
  try {
    return await withImap(async (client, config) => {
      let mailbox: string;
      try {
        mailbox = await resolveSpecial(client, config, "sent");
      } catch (error) {
        const reason = error instanceof Error ? error.message : "No encontré la carpeta de enviados";
        return { saved: false, warning: `${reason} El correo sí se envió.` };
      }
      const appended = await client.append(mailbox, raw, ["\\Seen"]);
      if (!appended) {
        return { saved: false, mailbox, warning: "No pude guardar la copia en Enviados. El correo sí se envió." };
      }
      return { saved: true, mailbox, uid: appended.uid ?? null };
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Error al guardar en Enviados";
    return { saved: false, warning: `${scrub(reason)} El correo sí se envió.` };
  }
}

export async function verifySmtp(): Promise<Record<string, unknown>> {
  const config = requireConfig();
  const transporter = createTransport(config);
  try {
    await transporter.verify();
    return { ok: true, host: config.smtpHost, port: config.smtpPort };
  } finally {
    transporter.close();
  }
}

export async function sendMessage(message: OutboundMessage): Promise<Record<string, unknown>> {
  const config = requireConfig();
  if (!config.allowSend) throw new Error(SEND_DISABLED);

  const to = parseRecipients(message.to, "to");
  const cc = parseRecipients(message.cc, "cc");
  const bcc = parseRecipients(message.bcc, "bcc");
  if (to.length + cc.length + bcc.length === 0) throw new Error("Indica al menos un destinatario");
  if (to.length + cc.length + bcc.length > LIMITS.maxRecipients) {
    throw new Error(`Hay más de ${LIMITS.maxRecipients} destinatarios`);
  }
  if (!message.subject?.trim()) throw new Error("Falta el asunto");
  assertBody(message.text, message.html, true);

  const normalized: OutboundMessage = { ...message, to, cc, bcc, subject: message.subject.trim() };
  const attachments = await loadAttachments(message.attachmentPaths);
  const raw = await compileRaw(config, normalized, attachments);
  const transporter = createTransport(config);
  try {
    const info = await transporter.sendMail({
      raw,
      envelope: {
        from: config.user,
        to: [...to, ...cc, ...bcc].map(emailAddress),
      },
    });
    const savedToSent = await saveToSent(raw);
    return {
      sent: true,
      messageId: info.messageId ?? null,
      accepted: info.accepted ?? [],
      rejected: info.rejected ?? [],
      savedToSent,
    };
  } finally {
    transporter.close();
  }
}

export async function createDraft(message: OutboundMessage): Promise<Record<string, unknown>> {
  const config = requireConfig();
  const to = parseRecipients(message.to, "to");
  const cc = parseRecipients(message.cc, "cc");
  const bcc = parseRecipients(message.bcc, "bcc");
  if (!message.subject?.trim() && !message.text?.trim() && !message.html?.trim()) {
    throw new Error("El borrador necesita asunto o cuerpo");
  }
  assertBody(message.text, message.html, false);
  const attachments = await loadAttachments(message.attachmentPaths);
  const raw = await compileRaw(
    config,
    { ...message, to, cc, bcc, subject: message.subject?.trim() },
    attachments,
  );

  return withImap(async (client, current) => {
    let mailbox = current.draftsMailbox;
    if (!mailbox) {
      try {
        mailbox = await resolveSpecial(client, current, "drafts");
      } catch {
        mailbox = "INBOX.Drafts";
        await client.mailboxCreate(mailbox);
        try {
          await client.mailboxSubscribe(mailbox);
        } catch {
          // La carpeta queda creada aunque el servidor no acepte la suscripción.
        }
      }
    }
    const appended = await client.append(mailbox, raw, ["\\Draft", "\\Seen"]);
    if (!appended) throw new Error("No pude guardar el borrador");
    return { mailbox, uid: appended.uid ?? null };
  });
}

export async function replyToMessage(input: {
  mailbox: string;
  uid: number;
  text: string;
  replyAll: boolean;
}): Promise<Record<string, unknown>> {
  const config = requireConfig();
  if (!config.allowSend) throw new Error(SEND_DISABLED);
  if (!input.text.trim()) throw new Error("Falta el texto de la respuesta");

  const original = await getMessage(input.mailbox, input.uid, 2000, false);
  const target = original.replyTo.find((item) => item.address)?.address ?? original.from.find((item) => item.address)?.address;
  if (!target) throw new Error("El mensaje no tiene una dirección a la que responder");

  const own = config.user.toLowerCase();
  const cc = input.replyAll
    ? [...new Set(
        [...original.to, ...original.cc]
          .map((item) => item.address)
          .filter((address): address is string => Boolean(address))
          .filter((address) => {
            const value = address.toLowerCase();
            return value !== own && value !== target.toLowerCase();
          }),
      )]
    : [];

  const subject = original.subject && /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject ?? ""}`;
  const references = [...original.references, original.messageId].filter((value): value is string => Boolean(value));
  const sent = await sendMessage({
    to: [target],
    cc,
    subject,
    text: `${input.text.trim()}\n\n${quoteText(original.text ?? "")}`,
    inReplyTo: original.messageId ?? undefined,
    references,
  });

  let flagged = true;
  try {
    await setFlags(input.mailbox, [input.uid], ["answered"], []);
  } catch {
    flagged = false;
  }

  return { ...sent, repliedToUid: input.uid, answeredFlag: flagged };
}
