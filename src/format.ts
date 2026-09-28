import type { ParsedEmail } from './mail/parser.js';

export interface FormatOptions {
  accountLabel: string;
  timeZone: string;
  previewChars: number;
  maxChunk: number;
}

const SEPARATOR = '--------------------';
const WRAPPER_OVERHEAD = 12;
const MIN_BODY_BUDGET = 500;

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDate(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  if (limit <= 0 || text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit).trimEnd()}...`, truncated: true };
}

export function splitText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > maxLength) {
    let cut = rest.lastIndexOf('\n', maxLength);
    if (cut < maxLength * 0.6) cut = rest.lastIndexOf(' ', maxLength);
    if (cut < maxLength * 0.6) cut = maxLength;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }

  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function field(label: string, value: string): string {
  return `<b>${label}</b>  ${escapeHtml(value)}`;
}

function headerBlock(email: ParsedEmail, options: FormatOptions): string {
  const fields = [
    field('From:', email.from),
    field('Subject:', email.subject),
  ];

  if (email.to) fields.push(field('To:', email.to));
  fields.push(field('Date:', email.date ? formatDate(email.date, options.timeZone) : '-'));
  fields.push(field('Account:', options.accountLabel));

  if (email.attachmentCount > 0) {
    const names = email.attachmentNames.join(', ');
    fields.push(field('Attachments:', `${email.attachmentCount}${names ? ` (${names})` : ''}`));
  }

  const lines = ['<b>NEW EMAIL</b>', ''];
  if (email.bodySource === 'empty') {
    lines.push('(this email has no text body)', '', ...fields);
  } else {
    lines.push(...fields);
  }

  return `${lines.join('\n')}\n${SEPARATOR}`;
}

export function formatEmailChunks(email: ParsedEmail, options: FormatOptions): string[] {
  const header = headerBlock(email, options);
  const { text: body, truncated } = truncate(email.body, options.previewChars);
  const suffix = truncated
    ? '\n<i>Body truncated. Raise BODY_PREVIEW_CHARS to show more.</i>'
    : '';

  if (!body) return [header];

  const firstBudget = Math.max(
    options.maxChunk - header.length - WRAPPER_OVERHEAD - suffix.length,
    MIN_BODY_BUDGET,
  );
  const [firstChunk, ...restChunks] = splitText(body, firstBudget);

  const messages: string[] = [`${header}\n<pre>${escapeHtml(firstChunk ?? '')}</pre>${suffix}`];
  const total = restChunks.length + 1;

  restChunks.forEach((chunk, index) => {
    const budget = Math.max(
      options.maxChunk - 24 - WRAPPER_OVERHEAD,
      MIN_BODY_BUDGET,
    );
    const parts = splitText(chunk, budget);
    parts.forEach((part, partIndex) => {
      const label =
        partIndex === 0
          ? `<i>(continued ${index + 2}/${total})</i>\n`
          : `<i>(continued ${index + 2}.${partIndex + 1})</i>\n`;
      messages.push(`${label}<pre>${escapeHtml(part)}</pre>${suffix}`);
    });
  });

  return messages;
}
