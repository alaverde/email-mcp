# cpanel-mail-mcp

Servidor [MCP](https://modelcontextprotocol.io) para una cuenta de correo de cPanel. Grok, Cursor o Claude arrancan este proceso y usan sus herramientas para leer, buscar, clasificar y, si lo habilitas, enviar correo.

Grok ya es el cliente MCP. Este repositorio es el servidor: no hace falta otra aplicación de correo. El webmail del puerto 2096 es la página del navegador; un agente no la necesita. cPanel publica IMAP y SMTP para clientes, y este servidor habla esos dos protocolos.

La configuración que corresponde a una cuenta típica de cPanel es:

| Dato del panel | Variable | Valor de ejemplo |
| --- | --- | --- |
| Usuario | `MAIL_USER` | `usuario@example.com` |
| Contraseña de la cuenta | `MAIL_PASSWORD` | solo en un archivo local |
| Servidor entrante, IMAP | `IMAP_HOST` / `IMAP_PORT` | `mail.example.com` / `993` |
| Servidor saliente, SMTP | `SMTP_HOST` / `SMTP_PORT` | `mail.example.com` / `465` |
| Cifrado | implícito | SSL/TLS en ambos puertos |

IMAP, POP3 y SMTP piden autenticación. Este servidor usa IMAP, porque POP3 no tiene carpetas y no sirve para organizar. El puerto 465 es SSL implícito; no es el STARTTLS del 587.

## Seguridad

La contraseña no está en el código ni en `.env.example`. Quien tenga esa contraseña puede leer y, si lo habilitas, enviar correo como la cuenta.

- Copia la configuración a un archivo fuera del repositorio, por ejemplo `%USERPROFILE%\.config\cpanel-mail.env`.
- No pegues la contraseña en el chat con el modelo. El modelo la recibe por el entorno del proceso, no por el prompt.
- `MAIL_ALLOW_SEND` vale `false` hasta que lo cambies. Sin eso, `send_message` y `reply_message` se niegan y no abren SMTP.
- `MAIL_ALLOW_EXPUNGE` vale `false`. `delete_messages` mueve a la papelera. El borrado permanente pide además `permanent=true` y solo actúa dentro de la papelera.
- `MAIL_TLS_REJECT_UNAUTHORIZED` vale `true`. Déjalo así si el certificado del servidor de correo es válido.

## Requisitos

Node.js 20 o posterior.

## Instalación

```powershell
npm install
```

`npm install` compila TypeScript a `dist/`. Para repetir la compilación: `npm run build`. Para las pruebas locales, que no se conectan al servidor de correo: `npm test`.

## Configuración

Crea `%USERPROFILE%\.config\cpanel-mail.env` con el contenido de `.env.example` y escribe la contraseña en `MAIL_PASSWORD`. Ese archivo no se commitea.

Si cPanel nombra las carpetas de otra forma, fíjalas después de verlas con `list_mailboxes`:

```text
TRASH_MAILBOX=INBOX.Trash
DRAFTS_MAILBOX=INBOX.Drafts
SENT_MAILBOX=INBOX.Sent
```

Si omites esas variables, el servidor busca los atributos IMAP `\Trash`, `\Drafts` y `\Sent`, y si no están, prueba los nombres habituales de cPanel (`INBOX.Trash`, `INBOX.Drafts`, `INBOX.Sent`).

## Conectarlo a Grok

En PowerShell, desde este directorio y con el servidor ya compilado:

```powershell
grok mcp add cpanel-mail -e MAIL_ENV_FILE="$env:USERPROFILE\.config\cpanel-mail.env" -- node "$pwd\dist\index.js"
```

El equivalente en `~/.grok/config.toml` está en `examples/grok.config.toml`. La contraseña queda en el archivo de entorno; `config.toml` solo guarda la ruta.

Comprueba el arranque:

```powershell
grok mcp doctor cpanel-mail
```

En una sesión de Grok puedes pedir: "Revisa la conexión del correo y dime cuántos no leídos hay". Cuando `check_connection` responda bien, "organiza la bandeja" sigue el flujo de las instrucciones del servidor: resume no leídos, propone carpetas `INBOX.…`, mueve y deja un resumen. No envía nada mientras `MAIL_ALLOW_SEND` sea `false`.

El primer `npx` de otros servidores a veces necesita más de 30 segundos. Este proceso no descarga nada al arrancar y no abre IMAP hasta la primera herramienta, así que el tiempo de espera por defecto alcanza.

Para publicarlo y clonarlo en otra máquina:

```powershell
git init
git add .
git commit -m "Servidor MCP de correo cPanel por IMAP y SMTP"
git branch -M main
git remote add origin https://github.com/USUARIO/cpanel-mail-mcp.git
git push -u origin main
```

En la otra máquina: clonar, `npm install`, crear el archivo de contraseña y repetir `grok mcp add` con la ruta nueva. No hace falta publicar el paquete en npm.

## Herramientas

| Herramienta | Qué hace |
| --- | --- |
| `mail_config_status` | Configuración visible, sin contraseña |
| `check_connection` | Login IMAP y verificación SMTP, sin enviar |
| `list_mailboxes` | Carpetas, ruta exacta y uso especial |
| `unseen_summary` | Carpetas con no leídos |
| `mailbox_status` | Totales de una carpeta |
| `list_messages` | Recientes o solo no leídos, sin el cuerpo |
| `get_message` | Texto de un UID, recortado; no lo marca leído salvo que se pida |
| `search_messages` | Búsqueda por remitente, asunto, texto o fecha |
| `move_messages` | Mueve UID a otra carpeta |
| `set_flags` | Leído, destacado, respondido, borrado o borrador |
| `create_mailbox` | Crea y suscribe una carpeta |
| `delete_messages` | Mueve a la papelera |
| `save_attachment` | Guarda un adjunto en una carpeta local existente |
| `create_draft` | Borrador en Drafts, sin enviar |
| `send_message` | SMTP, solo con `MAIL_ALLOW_SEND=true`, y copia en Enviados |
| `reply_message` | Respuesta con cita, con la misma condición |

Los UID son los identificadores IMAP, no la posición en la lista. `get_message` no marca el mensaje como leído: leer para clasificar no debe vaciar los no leídos. Para marcarlo, `set_flags` con `add: ["seen"]` o `mark_seen: true`.

Los cuerpos se recortan a 8000 caracteres (máximo 20000) y los mensajes de más de 2 MB no se descargan enteros. Cada llamada mueve como máximo 50 UID. Los adjuntos de salida se leen en memoria y se rechazan por encima de 15 MB por archivo y 20 MB en total; el transporte SMTP tiene bloqueado el acceso a rutas y a URL dentro de la librería.

## Desarrollo

```powershell
npm test
npm run build
npm start
```

`npm start` espera un cliente por la entrada estándar. Para probar las herramientas a mano:

```powershell
npx @modelcontextprotocol/inspector node dist/index.js
```

El inspector hereda el entorno. Define `MAIL_ENV_FILE` antes de lanzarlo si la contraseña no está en `.env` dentro de esta carpeta. Mejor no crear un `.env` aquí: es fácil commitearlo por error.
