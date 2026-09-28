import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'y']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'n', '']);

const BOOL_KEYS = {
  TELEGRAM_SILENT: false,
  IMAP_SECURE: true,
  IMAP_MARK_SEEN: false,
  IMAP_TLS_REJECT_UNAUTHORIZED: true,
  LOG_PRETTY: true,
} as const;

const INT_KEYS = {
  TELEGRAM_SEND_INTERVAL_MS: { fallback: 1000, min: 0, max: 60_000 },
  TELEGRAM_MAX_CHUNK: { fallback: 3800, min: 200, max: 4096 },
  BODY_PREVIEW_CHARS: { fallback: 3000, min: 0, max: 1_000_000 },
  IMAP_PORT: { fallback: 993, min: 1, max: 65_535 },
  IMAP_POLL_INTERVAL_MS: { fallback: 60_000, min: 5_000, max: 3_600_000 },
  IMAP_AUTO_IDLE_DELAY_MS: { fallback: 15_000, min: 1_000, max: 300_000 },
  IMAP_BATCH_SIZE: { fallback: 10, min: 1, max: 100 },
} as const;

export class ConfigIssues extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigIssues';
  }
}

function coercePrimitives(
  source: Record<string, unknown>,
): { values: Record<string, unknown>; issues: string[] } {
  const values: Record<string, unknown> = { ...source };
  const issues: string[] = [];

  for (const [key, fallback] of Object.entries(BOOL_KEYS)) {
    const raw = source[key];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      values[key] = fallback;
      continue;
    }
    const value = String(raw).trim().toLowerCase();
    if (TRUE_VALUES.has(value)) values[key] = true;
    else if (FALSE_VALUES.has(value)) values[key] = false;
    else {
      values[key] = fallback;
      issues.push(`${key} expects true or false (or 1/0, yes/no), got "${String(raw)}"`);
    }
  }

  for (const [key, spec] of Object.entries(INT_KEYS)) {
    const raw = source[key];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      values[key] = spec.fallback;
      continue;
    }
    const value = Number(String(raw).trim());
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      values[key] = spec.fallback;
      issues.push(`${key} expects an integer, got "${String(raw)}"`);
    } else if (value < spec.min || value > spec.max) {
      values[key] = spec.fallback;
      issues.push(`${key} must be between ${spec.min} and ${spec.max}, got "${String(raw)}"`);
    } else {
      values[key] = value;
    }
  }

  const chatIds = String(source.TELEGRAM_CHAT_IDS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (chatIds.some((id) => !/^-?\d+$/.test(id))) {
    issues.push(
      'TELEGRAM_CHAT_IDS must contain numeric chat ids (personal chats use the user id, groups and channels use an id starting with -100)',
    );
  }

  return { values, issues };
}

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z
    .string({ required_error: 'TELEGRAM_BOT_TOKEN is required' })
    .trim()
    .min(10, 'TELEGRAM_BOT_TOKEN is not valid (get one from @BotFather)'),
  TELEGRAM_CHAT_IDS: z
    .string({ required_error: 'TELEGRAM_CHAT_IDS is required' })
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    )
    .refine((ids) => ids.length > 0, 'TELEGRAM_CHAT_IDS must contain at least one chat id'),
  TELEGRAM_API_BASE: z.string().trim().url().default('https://api.telegram.org'),
  TELEGRAM_SEND_INTERVAL_MS: z.number().int(),
  TELEGRAM_MAX_CHUNK: z.number().int(),
  TELEGRAM_SILENT: z.boolean(),
  BODY_PREVIEW_CHARS: z.number().int(),

  IMAP_HOST: z
    .string({ required_error: 'IMAP_HOST is required' })
    .trim()
    .min(1, 'IMAP_HOST must not be empty'),
  IMAP_PORT: z.number().int(),
  IMAP_SECURE: z.boolean(),
  IMAP_USER: z
    .string({ required_error: 'IMAP_USER is required' })
    .trim()
    .min(1, 'IMAP_USER must not be empty'),
  IMAP_PASSWORD: z
    .string({ required_error: 'IMAP_PASSWORD is required (use an app password)' })
    .min(1, 'IMAP_PASSWORD must not be empty'),
  IMAP_MAILBOX: z.string().trim().min(1).default('INBOX'),
  IMAP_MARK_SEEN: z.boolean(),
  IMAP_INITIAL_MODE: z.enum(['latest', 'all']).default('latest'),
  IMAP_POLL_INTERVAL_MS: z.number().int(),
  IMAP_AUTO_IDLE_DELAY_MS: z.number().int(),
  IMAP_BATCH_SIZE: z.number().int(),
  IMAP_TLS_REJECT_UNAUTHORIZED: z.boolean(),

  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
    .default('info'),
  LOG_PRETTY: z.boolean(),
  TIMEZONE: z.string().trim().min(1).default('Asia/Jakarta'),
  STATE_FILE: z.string().trim().min(1).default('./data/state.json'),
});

