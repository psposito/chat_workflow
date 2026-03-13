import OpenAI from 'openai';
import { ImapFlow } from 'imapflow';
import {
  isEmailNotified,
  upsertGmailEmail,
  markGmailEmailNotified,
  getSenderReputation,
  updateSenderReputation,
  setEmailFeedback,
  saveNotificationBatch,
  getEmailByBatchIndex,
  SenderReputation,
  GmailEmail,
} from '../db/database';

// ---------------------------------------------------------------------------
// OpenAI client
// ---------------------------------------------------------------------------

let openai: OpenAI;
function getOpenAI(): OpenAI {
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

// ---------------------------------------------------------------------------
// IMAP client factory
// ---------------------------------------------------------------------------

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
    connectionTimeout: 10000,
    greetTimeout: 10000,
    socketTimeout: 15000,
  });
}

// ---------------------------------------------------------------------------
// Scoring — reputation-based bypass + AI fallback
// ---------------------------------------------------------------------------

/**
 * Decision based purely on accumulated user feedback for this sender.
 * Returns 'important' or 'not_important' when we have enough data (≥3 signals,
 * ≥80% leaning one way). Returns null when uncertain → fall through to AI.
 */
function reputationDecision(rep: SenderReputation | null): 'important' | 'not_important' | null {
  if (!rep) return null;
  const total = rep.important_count + rep.not_important_count;
  if (total < 3) return null;
  const ratio = rep.important_count / total;
  if (ratio >= 0.8) return 'important';
  if (ratio <= 0.2) return 'not_important';
  return null;
}

/**
 * AI-based scoring via GPT-4o-mini.
 * Returns a score from 0 to 1 and a brief reason.
 */
async function scoreWithAI(
  sender: string,
  subject: string,
  rep: SenderReputation | null,
): Promise<{ score: number; reason: string }> {
  let reputationCtx = '';
  if (rep) {
    const total = rep.important_count + rep.not_important_count;
    if (total > 0) {
      reputationCtx = `\nHistórico deste remetente: ${rep.important_count} e-mail(s) marcado(s) como importante e ${rep.not_important_count} como não importante pelo usuário.`;
    }
  }

  const completion = await getOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `Você é um classificador de e-mails pessoais. Analise o remetente e assunto e retorne JSON com:
- score: número de 0 a 1 (1 = extremamente importante, 0 = irrelevante)
- reason: string (máximo 10 palavras explicando)

Considere IMPORTANTES (score alto): bancos, trabalho, pagamentos, alertas de segurança, pessoas conhecidas, urgências, confirmações de transação.
Considere NÃO IMPORTANTES (score baixo): newsletters, promoções, marketing, redes sociais, notificações genéricas automáticas, cupons.${reputationCtx}`,
      },
      {
        role: 'user',
        content: `Remetente: ${sender}\nAssunto: ${subject}`,
      },
    ],
  });

  try {
    const parsed = JSON.parse(completion.choices[0]?.message?.content ?? '{}');
    return {
      score: typeof parsed.score === 'number' ? Math.min(1, Math.max(0, parsed.score)) : 0.5,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    };
  } catch {
    return { score: 0.5, reason: '' };
  }
}

// Default score threshold — emails with score >= this get notified
const NOTIFY_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Main fetch + score + notify pipeline
// ---------------------------------------------------------------------------

export interface EmailToNotify {
  dbId: number;
  sender: string;
  subject: string;
  date: string;
  score: number;
  reason: string;
  decisionSource: 'reputation' | 'ai';
}

