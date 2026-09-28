import { setTimeout as delay } from 'node:timers/promises';
import { logger } from '../logger.js';

const DEFAULT_API_BASE = 'https://api.telegram.org';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 4;
const MAX_BACKOFF_MS = 15_000;

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly description: string,
    readonly errorCode: number | undefined,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'TelegramError';
  }
}

interface SendOptions {
  silent: boolean;
  extraDelayMs?: number;
}

export interface BotInfo {
  id: number;
  username: string;
  firstName?: string;
}

interface ApiResponse<T> {
  ok?: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export class TelegramSender {
  private lastSentAt = new Map<string, number>();

  constructor(
    private readonly token: string,
    private readonly chatIds: string[],
    private readonly minIntervalMs: number,
    private readonly apiBase: string = DEFAULT_API_BASE,
  ) {}

  async getMe(): Promise<BotInfo> {
    const result = await this.request<{ id: number; username: string; first_name?: string }>(
      'getMe',
      {},
    );
    return { id: result.id, username: result.username, firstName: result.first_name };
  }

  async sendHtml(text: string, options: SendOptions): Promise<void> {
    for (const chatId of this.chatIds) {
      await this.throttle(chatId, options.extraDelayMs);
      await this.call(chatId, 'sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        disable_notification: options.silent,
      });
    }
  }

  async sendHtmlSequence(texts: string[], options: SendOptions): Promise<void> {
    for (const [index, text] of texts.entries()) {
      await this.sendHtml(text, { ...options, extraDelayMs: index === 0 ? 0 : 300 });
    }
  }

  private async throttle(chatId: string, extraDelayMs = 0): Promise<void> {
    const target = this.minIntervalMs + extraDelayMs;
    if (target <= 0) return;

    const last = this.lastSentAt.get(chatId) ?? 0;
    const wait = last + target - Date.now();
    if (wait > 0) await delay(wait);
    this.lastSentAt.set(chatId, Date.now());
  }

  private async call(
    chatId: string,
    method: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.request(method, payload);
        logger.debug({ chatId, method, attempt }, 'Message sent to Telegram');
        return;
      } catch (error) {
        const retryable = !(error instanceof TelegramError && error.permanent);
        if (!retryable || attempt >= MAX_ATTEMPTS) throw error;

        const floodWait = this.retryAfter(error);
        const backoff = Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
        const wait = Math.max(floodWait, backoff);
        logger.warn({ chatId, method, attempt, wait, err: error }, 'Send failed, retrying');
        await delay(wait);
      }
    }
  }

  private retryAfter(error: unknown): number {
    if (!(error instanceof TelegramError)) return 0;
    const match = /retry after (\d+)/i.exec(error.description);
    return match?.[1] ? Number(match[1]) * 1000 : 0;
  }

  private async request<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const url = `${this.apiBase.replace(/\/+$/, '')}/bot${this.token}/${method}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new TelegramError(
        `Could not reach the Telegram API (${method})`,
        (error as Error).message,
        undefined,
        false,
      );
    }

    const body = (await response.json().catch(() => ({}))) as ApiResponse<T>;
    if (response.ok && body.ok === true) return body.result as T;

    let description = body.description ?? `HTTP ${response.status}`;
    if (body.parameters?.retry_after) {
      description += ` (retry_after: ${body.parameters.retry_after}s)`;
    }

    const permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
    throw new TelegramError(
      `Telegram API rejected ${method}: ${description}`,
      description,
      body.error_code,
      permanent,
    );
  }
}
