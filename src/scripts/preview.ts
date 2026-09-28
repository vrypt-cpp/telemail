import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { formatEmailChunks } from '../format.js';
import { parseEmail } from '../mail/parser.js';

const out = process.stdout;
const [, , fileArgument, previewArgument] = process.argv;

if (!fileArgument) {
  process.stderr.write('Usage: npm run preview -- <file.eml> [previewChars]\n');
  process.exit(1);
}

const file = resolve(process.cwd(), fileArgument);
const previewChars = previewArgument ? Number(previewArgument) : 3000;

const email = await parseEmail(await readFile(file));
const chunks = formatEmailChunks(email, {
  accountLabel: 'user@example.com',
  timeZone: 'Asia/Jakarta',
  previewChars,
  maxChunk: 3800,
});

out.write(
  [
    `File        : ${file}`,
    `From        : ${email.from}`,
    `To          : ${email.to ?? '-'}`,
    `Subject     : ${email.subject}`,
    `Date        : ${email.date?.toISOString() ?? '-'}`,
    `Body source : ${email.bodySource} (${email.body.length} characters)`,
    `Attachments : ${email.attachmentCount}`,
    '',
    '-'.repeat(60),
    '',
  ].join('\n'),
);

chunks.forEach((chunk, index) => {
  const label = chunks.length > 1 ? `Part ${index + 1} of ${chunks.length}` : 'Message';
  out.write(
    [
      '',
      `===== ${label}, ${chunk.length} characters (Telegram limit 4096) =====`,
      '',
      chunk,
      '',
    ].join('\n'),
  );
});
