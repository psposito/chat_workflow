import { ImapFlow } from 'imapflow';
import { isEmailNotified, markEmailNotified } from '../db/database';

export interface EmailSummary {
  messageId: string;
  from: string;
  subject: string;
  date: string;
}

function getImapClient(): ImapFlow {
  return new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER!,
      pass: process.env.GMAIL_APP_PASSWORD!,
    },
    logger: false,
  });
}

/**
 * Returns the list of important senders from env (lower-cased).
 * If GMAIL_IMPORTANT_SENDERS is empty, all unread emails are returned.
 */
function getImportantSenders(): string[] {
  return (process.env.GMAIL_IMPORTANT_SENDERS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isImportant(from: string, importantSenders: string[]): boolean {
  if (importantSenders.length === 0) return true; // no filter → all emails
  const lower = from.toLowerCase();
  return importantSenders.some((s) => lower.includes(s));
}

/**
 * Connects to Gmail via IMAP, fetches unseen emails from INBOX that are
 * "important" (based on GMAIL_IMPORTANT_SENDERS), skips already-notified
 * ones, and returns the new ones.
 *
 * Also marks fetched messages as seen in Gmail so they don't repeat.
 */
export async function fetchNewImportantEmails(): Promise<EmailSummary[]> {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    console.warn('[gmail] GMAIL_USER or GMAIL_APP_PASSWORD not set — skipping.');
    return [];
  }

  const client = getImapClient();
  const results: EmailSummary[] = [];
  const importantSenders = getImportantSenders();

  try {
    await client.connect();
    await client.mailboxOpen('INBOX');

    // Search for unseen messages
    const searchResult = await client.search({ seen: false });
    const uids = Array.isArray(searchResult) ? searchResult : [];
    if (uids.length === 0) {
      return [];
    }

    for await (const msg of client.fetch(uids, { envelope: true, flags: true })) {
      const env = msg.envelope!;
      const messageId = env.messageId ?? `uid-${msg.uid}`;
      const fromAddr = env.from?.[0]?.address ?? env.from?.[0]?.name ?? 'unknown';
      const subject = env.subject ?? '(sem assunto)';
      const date = env.date ? env.date.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '';

      if (isEmailNotified(messageId)) continue;
      if (!isImportant(fromAddr, importantSenders)) continue;

      results.push({ messageId, from: fromAddr, subject, date });
      markEmailNotified(messageId);

      // Mark as seen in Gmail so next poll won't pick it up again via IMAP
      await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen'], { uid: true });
    }
  } finally {
    await client.logout();
  }

  return results;
}

export function formatEmailsForWhatsApp(emails: EmailSummary[]): string {
  if (emails.length === 0) return '📭 Nenhum e-mail importante não lido no momento.';

  const lines = [`📬 *${emails.length} e-mail(s) importante(s):*`, ''];
  for (const [i, email] of emails.entries()) {
    lines.push(`*${i + 1}.* 📧 ${email.from}`);
    lines.push(`   📌 ${email.subject}`);
    lines.push(`   🕐 ${email.date}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}