export interface Config {
  telegram: {
    botToken: string;
    chatIds: string[];
    apiBase: string;
    sendIntervalMs: number;
    maxChunk: number;
    silent: boolean;
    bodyPreviewChars: number;
  };
  imap: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    mailbox: string;
    markSeen: boolean;
    initialMode: 'latest' | 'all';
    pollIntervalMs: number;
    autoIdleDelayMs: number;
    batchSize: number;
    rejectUnauthorized: boolean;
  };
  logLevel: string;
  logPretty: boolean;
  timeZone: string;
  stateFile: string;
}

let cached: Config | undefined;

function buildConfig(source: Record<string, unknown>): Config {
  const { values, issues } = coercePrimitives(source);
  const parsed = envSchema.safeParse(values);

  if (!parsed.success) {
    issues.push(
      ...parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }

  if (issues.length > 0 || !parsed.success) {
    throw new ConfigIssues([...new Set(issues)]);
  }

  const value = parsed.data;
  return {
    telegram: {
      botToken: value.TELEGRAM_BOT_TOKEN,
      chatIds: value.TELEGRAM_CHAT_IDS,
      apiBase: value.TELEGRAM_API_BASE.replace(/\/+$/, ''),
      sendIntervalMs: value.TELEGRAM_SEND_INTERVAL_MS,
      maxChunk: value.TELEGRAM_MAX_CHUNK,
      silent: value.TELEGRAM_SILENT,
      bodyPreviewChars: value.BODY_PREVIEW_CHARS,
    },
    imap: {
      host: value.IMAP_HOST,
      port: value.IMAP_PORT,
      secure: value.IMAP_SECURE,
      user: value.IMAP_USER,
      password: value.IMAP_PASSWORD,
      mailbox: value.IMAP_MAILBOX,
      markSeen: value.IMAP_MARK_SEEN,
      initialMode: value.IMAP_INITIAL_MODE,
      pollIntervalMs: value.IMAP_POLL_INTERVAL_MS,
      autoIdleDelayMs: value.IMAP_AUTO_IDLE_DELAY_MS,
      batchSize: value.IMAP_BATCH_SIZE,
      rejectUnauthorized: value.IMAP_TLS_REJECT_UNAUTHORIZED,
    },
    logLevel: value.LOG_LEVEL,
    logPretty: value.LOG_PRETTY,
    timeZone: value.TIMEZONE,
    stateFile: resolve(process.cwd(), value.STATE_FILE),
  };
}

export function getConfig(): Config {
  cached ??= buildConfig(process.env);
  return cached;
}

export function tryLoadConfig(): { config: Config } | { error: string } {
  try {
    return { config: getConfig() };
  } catch (error) {
    if (error instanceof ConfigIssues) return { error: error.message };
    if (error instanceof z.ZodError) {
      return { error: new ConfigIssues(error.issues.map((issue) => issue.message)).message };
    }
    return { error: `Failed to load configuration: ${(error as Error).message}` };
  }
}
