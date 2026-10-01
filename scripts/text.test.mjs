import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { configStatus, readConfig } from "../dist/config.js";
import { mapFlags, parseImapDate, parseRecipients, resolveInside, scrub, stripHtml } from "../dist/text.js";

test("stripHtml deja el texto y quita el marcado", () => {
  const text = stripHtml("<style>p{}</style><p>Hola&nbsp;<b>equipo</b><br>línea</p>");
  assert.match(text, /Hola equipo/);
  assert.match(text, /línea/);
  assert.equal(text.includes("<"), false);
});

test("parseRecipients acepta lista y nombre visible", () => {
  assert.deepEqual(parseRecipients("Ana <ana@example.com>, bob@example.com", "to"), [
    "Ana <ana@example.com>",
    "bob@example.com",
  ]);
  assert.throws(() => parseRecipients("no-es-correo", "to"), /no es un correo válido/);
});

test("resolveInside no deja salir del directorio", () => {
  const root = path.resolve(mkdtempSync(path.join(tmpdir(), "cpanel-mail-")));
  const saved = resolveInside(root, "..\\..\\secreto.txt");
  const relative = path.relative(root, saved);
  assert.equal(relative.startsWith(".."), false);
  assert.equal(path.isAbsolute(relative), false);
  assert.throws(() => resolveInside(root, ".."), /no válido/);
});

test("las fechas y banderas se validan", () => {
  assert.equal(parseImapDate("2026-09-30", "since"), "2026-09-30");
  assert.throws(() => parseImapDate("30-09-2026", "since"), /YYYY-MM-DD/);
  assert.deepEqual(mapFlags(["seen", "flagged"]), ["\\Seen", "\\Flagged"]);
});

test("la configuración no incluye la contraseña en el estado público", () => {
  const secret = "super-secreto-123";
  const env = {
    MAIL_USER: "usuario@example.com",
    MAIL_PASSWORD: secret,
    IMAP_HOST: "mail.example.com",
    SMTP_HOST: "mail.example.com",
  };
  const result = readConfig(env);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.config.allowSend, false);
  assert.equal(result.ok && result.config.imapPort, 993);
  assert.equal(result.ok && result.config.smtpPort, 465);

  const previous = {
    MAIL_USER: process.env.MAIL_USER,
    MAIL_PASSWORD: process.env.MAIL_PASSWORD,
    IMAP_HOST: process.env.IMAP_HOST,
    SMTP_HOST: process.env.SMTP_HOST,
  };
  Object.assign(process.env, env);
  try {
    const status = JSON.stringify(configStatus());
    assert.equal(status.includes(secret), false);
    assert.match(status, /usuario@example.com/);
    assert.equal(scrub(`falló ${secret}`, secret), "falló [redactado]");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("faltan credenciales cuando el entorno está vacío", () => {
  const result = readConfig({});
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /MAIL_PASSWORD/);
});
