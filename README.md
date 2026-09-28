# telemail

Forwards incoming email to a Telegram bot. Meant to run as a service on a server or VPS, so new mail reaches your phone without opening any mail app.

```
Incoming email (IMAP)  ->  telemail  ->  Telegram bot
                           Node.js
```

Features:

- IMAP over standard protocols with app passwords (Gmail, Outlook, Yahoo, cPanel, and others)
- IMAP IDLE, so notifications arrive within seconds instead of relying on heavy polling
- No duplicates, the UID cursor is persisted so a restart never re-sends old mail
- Automatic reconnect with exponential backoff when the connection drops
- Long emails are split automatically to respect the 4096 character Telegram limit
- Email bodies are escaped, so they are safe from HTML markup injection
- Multiple chats, throttling, retries, and rate limit (429) handling
- Clean shutdown on SIGINT and SIGTERM

## Requirements

- Node.js 20 or newer (developed against v24)
- An email account with an app password, not your regular password
- A bot token from [@BotFather](https://t.me/BotFather)

## Installation

```bash
git clone <telemail-repo> && cd telemail
npm install
cp .env.example .env
```

Fill in `.env`, then verify the configuration:

```bash
npm run check
```

`npm run check` validates the bot token, sends a test message to your chat, then tests the IMAP login and opens the mailbox. Run it until everything passes before going to production.

## Running

```bash
npm run dev     # development, reloads automatically
npm run build   # compile TypeScript to dist/
npm start       # production
```

## Configuration

Every option is listed in `.env.example`. The ones you are most likely to change:

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | - | Token from @BotFather (required) |
| `TELEGRAM_CHAT_IDS` | - | Target chats, comma separated. Groups and channels start with `-100` (required) |
| `IMAP_HOST` / `IMAP_PORT` | - / `993` | IMAP server (required) |
| `IMAP_USER` / `IMAP_PASSWORD` | - | Email address and app password (required) |
| `IMAP_MAILBOX` | `INBOX` | Mailbox to watch |
| `IMAP_INITIAL_MODE` | `latest` | `latest` skips existing mail, `all` forwards it as well |
| `IMAP_MARK_SEEN` | `false` | Mark emails as read after forwarding them |
| `IMAP_AUTO_IDLE_DELAY_MS` | `15000` | How quickly IDLE kicks in |
| `TELEGRAM_SEND_INTERVAL_MS` | `1000` | Delay between messages, prevents rate limits |
| `BODY_PREVIEW_CHARS` | `3000` | Body length to show, `0` for no limit |
| `TIMEZONE` | `Asia/Jakarta` | Timezone used for the date in messages |

The configuration is validated at startup. Every invalid value is reported at once rather than one at a time:

```
Invalid configuration:
  - IMAP_TLS_REJECT_UNAUTHORIZED expects true or false (or 1/0, yes/no), got "ngap"
  - TELEGRAM_MAX_CHUNK must be between 200 and 4096, got "99999"
  - TELEGRAM_CHAT_IDS must contain numeric chat ids (personal chats use the user id, groups and channels use an id starting with -100)
```

### App passwords per provider

| Provider | IMAP host | How to get an app password |
|---|---|---|
| Gmail | `imap.gmail.com` | Enable 2FA, then [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) |
| Outlook / Hotmail | `outlook.office365.com` | [mysignins.microsoft.com/security-info](https://mysignins.microsoft.com/security-info), then app password |
| Yahoo | `imap.mail.yahoo.com` | [login.yahoo.com/account/security](https://login.yahoo.com/account/security), then generate app password |
| cPanel / hosting | `mail.domain.tld` | Usually in the hosting panel under Email Accounts, then "Create Mailbox" or "Manage" |

Gmail and Google block logins from "less secure apps". An app password is the only officially supported way to use IMAP and is never blocked.

## Getting your chat ID

1. Send any message to your bot.
2. Open this URL in a browser:
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
3. Look for `"chat":{"id":123456789}`. For groups and channels the value starts with `-100`.

## Previewing the message format

Works without IMAP and without Telegram, straight from an `.eml` file:

```bash
npm run preview -- samples/sample.eml
npm run preview -- samples/sample.eml 0
```

Output:

```
<b>NEW EMAIL</b>

<b>From:    no-reply@example.com</b>
<b>Subject: [IMPORTANT] Card activation &amp; OTP 881-442</b>
<b>To:      you@example.com</b>
<b>Date:    28 Sep 2026, 09:41</b>
<b>Account: you@gmail.com</b>
--------------------
<pre>PESANAN ANDA MENUNGGU VERIFIKASI

Halo, Kami mendeteksi percobaan pencairan sebesar Rp 4.250.000 ...</pre>
```

## How it works

```
IMAP IDLE / polling  ->  UID SEARCH (uid > cursor)  ->  UID FETCH
                                                             |
                                                             v
                                                   parse (mailparser)
                                                             |
                                                             v
                                    escape and split to <=4096  ->  Telegram
                                                             |
                                                             v
                                               save cursor (state.json)
```

- **Detection:** IMAP IDLE tells the server to simply wait on the connection. An `EXISTS` event triggers an immediate check. A periodic poll (`IMAP_POLL_INTERVAL_MS`) still runs as a safety net for servers without IDLE support.
- **No duplicates:** the UID position is stored in `data/state.json` using atomic writes. A restart resumes from the cursor instead of resending. If `UIDVALIDITY` changes, meaning the server reset the mailbox, the cursor resets automatically.
- **Delivery:** every email goes to all target chats. When the content exceeds the Telegram limit it is split into several messages marked `(continued 2/3)`. Transient failures (429, 5xx, network) are retried with backoff.
- **Recovery:** a dropped connection triggers a reconnect with exponential backoff, from 3 seconds up to 5 minutes.

## Project layout

```
src/
├── index.ts              entry point, shutdown handling
├── config.ts             .env validation with zod
├── logger.ts             pino logger
├── state.ts              persistent UID cursor
├── format.ts             HTML escaping and message splitting
├── imap/watcher.ts       connection, IDLE, reconnect
├── mail/parser.ts        email parsing
├── telegram/sender.ts    Bot API calls, retries, throttling
└── scripts/
    ├── check.ts          configuration verification
    └── preview.ts        message format preview from an .eml
```

## Deployment

### systemd

```ini
# /etc/systemd/system/telemail.service
[Unit]
Description=telemail, forward email to Telegram
After=network-online.target

[Service]
Type=simple
User=telemail
WorkingDirectory=/opt/telemail
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=LOG_PRETTY=false

[Install]
WantedBy=multi-user.target
```

```bash
npm run build
sudo systemctl enable --now telemail
journalctl -u telemail -f
```

Add `EnvironmentFile=/opt/telemail/.env` if you prefer managing configuration through systemd. Otherwise telemail reads `.env` directly.

### pm2

```bash
npm i -g pm2
npm run build
pm2 start dist/index.js --name telemail
pm2 save && pm2 startup
```

## Troubleshooting

**No messages arrive at all**
1. Run `npm run check` to confirm the token and IMAP settings.
2. Send an email to that account yourself.
3. Set `LOG_LEVEL=debug` and watch the logs.

**`AUTHENTICATIONFAILED` or the login is rejected**
Use an app password, not the account password. Make sure 2FA is enabled and the app password has not been revoked.

**Messages do not reach a group**
Make sure `TELEGRAM_CHAT_IDS` starts with `-100` for groups and channels, and that the bot has already joined that group.

**`Flood control exceeded`**
Raise `TELEGRAM_SEND_INTERVAL_MS`, for example to 2500, and reduce the number of entries in `TELEGRAM_CHAT_IDS` if you use many chats.

**Email bodies are cut off**
Raise `TELEGRAM_MAX_CHUNK`, up to 4096, and `BODY_PREVIEW_CHARS`.

**To resend everything from scratch**
Delete `data/state.json`, set `IMAP_INITIAL_MODE=all`, then restart.

**The date shows the wrong timezone**
Set `TIMEZONE`, for example `Asia/Jakarta`, `Asia/Makassar`, or `UTC`.

## License

MIT
