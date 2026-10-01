import { isAbsolute, relative, resolve } from "node:path";

export const LIMITS = {
  listDefault: 20,
  listMax: 50,
  bodyDefault: 8000,
  bodyMax: 20000,
  maxParseBytes: 2 * 1024 * 1024,
  maxAttachmentBytes: 15 * 1024 * 1024,
  maxAttachmentTotalBytes: 20 * 1024 * 1024,
  maxAttachments: 5,
  maxRecipients: 20,
  maxUids: 50,
  maxTextChars: 100_000,
};

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function scrub(message: string, secret: string | undefined = process.env.MAIL_PASSWORD): string {
  if (!secret || secret.length < 4 || !message.includes(secret)) return message;
  return message.split(secret).join("[redactado]");
}

export function truncate(value: string, max: number): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  return { text: `${value.slice(0, max)}\n…[recortado]`, truncated: true };
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function parseImapDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${label} debe tener la forma YYYY-MM-DD`);
  }
  return value;
}

export function assertMailbox(mailbox: string): string {
  const value = mailbox.trim();
  if (!value || value.length > 200 || /[\r\n]/.test(value)) {
    throw new Error("Nombre de carpeta no válido");
  }
  return value;
}

export function assertUids(uids: number[]): number[] {
  if (uids.length < 1 || uids.length > LIMITS.maxUids) {
    throw new Error(`Indica entre 1 y ${LIMITS.maxUids} UID`);
  }
  for (const uid of uids) {
    if (!Number.isInteger(uid) || uid < 1) throw new Error(`UID no válido: ${uid}`);
  }
  return uids;
}

export function parseRecipients(value: string | string[] | undefined, label: string): string[] {
  if (value === undefined) return [];
  const parts = (Array.isArray(value) ? value : value.split(","))
    .map((item) => item.trim())
    .filter(Boolean);
  if (parts.length > LIMITS.maxRecipients) {
    throw new Error(`${label} admite como máximo ${LIMITS.maxRecipients} destinatarios`);
  }
  for (const part of parts) {
    const match = part.match(/<([^>]+)>\s*$/);
    const email = (match?.[1] ?? part).trim();
    if (!EMAIL.test(email)) throw new Error(`${label} no es un correo válido: ${part}`);
  }
  return parts;
}

export function resolveInside(directory: string, filename: string): string {
  const root = resolve(directory);
  const safeName = filename
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  if (!safeName) throw new Error("Nombre de archivo no válido");
  const destination = resolve(root, safeName);
  const rel = relative(root, destination);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("La ruta del adjunto sale del directorio indicado");
  }
  return destination;
}

const FLAG_MAP: Record<string, string> = {
  seen: "\\Seen",
  flagged: "\\Flagged",
  answered: "\\Answered",
  deleted: "\\Deleted",
  draft: "\\Draft",
};

export function mapFlags(names: string[]): string[] {
  return names.map((name) => {
    const flag = FLAG_MAP[name.trim().toLowerCase()];
    if (!flag) {
      throw new Error(`Bandera desconocida: ${name}. Usa seen, flagged, answered, deleted o draft`);
    }
    return flag;
  });
}

export function isoDate(value: Date | string | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function quoteText(value: string, max = 2000): string {
  const clipped = truncate(value.replace(/\r\n/g, "\n"), max).text;
  return clipped
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}
