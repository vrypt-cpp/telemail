import { ImapFlow } from 'imapflow';
import { tryLoadConfig } from '../config.js';
import { TelegramSender } from '../telegram/sender.js';

const out = process.stdout;

function pass(message: string): void {
  out.write(`PASS  ${message}\n`);
}

function fail(message: string): void {
  out.write(`FAIL  ${message}\n`);
}

function note(message: string): void {
  out.write(`NOTE  ${message}\n`);
}

function step(message: string): void {
  out.write(`\n--- ${message}\n`);
}

async function main(): Promise<void> {
  const result = tryLoadConfig();
  if ('error' in result) {
    fail(result.error);
    process.exitCode = 1;
    return;
  }
  pass('the .env configuration is valid');
  const { config } = result;

  step('Checking the Telegram bot token');
  const sender = new TelegramSender(
    config.telegram.botToken,
    config.telegram.chatIds,
    500,
    config.telegram.apiBase,
  );

  let failed = false;
  try {
    const bot = await sender.getMe();
    pass(`token accepted, bot is @${bot.username} (id ${bot.id})`);
  } catch (error) {
    fail(`the bot token was rejected: ${(error as Error).message}`);
    failed = true;
  }

  if (!failed) {
    step('Sending a test message');
    try {
      await sender.sendHtml(
        [
          '<b>telemail is connected</b>',
          '',
          'This message was sent by the verification script (npm run check).',
          'Every new email will be forwarded here from now on.',
        ].join('\n'),
        { silent: config.telegram.silent },
      );
      pass(`test message delivered to ${config.telegram.chatIds.length} chat(s)`);
    } catch (error) {
      fail(`could not send the test message: ${(error as Error).message}`);
      failed = true;
    }
  }

  step(`Connecting to IMAP at ${config.imap.host}:${config.imap.port}`);
  const client = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: { user: config.imap.user, pass: config.imap.password },
    tls: { rejectUnauthorized: config.imap.rejectUnauthorized },
    logger: false,
  });
  client.on('error', () => undefined);

  try {
    await client.connect();
    pass('IMAP login succeeded');

    const status = await client.status(config.imap.mailbox, {
      messages: true,
      unseen: true,
      uidNext: true,
      uidValidity: true,
    });
    if (!status) {
      fail(`mailbox "${config.imap.mailbox}" could not be opened`);
      failed = true;
    } else {
      pass(
        `mailbox "${config.imap.mailbox}" holds ${status.messages ?? 0} messages, ${status.unseen ?? 0} unread, uidNext ${status.uidNext ?? 'unknown'}`,
      );
    }
  } catch (error) {
    fail(`IMAP connection failed: ${(error as Error).message}`);
    note('Use an app password rather than your account password, and double check IMAP_HOST and IMAP_PORT.');
    failed = true;
  } finally {
    if (client.usable) await client.logout().catch(() => undefined);
  }

  step('Summary');
  if (failed) {
    fail('verification FAILED, fix the problems above and run it again');
    process.exitCode = 1;
  } else {
    pass('everything is ready, run `npm run dev` to start forwarding emails');
  }
}

await main();
