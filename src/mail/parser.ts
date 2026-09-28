import { simpleParser } from 'mailparser';
import { convert as htmlToText } from 'html-to-text';

export interface ParsedEmail {
  from: string;
  to: string | null;
  subject: string;
  date: Date | null;
  messageId: string | null;
  body: string;
  bodySource: 'text' | 'html' | 'empty';
  attachmentCount: number;
  attachmentNames: string[];
}

const ADDRESS_LIMIT = 5;

type AddressGroup = { text?: string; value?: { address?: string }[] };
type AddressField = AddressGroup | AddressGroup[] | undefined;

function formatAddresses(field: AddressField): string | null {
  if (!field) return null;

  const groups = Array.isArray(field) ? field : [field];
  const addresses: string[] = [];

  for (const group of groups) {
    const entries = group.value ?? [];
    if (entries.length === 0) {
      const text = group.text?.trim();
      if (text) return text;
      continue;
    }
    for (const entry of entries) {
      if (entry.address) addresses.push(entry.address);
    }
  }

  if (addresses.length === 0) return null;
  const shown = addresses.slice(0, ADDRESS_LIMIT);
  const extra = addresses.length - shown.length;
  return shown.join(', ') + (extra > 0 ? ` (+${extra} more)` : '');
}

function normalizeBody(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function parseEmail(source: Buffer): Promise<ParsedEmail> {
  const mail = await simpleParser(source);

  let body = mail.text?.trim() ?? '';
  let bodySource: ParsedEmail['bodySource'] = 'text';

  if (!body && typeof mail.html === 'string' && mail.html) {
    bodySource = 'html';
    try {
      body = htmlToText(mail.html, {
        wordwrap: 100,
        selectors: [
          { selector: 'a', options: { ignoreHref: false } },
          { selector: 'img', format: 'skip' },
          { selector: 'blockquote', format: 'indent' },
        ],
      });
    } catch {
      body = mail.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    }
  }

  if (!body) bodySource = 'empty';

  const subject = mail.subject?.trim() || '(no subject)';
  const date = mail.date instanceof Date && !Number.isNaN(mail.date.getTime()) ? mail.date : null;
  const attachments = mail.attachments ?? [];

  return {
    from: formatAddresses(mail.from) ?? '(unknown sender)',
    to: formatAddresses(mail.to),
    subject,
    date,
    messageId: typeof mail.messageId === 'string' ? mail.messageId : null,
    body: normalizeBody(body),
    bodySource,
    attachmentCount: attachments.length,
    attachmentNames: attachments
      .map((attachment) => attachment.filename)
      .filter((name): name is string => Boolean(name)),
  };
}
