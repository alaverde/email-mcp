import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = path.join(root, "dist", "index.js");

function childEnv(overrides) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return { ...env, MAIL_ENV_FILE: "", ...overrides };
}

async function withClient(env, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    env,
    stderr: "pipe",
    cwd: root,
  });
  const client = new Client({ name: "cpanel-mail-smoke", version: "0.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function textOf(result) {
  const block = result.content?.find((item) => item.type === "text");
  return block && "text" in block ? block.text : "";
}

test("el servidor arranca y no opera sin credenciales", { timeout: 20_000 }, async () => {
  await withClient(
    childEnv({
      MAIL_USER: "",
      MAIL_PASSWORD: "",
      IMAP_HOST: "",
      SMTP_HOST: "",
      MAIL_ALLOW_SEND: "false",
    }),
    async (client) => {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      for (const name of ["check_connection", "unseen_summary", "move_messages", "send_message", "delete_messages"]) {
        assert.ok(names.includes(name), name);
      }

      const status = await client.callTool({ name: "mail_config_status", arguments: {} });
      assert.equal(status.isError, undefined);
      const json = JSON.parse(textOf(status));
      assert.equal(json.ready, false);
      assert.equal(json.passwordConfigured, false);

      const denied = await client.callTool({ name: "list_mailboxes", arguments: {} });
      assert.equal(denied.isError, true);
      assert.match(textOf(denied), /MAIL_PASSWORD/);
    },
  );
});

test("enviar y borrar de forma permanente quedan bloqueados sin red", { timeout: 15_000 }, async () => {
  const secret = "clave-de-prueba-123";
  await withClient(
    childEnv({
      MAIL_USER: "usuario@example.com",
      MAIL_PASSWORD: secret,
      IMAP_HOST: "mail.example.com",
      IMAP_PORT: "993",
      SMTP_HOST: "mail.example.com",
      SMTP_PORT: "465",
      MAIL_ALLOW_SEND: "false",
      MAIL_ALLOW_EXPUNGE: "false",
    }),
    async (client) => {
      const sent = await client.callTool({
        name: "send_message",
        arguments: { to: "destino@example.com", subject: "Prueba", text: "Hola" },
      });
      assert.equal(sent.isError, true);
      assert.match(textOf(sent), /MAIL_ALLOW_SEND/);
      assert.equal(textOf(sent).includes(secret), false);

      const removed = await client.callTool({
        name: "delete_messages",
        arguments: { uids: [1], permanent: true },
      });
      assert.equal(removed.isError, true);
      assert.match(textOf(removed), /MAIL_ALLOW_EXPUNGE/);
      assert.equal(textOf(removed).includes(secret), false);
    },
  );
});
