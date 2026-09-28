import { pino } from 'pino';
import { getConfig } from './config.js';

function readLogSettings(): { level: string; pretty: boolean } {
  try {
    const config = getConfig();
    return { level: config.logLevel, pretty: config.logPretty };
  } catch {
    return {
      level: process.env.LOG_LEVEL ?? 'info',
      pretty: process.env.NODE_ENV !== 'production',
    };
  }
}

const settings = readLogSettings();

const base = {
  level: settings.level,
  base: { service: 'telemail' },
  redact: {
    paths: ['password', '*.password', 'token', '*.token', '*.botToken'],
    censor: '[REDACTED]',
  },
};

export const logger = settings.pretty
  ? pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname,service',
          messageFormat: '{msg}',
        },
      },
    })
  : pino(base);

export type Logger = typeof logger;
