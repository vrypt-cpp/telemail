import { setTimeout as delay } from 'node:timers/promises';
import { ImapFlow } from 'imapflow';
import type { FetchMessageObject } from 'imapflow';
import type { Config } from '../config.js';
import { formatEmailChunks, type FormatOptions } from '../format.js';
import type { Logger } from '../logger.js';
import { parseEmail } from '../mail/parser.js';
import type { MailboxCursor, StateStore } from '../state.js';
import type { TelegramSender } from '../telegram/sender.js';

export interface WatcherDeps {
  config: Config;
  logger: Logger;
  sender: TelegramSender;
  state: StateStore;
}

const BACKOFF_MIN_MS = 3_000;
const BACKOFF_MAX_MS = 300_000;
const LOGOUT_TIMEOUT_MS = 5_000;
const MAX_CONSECUTIVE_SEND_FAILURES = 5;
const CONNECTION_ERROR_CODES = new Set(['NoConnection', 'ConnectionNotAvailable', 'ECONNRESET']);

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function isConnectionError(error: unknown): boolean {
  const code = (error as { responseCode?: string } | undefined)?.responseCode;
  return code !== undefined && CONNECTION_ERROR_CODES.has(code);
}

export class ImapWatcher {
  private running = false;
  private client: ImapFlow | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private checking = false;
  private checkQueued = false;
  private failedSessions = 0;
  private sendFailures = 0;
  private wakeUp: (() => void) | undefined;

  constructor(private readonly deps: WatcherDeps) {}

  private get log(): Logger {
    return this.deps.logger;
  }

  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      try {
        this.client = this.createClient();
        await this.client.connect();
        this.failedSessions = 0;
        this.log.info(
          {
            host: this.deps.config.imap.host,
            port: this.deps.config.imap.port,
            user: this.deps.config.imap.user,
            mailbox: this.deps.config.imap.mailbox,
          },
          'Connected to the IMAP server',
        );
        await this.runSession(this.client);
        if (this.running) this.log.warn('IMAP session ended, reconnecting');
      } catch (error) {
        if (this.running) {
          this.failedSessions += 1;
          this.log.error({ err: error }, 'IMAP session failed');
        }
      } finally {
        await this.teardown();
      }