export async function fetchAndScoreEmails(): Promise<EmailToNotify[]> {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    console.warn('[gmail] GMAIL_USER or GMAIL_APP_PASSWORD not set — skipping.');
    return [];
  }

  const client = getImapClient();
  const results: EmailToNotify[] = [];

  try {
    await client.connect();
    await client.mailboxOpen('INBOX');

    const searchResult = await client.search({ seen: false });
    const uids = Array.isArray(searchResult) ? searchResult : [];
    if (uids.length === 0) return [];

    for await (const msg of client.fetch(uids, { envelope: true })) {
      const env = msg.envelope!;
      const messageId = env.messageId ?? `uid-${msg.uid}`;
      const sender = env.from?.[0]?.address ?? env.from?.[0]?.name ?? 'unknown';
      const subject = env.subject ?? '(sem assunto)';
      const date = env.date
        ? env.date.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
        : '';

      if (isEmailNotified(messageId)) continue;

      const rep = getSenderReputation(sender);
      const repDecision = reputationDecision(rep);

      let score: number;
      let reason: string;
      let decisionSource: 'reputation' | 'ai';

      if (repDecision === 'important') {
        score = 1;
        reason = 'remetente confiável';
        decisionSource = 'reputation';
      } else if (repDecision === 'not_important') {
        score = 0;
        reason = 'remetente ignorado';
        decisionSource = 'reputation';
      } else {
        const aiResult = await scoreWithAI(sender, subject, rep);
        score = aiResult.score;
        reason = aiResult.reason;
        decisionSource = 'ai';
      }

      // Persist email record
      const email = upsertGmailEmail(messageId, sender, subject, score);

      if (score >= NOTIFY_THRESHOLD) {
        // Mark as seen in Gmail to avoid re-fetching
        await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen'], { uid: true });
        markGmailEmailNotified(email.id);
        results.push({ dbId: email.id, sender, subject, date, score, reason, decisionSource });
      } else {
        console.log(`[gmail] Skipped (score ${score.toFixed(2)}): ${sender} — ${subject}`);
        // Still mark as seen so we don't keep re-evaluating
        await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen'], { uid: true });
        markGmailEmailNotified(email.id);
      }
    }
  } finally {
    await client.logout();
  }

  return results;
}

// ---------------------------------------------------------------------------
// Format notification message
// ---------------------------------------------------------------------------

export function formatEmailNotification(emails: EmailToNotify[]): string {
  if (emails.length === 0) return '📭 Nenhum e-mail importante no momento.';

  const lines = [`📬 *${emails.length} e-mail(s) importante(s):*`, ''];

  for (const [i, e] of emails.entries()) {
    const idx = i + 1;
    const srcIcon = e.decisionSource === 'reputation' ? '⭐' : '🤖';
    lines.push(`*${idx}.* 📧 ${e.sender}`);
    lines.push(`   📌 ${e.subject}`);
    lines.push(`   🕐 ${e.date}`);
    lines.push(`   ${srcIcon} Score: ${Math.round(e.score * 100)}% — ${e.reason}`);
    lines.push('');
  }

  lines.push('_Responda *importante 1* ou *não importante 2* para me ensinar._');
  return lines.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Save notification batch (so feedback commands can reference by index)
// ---------------------------------------------------------------------------

export function persistNotificationBatch(phone: string, emails: EmailToNotify[]): void {
  saveNotificationBatch(
    phone,
    emails.map((e, i) => ({ idx: i + 1, emailId: e.dbId })),
  );
}

// ---------------------------------------------------------------------------
// Record user feedback ("importante 1" / "não importante 2")
// ---------------------------------------------------------------------------

export function recordEmailFeedback(
  phone: string,
  idx: number,
  feedback: 'important' | 'not_important',
): string {
  const email = getEmailByBatchIndex(phone, idx);
  if (!email) {
    return `⚠️ E-mail #${idx} não encontrado. Use *meus emails* para ver a lista atual.`;
  }

  setEmailFeedback(email.id, feedback);
  updateSenderReputation(email.sender, feedback);

  const label = feedback === 'important' ? '✅ importante' : '🚫 não importante';
  const rep = getSenderReputation(email.sender);
  const total = rep ? rep.important_count + rep.not_important_count : 1;
  const ratio = rep ? Math.round((rep.important_count / total) * 100) : (feedback === 'important' ? 100 : 0);

  return [
    `${label} — e-mail #${idx} registrado.`,
    `📊 *${email.sender}*: ${ratio}% importante (${total} avaliação(ões))`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Legacy compat — fetchNewImportantEmails used by /trigger-gmail endpoint
// and "meus emails" command
// ---------------------------------------------------------------------------

export async function fetchNewImportantEmails(): Promise<EmailToNotify[]> {
  return fetchAndScoreEmails();
}

export function formatEmailsForWhatsApp(emails: EmailToNotify[]): string {
  return formatEmailNotification(emails);
}
