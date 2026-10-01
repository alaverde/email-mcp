import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type MailConfig = {
  user: string;
  password: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  rejectUnauthorized: boolean;
  allowSend: boolean;
  allowExpunge: boolean;
  trashMailbox?: string;
  draftsMailbox?: string;
  sentMailbox?: string;
  fromName?: string;
};

export type PublicMailSettings = {
  user: string | null;
  imapHost: string | null;
  imapPort: number;
  smtpHost: string | null;
  smtpPort: number;
  tlsRejectUnauthorized: boolean;
  allowSend: boolean;
  allowExpunge: boolean;
  trashMailbox: string | null;
  draftsMailbox: string | null;
  sentMailbox: string | null;
  fromName: string | null;
};

export type ConfigResult =
  | { ok: true; config: MailConfig; problems: [] }
  | { ok: false; problems: string[]; partial: PublicMailSettings };

const TRUE = new Set(["1", "true", "yes", "on"]);
const FALSE = new Set(["0", "false", "no", "off"]);

export function loadEnvFile(): void {
  const configured = process.env.MAIL_ENV_FILE?.trim();
  const path = configured ? resolve(configured) : resolve(process.cwd(), ".env");
  if (!existsSync(path)) {
    if (configured) console.error(`MAIL_ENV_FILE no existe: ${path}`);
    return;
  }

  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function booleanSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
  problems: string[],
): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (TRUE.has(value)) return true;
  if (FALSE.has(value)) return false;
  problems.push(`${name} debe ser true o false`);
  return fallback;
}

function portSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  problems: string[],
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    problems.push(`${name} no es un puerto válido`);
    return fallback;
  }
  return value;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const problems: string[] = [];
  const user = optional(env, "MAIL_USER");
  const password = env.MAIL_PASSWORD ?? "";
  const imapHost = optional(env, "IMAP_HOST");
  const smtpHost = optional(env, "SMTP_HOST");
  const partial: PublicMailSettings = {
    user: user ?? null,
    imapHost: imapHost ?? null,
    imapPort: portSetting(env, "IMAP_PORT", 993, problems),
    smtpHost: smtpHost ?? null,
    smtpPort: portSetting(env, "SMTP_PORT", 465, problems),
    tlsRejectUnauthorized: booleanSetting(env, "MAIL_TLS_REJECT_UNAUTHORIZED", true, problems),
    allowSend: booleanSetting(env, "MAIL_ALLOW_SEND", false, problems),
    allowExpunge: booleanSetting(env, "MAIL_ALLOW_EXPUNGE", false, problems),
    trashMailbox: optional(env, "TRASH_MAILBOX") ?? null,
    draftsMailbox: optional(env, "DRAFTS_MAILBOX") ?? null,
    sentMailbox: optional(env, "SENT_MAILBOX") ?? null,
    fromName: optional(env, "MAIL_FROM_NAME") ?? null,
  };

  if (!user) problems.push("Falta MAIL_USER");
  if (!password.trim()) problems.push("Falta MAIL_PASSWORD");
  if (!imapHost) problems.push("Falta IMAP_HOST");
  if (!smtpHost) problems.push("Falta SMTP_HOST");

  if (!user || !password.trim() || !imapHost || !smtpHost || problems.length > 0) {
    return { ok: false, problems, partial };
  }

  return {
    ok: true,
    problems: [],
    config: {
      user,
      password,
      imapHost,
      imapPort: partial.imapPort,
      smtpHost,
      smtpPort: partial.smtpPort,
      rejectUnauthorized: partial.tlsRejectUnauthorized,
      allowSend: partial.allowSend,
      allowExpunge: partial.allowExpunge,
      trashMailbox: partial.trashMailbox ?? undefined,
      draftsMailbox: partial.draftsMailbox ?? undefined,
      sentMailbox: partial.sentMailbox ?? undefined,
      fromName: partial.fromName ?? undefined,
    },
  };
}

export function requireConfig(): MailConfig {
  const result = readConfig();
  if (!result.ok) {
    throw new Error(result.problems.join(". "));
  }
  return result.config;
}

export function configStatus(): Record<string, unknown> {
  const result = readConfig();
  const partial = result.ok
    ? {
        user: result.config.user,
        imapHost: result.config.imapHost,
        imapPort: result.config.imapPort,
        smtpHost: result.config.smtpHost,
        smtpPort: result.config.smtpPort,
        tlsRejectUnauthorized: result.config.rejectUnauthorized,
        allowSend: result.config.allowSend,
        allowExpunge: result.config.allowExpunge,
        trashMailbox: result.config.trashMailbox ?? null,
        draftsMailbox: result.config.draftsMailbox ?? null,
        sentMailbox: result.config.sentMailbox ?? null,
        fromName: result.config.fromName ?? null,
      }
    : result.partial;

  return {
    ready: result.ok,
    problems: result.problems,
    passwordConfigured: Boolean(process.env.MAIL_PASSWORD?.trim()),
    ...partial,
  };
}
