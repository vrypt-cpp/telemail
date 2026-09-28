import { tryLoadConfig } from './config.js';
import { ImapWatcher } from './imap/watcher.js';
import { logger } from './logger.js';
import { StateStore } from './state.js';
import { TelegramSender } from './telegram/sender.js';

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const result = tryLoadConfig();
  if ('error' in result) {
    process.stderr.write(`\n${result.error}\n\nCopy .env.example to .env and fill in the values.\n\n`);
    process.exit(1);
  }

  const { config } = result;

  if (!config.imap.secure) {
    logger.warn('IMAP_SECURE=false: the connection will use STARTTLS, make sure the server supports it');
  }
  if (!config.imap.rejectUnauthorized) {
    logger.warn('IMAP_TLS_REJECT_UNAUTHORIZED=false: the server certificate is not validated');
  }

  const state = await StateStore.open(config.stateFile);
  const sender = new TelegramSender(
    config.telegram.botToken,
    config.telegram.chatIds,
    config.telegram.sendIntervalMs,
    config.telegram.apiBase,
  );

  try {
    const bot = await sender.getMe();
    logger.info(
      { bot: `@${bot.username}`, chatIds: config.telegram.chatIds.length },
      'Telegram bot is ready',
    );
  } catch (error) {
    logger.error({ err: error }, 'Could not verify the Telegram bot, starting anyway');
  }

  const watcher = new ImapWatcher({ config, logger, sender, state });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    const forced = setTimeout(() => {
      logger.error('Shutdown took too long, exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forced.unref();

    try {
      await watcher.stop();
      await state.flush();
      logger.info('telemail stopped cleanly');
    } catch (error) {
      logger.error({ err: error }, 'Error during shutdown');
    } finally {
      clearTimeout(forced);
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled rejection');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception, exiting');
    process.exit(1);
  });

  logger.info(
    { mailbox: config.imap.mailbox, user: config.imap.user, initialMode: config.imap.initialMode },
    'telemail is running, waiting for new emails',
  );
  await watcher.start();
}

await main();