      if (!this.running) break;
      const wait = this.nextBackoff();
      this.log.info({ waitMs: wait }, 'Waiting before reconnecting');
      await this.interruptibleDelay(wait);
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.log.info('Stopping the IMAP watcher');
    this.wakeUp?.();
    await this.teardown();
  }

  private interruptibleDelay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wakeUp = undefined;
        resolve();
      }, ms);
      timer.unref?.();
      this.wakeUp = () => {
        clearTimeout(timer);
        this.wakeUp = undefined;
        resolve();
      };
    });
  }

  private createClient(): ImapFlow {
    const { host, port, secure, user, password, rejectUnauthorized, autoIdleDelayMs } =
      this.deps.config.imap;

    const client = new ImapFlow({
      host,
      port,
      secure,
      auth: { user, pass: password },
      tls: { rejectUnauthorized },
      autoIdleDelay: autoIdleDelayMs,
      emitLogs: this.deps.config.logLevel === 'trace',
      logger: false,
      clientInfo: { name: 'telemail', version: '1.0.0', vendor: 'telemail' },
    });

    client.on('error', (error: Error) => {
      this.log.debug({ err: error }, 'IMAP error event');
    });

    return client;
  }

  private nextBackoff(): number {
    const base = Math.min(BACKOFF_MIN_MS * 2 ** this.failedSessions, BACKOFF_MAX_MS);
    const jitter = base * 0.25 * Math.random();
    return Math.round(base - base * 0.125 + jitter);
  }

  private async teardown(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    const client = this.client;
    this.client = undefined;
    if (!client) return;

    if (client.usable) {
      const graceful = await Promise.race([
        client.logout().then(
          () => true,
          () => false,
        ),
        delay(LOGOUT_TIMEOUT_MS).then(() => false),
      ]);
      if (graceful) return;
      this.log.debug('LOGOUT timed out, closing the connection');
    }

    client.close();
  }

  private async runSession(client: ImapFlow): Promise<void> {
    const sessionClosed = new Promise<void>((resolve) => {
      const finish = (): void => {
        client.off('error', onError);
        client.off('close', onClose);
        resolve();
      };
      const onError = (error: Error): void => {
        this.log.debug({ err: error }, 'IMAP error event');
        finish();
      };
      const onClose = (): void => {
        this.log.warn('IMAP connection closed by the server');
        finish();
      };
      client.once('error', onError);
      client.once('close', onClose);
    });

    client.on('exists', () => {
      this.scheduleCheck('exists');
    });
    client.on('expunge', () => {
      this.log.trace('Messages were expunged on the server');
    });

    await this.prepareCursor(client);

    this.pollTimer = setInterval(() => {
      this.scheduleCheck('poll');
    }, this.deps.config.imap.pollIntervalMs);

    await this.runCheck('startup');
    if (!client.usable) throw new Error('IMAP connection dropped during the initial check');

    await sessionClosed;
  }

  private async prepareCursor(client: ImapFlow): Promise<void> {
    const { imap } = this.deps.config;
    const status = await client.status(imap.mailbox, {
      messages: true,
      uidNext: true,
      uidValidity: true,
    });
    if (!status) {
      throw new Error(`Server rejected STATUS for mailbox "${imap.mailbox}"`);
    }

    const uidValidity = status.uidValidity != null ? String(status.uidValidity) : null;
    const stored = this.deps.state.get(imap.mailbox);
    const startFromLatest = imap.initialMode === 'latest';
    const initialUid = startFromLatest ? Math.max(0, (status.uidNext ?? 1) - 1) : 0;

    if (!stored) {
      this.deps.state.set(imap.mailbox, { uidValidity, lastUid: initialUid });
      this.log.info(
        { mailbox: imap.mailbox, lastUid: initialUid, uidValidity, mode: imap.initialMode },
        startFromLatest
          ? 'Cursor created, existing emails will be skipped'
          : 'Cursor created, all emails will be forwarded',
      );
      return;
    }

    if (uidValidity && stored.uidValidity && stored.uidValidity !== uidValidity) {
      this.log.warn(
        { before: stored.uidValidity, after: uidValidity },
        'UIDVALIDITY changed (mailbox was reset or rebuilt), resetting the cursor',
      );
      this.deps.state.set(imap.mailbox, { uidValidity, lastUid: initialUid });
      return;
    }

    if (uidValidity && stored.uidValidity !== uidValidity) {
      this.deps.state.set(imap.mailbox, { uidValidity, lastUid: stored.lastUid });
    }

    this.log.info(
      { mailbox: imap.mailbox, lastUid: stored.lastUid, totalMessages: status.messages },
      'Resuming from the saved cursor',
    );
  }

  private scheduleCheck(reason: string): void {
    if (!this.running) return;
    setImmediate(() => {
      void this.runCheck(reason);
    });
  }

  private async runCheck(reason: string): Promise<void> {
    if (!this.running || !this.client?.usable) return;
    if (this.checking) {
      this.checkQueued = true;
      return;
    }

    this.checking = true;
    try {
      do {
        this.checkQueued = false;
        await this.forwardNewEmails();
      } while (this.checkQueued && this.running && this.client?.usable === true);
    } catch (error) {
      const level = isConnectionError(error) ? 'warn' : 'error';
      this.log[level]({ err: error, reason }, 'Mailbox check failed, resetting the session');
      this.client?.close();
    } finally {
      this.checking = false;
    }
  }

  private async forwardNewEmails(): Promise<void> {
    const client = this.client;
    if (!client?.usable) return;

    const { imap, telegram, timeZone } = this.deps.config;
    const cursor: MailboxCursor = this.deps.state.get(imap.mailbox) ?? {
      uidValidity: null,
      lastUid: 0,
    };

    const formatOptions: FormatOptions = {
      accountLabel: imap.user,
      timeZone,
      previewChars: telegram.bodyPreviewChars,
      maxChunk: telegram.maxChunk,
    };

    const lock = await client.getMailboxLock(imap.mailbox);
    try {
      const found = await client.search({ uid: `${cursor.lastUid + 1}:*` }, { uid: true });
      if (!found || found.length === 0) return;

      const pending = [...new Set(found)]
        .filter((uid) => uid > cursor.lastUid)
        .sort((a, b) => a - b);
      if (pending.length === 0) return;

      this.log.info(
        { count: pending.length, newestUid: pending.at(-1) },
        'New emails found, forwarding them',
      );

      for (const batch of chunk(pending, imap.batchSize)) {
        const first = batch[0];
        const last = batch.at(-1);
        if (first === undefined || last === undefined) continue;

        const range = first === last ? String(first) : `${first}:${last}`;
        const messages = new Map<number, FetchMessageObject>();
        for await (const message of client.fetch(
          range,
          { uid: true, source: true, internalDate: true },
          { uid: true },
        )) {
          messages.set(message.uid, message);
        }

        for (const uid of batch) {
          const message = messages.get(uid);
          if (!message?.source) {
            this.log.warn({ uid }, 'Message body was unreadable, skipping it');
            this.advanceCursor(imap.mailbox, cursor, uid);
            continue;
          }

          await this.forwardMessage(message.source, uid, formatOptions);
          this.advanceCursor(imap.mailbox, cursor, uid);

          if (imap.markSeen) {
            try {
              await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
            } catch (error) {
              this.log.warn({ uid, err: error }, 'Could not set the Seen flag');
            }
          }
        }
      }
    } finally {
      lock.release();
    }
  }

  private advanceCursor(mailbox: string, cursor: MailboxCursor, uid: number): void {
    cursor.lastUid = uid;
    this.deps.state.set(mailbox, cursor);
  }

  private async forwardMessage(
    source: Buffer,
    uid: number,
    formatOptions: FormatOptions,
  ): Promise<void> {
    const email = await parseEmail(source);
    const chunks = formatEmailChunks(email, formatOptions);

    this.log.info(
      { uid, from: email.from, subject: email.subject, parts: chunks.length },
      'Sending the email to Telegram',
    );

    try {
      await this.deps.sender.sendHtmlSequence(chunks, { silent: this.deps.config.telegram.silent });
      this.sendFailures = 0;
    } catch (error) {
      this.sendFailures += 1;
      this.log.error(
        { uid, err: error, sendFailures: this.sendFailures },
        'Could not send the email to Telegram, skipping it',
      );
      if (this.sendFailures >= MAX_CONSECUTIVE_SEND_FAILURES) {
        throw new Error(`${this.sendFailures} consecutive send failures, resetting the session`);
      }
    }
  }
}
