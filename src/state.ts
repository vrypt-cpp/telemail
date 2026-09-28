import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from './logger.js';

export interface MailboxCursor {
  uidValidity: string | null;
  lastUid: number;
}

interface StateFile {
  version: 1;
  mailboxes: Record<string, MailboxCursor>;
}

const STATE_VERSION = 1 as const;

export class StateStore {
  private data: StateFile = { version: STATE_VERSION, mailboxes: {} };
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly file: string) {}

  static async open(file: string): Promise<StateStore> {
    const store = new StateStore(file);
    await store.load();
    return store;
  }

  get(mailbox: string): MailboxCursor | undefined {
    return this.data.mailboxes[mailbox];
  }

  set(mailbox: string, cursor: MailboxCursor): void {
    this.data.mailboxes[mailbox] = cursor;
    this.persist();
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.info({ file: this.file }, 'No state file yet, it will be created on first delivery');
        return;
      }
      logger.warn({ err: error, file: this.file }, 'Could not read state file, starting from scratch');
      return;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<StateFile>;
      if (parsed.version !== STATE_VERSION) {
        logger.warn(
          { file: this.file, version: parsed.version },
          'State file version mismatch, ignoring saved cursor (older emails may be re-sent)',
        );
        return;
      }
      this.data = { version: STATE_VERSION, mailboxes: parsed.mailboxes ?? {} };
      logger.debug({ file: this.file }, 'State file loaded');
    } catch (error) {
      logger.warn({ err: error, file: this.file }, 'State file is not valid JSON, starting from scratch');
    }
  }

  private persist(): void {
    this.writeQueue = this.writeQueue
      .then(() => this.write())
      .catch((error: unknown) => {
        logger.error({ err: error, file: this.file }, 'Could not write state file');
      });
  }

  private async write(): Promise<void> {
    const payload = `${JSON.stringify(this.data, null, 2)}\n`;
    const temporary = `${this.file}.tmp`;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(temporary, payload, 'utf8');
    await rename(temporary, this.file);
  }
}
