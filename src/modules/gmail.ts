import OpenAI from 'openai';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import {
  isEmailNotified,
  upsertGmailEmail,
  markGmailEmailNotified,
  getSenderReputation,
  updateSenderReputation,
  setEmailFeedback,
  saveNotificationBatch,
  getEmailByBatchIndex,
  getEnabledGoogleAccounts,
  updateGoogleAccountTokens,
  disableGoogleAccount,
  getPollState,
  setPollState,
  SenderReputation,
  GmailEmail,
  GoogleAccount,
  EmailCategory,
  EmailFeedback,
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
// OAuth2 client factory (reuses same pattern as googleCalendar.ts)
// ---------------------------------------------------------------------------

function buildOAuth2Client(account: GoogleAccount): OAuth2Client {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );

  client.setCredentials({
    access_token: account.access_token,
    refresh_token: account.refresh_token,
    expiry_date: account.token_expiry ? new Date(account.token_expiry).getTime() : undefined,
  });

  client.on('tokens', (tokens) => {
    if (tokens.access_token) {
      const expiry = tokens.expiry_date
        ? new Date(tokens.expiry_date).toISOString()
        : new Date(Date.now() + 3_600_000).toISOString();
      updateGoogleAccountTokens(account.id, tokens.access_token, expiry);
    }
  });

  return client;
}

// ---------------------------------------------------------------------------
// Parse "From" header — extract email address from "Name <email>" or plain
// ---------------------------------------------------------------------------

function parseSender(fromHeader: string): string {
  const match = fromHeader.match(/<([^>]+)>/);
  return match ? match[1] : fromHeader.trim();
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
 * AI-based classification via GPT-4o-mini.
 * Returns one of 4 categories and a brief reason.
 */
async function classifyWithAI(
  sender: string,
  subject: string,
  rep: SenderReputation | null,
): Promise<{ category: EmailCategory; reason: string }> {
  let reputationCtx = '';
  if (rep) {
    const total = rep.important_count + rep.not_important_count;
    if (total > 0) {
      reputationCtx = `\nHistórico deste remetente: ${rep.important_count} marcado(s) como importante/urgente e ${rep.not_important_count} como baixa prioridade/não importante pelo usuário.`;
    }
  }

  const completion = await getOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `Você é um classificador de e-mails pessoais. Analise o remetente e assunto e retorne JSON com:
- category: uma das opções abaixo (string exata)
- reason: string (máximo 10 palavras explicando em português)

Categorias (escolha exatamente uma):
- "urgente": requer ação imediata — alertas de segurança, pagamentos vencidos, problemas de conta, situações de emergência
- "importante": relevante mas não urgente — bancos, trabalho, confirmações de transação, pessoas conhecidas
- "baixa_prioridade": informativo, sem ação necessária — atualizações de serviços, confirmações de pedidos, newsletters úteis
- "nao_importante": irrelevante — promoções, marketing, redes sociais, cupons, notificações genéricas automáticas${reputationCtx}`,
      },
      {
        role: 'user',
        content: `Remetente: ${sender}\nAssunto: ${subject}`,
      },
    ],
  });

  const VALID: EmailCategory[] = ['urgente', 'importante', 'baixa_prioridade', 'nao_importante'];
  try {
    const parsed = JSON.parse(completion.choices[0]?.message?.content ?? '{}');
    const category = VALID.includes(parsed.category) ? (parsed.category as EmailCategory) : 'importante';
    return { category, reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
  } catch {
    return { category: 'importante', reason: '' };
  }
}

/** Categories that trigger a WhatsApp notification */
const NOTIFY_CATEGORIES: EmailCategory[] = ['urgente', 'importante'];

// ---------------------------------------------------------------------------
// Main fetch + score + notify pipeline (Gmail API — HTTPS, no IMAP needed)
// ---------------------------------------------------------------------------

export interface EmailToNotify {
  dbId: number;
  sender: string;
  subject: string;
  date: string;
  category: EmailCategory;
  reason: string;
  decisionSource: 'reputation' | 'ai';
}

export interface FetchResult {
  emails: EmailToNotify[];
  scanned: number;
  accountErrors: string[];
}

export async function fetchAndScoreEmails(): Promise<FetchResult> {
  const accounts = getEnabledGoogleAccounts();
  if (accounts.length === 0) {
    console.warn('[gmail] No Google accounts linked — skipping.');
    return { emails: [], scanned: 0, accountErrors: [] };
  }

  const results: EmailToNotify[] = [];
  const accountErrors: string[] = [];
  let scanned = 0;

  for (const account of accounts) {
    const stateKey = `gmail_last_polled_${account.email}`;
    const lastPolledStr = getPollState(stateKey);

    // On first run, look back 1 hour to catch recent emails without flooding old ones
    const lastPolledMs = lastPolledStr ? parseInt(lastPolledStr, 10) : Date.now() - 60 * 60 * 1000;
    const afterSecs = Math.floor((lastPolledMs - 120_000) / 1000); // 2 min overlap to avoid gaps
    setPollState(stateKey, String(Date.now()));

    const auth = buildOAuth2Client(account);
    const gmailApi = google.gmail({ version: 'v1', auth });

    let messageIds: string[];
    try {
      const listRes = await gmailApi.users.messages.list({
        userId: 'me',
        q: `is:unread in:inbox after:${afterSecs}`,
        maxResults: 20,
      });
      messageIds = (listRes.data.messages ?? []).map((m) => m.id!).filter(Boolean);
    } catch (err: any) {
      const msg = `[gmail] Account ${account.email}: ${(err as Error).message} (status=${err?.status ?? err?.code ?? 'unknown'})`;
      console.error(msg);
      accountErrors.push(msg);
      continue;
    }

    for (const msgId of messageIds) {
      scanned++;
      if (isEmailNotified(msgId)) continue;

      let sender = 'unknown';
      let subject = '(sem assunto)';
      let date = '';

      try {
        const msgRes = await gmailApi.users.messages.get({
          userId: 'me',
          id: msgId,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date'],
        });

        const headers = msgRes.data.payload?.headers ?? [];
        const get = (name: string) => headers.find((h) => h.name === name)?.value ?? '';

        sender = parseSender(get('From')) || 'unknown';
        subject = get('Subject') || '(sem assunto)';
        const rawDate = get('Date');
        date = rawDate
          ? new Date(rawDate).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
          : '';
      } catch (err) {
        console.error(`[gmail] Failed to fetch message ${msgId}:`, (err as Error).message);
        continue;
      }

      const rep = getSenderReputation(sender);
      const repDecision = reputationDecision(rep);

      let category: EmailCategory;
      let reason: string;
      let decisionSource: 'reputation' | 'ai';

      if (repDecision === 'important') {
        category = 'importante';
        reason = 'remetente confiável';
        decisionSource = 'reputation';
      } else if (repDecision === 'not_important') {
        category = 'nao_importante';
        reason = 'remetente ignorado';
        decisionSource = 'reputation';
      } else {
        const aiResult = await classifyWithAI(sender, subject, rep);
        category = aiResult.category;
        reason = aiResult.reason;
        decisionSource = 'ai';
      }

      // Map category to a numeric score for DB storage
      const categoryScore: Record<EmailCategory, number> = {
        urgente: 1.0,
        importante: 0.75,
        baixa_prioridade: 0.25,
        nao_importante: 0.0,
      };
      const email = upsertGmailEmail(msgId, sender, subject, categoryScore[category]);

      if (NOTIFY_CATEGORIES.includes(category)) {
        markGmailEmailNotified(email.id);
        results.push({ dbId: email.id, sender, subject, date, category, reason, decisionSource });
      } else {
        console.log(`[gmail] Skipped (${category}): ${sender} — ${subject}`);
      }
    }
  }

  return { emails: results, scanned, accountErrors };
}

// ---------------------------------------------------------------------------
// Format notification message
// ---------------------------------------------------------------------------

const CATEGORY_LABEL: Record<EmailCategory, string> = {
  urgente: '🚨 Urgente',
  importante: '📧 Importante',
  baixa_prioridade: '📋 Baixa prioridade',
  nao_importante: '🗑️ Não importante',
};

export function formatEmailNotification(emails: EmailToNotify[]): string {
  if (emails.length === 0) return '📭 Nenhum e-mail novo no momento.';

  const lines = [`📬 *${emails.length} e-mail(s) novo(s):*`, ''];

  for (const [i, e] of emails.entries()) {
    const idx = i + 1;
    const srcIcon = e.decisionSource === 'reputation' ? '⭐' : '🤖';
    lines.push(`*${idx}.* ${CATEGORY_LABEL[e.category]} ${srcIcon}`);
    lines.push(`   📧 ${e.sender}`);
    lines.push(`   📌 ${e.subject}`);
    lines.push(`   🕐 ${e.date}`);
    if (e.reason) lines.push(`   _${e.reason}_`);
    lines.push('');
  }

  if (emails.length === 1) {
    lines.push('_Classifique: *urgente*, *importante*, *baixa prioridade* ou *não importante*_');
  } else {
    lines.push('_Classifique com o número: *urgente 1*, *importante 2*, *baixa prioridade 3*, *não importante 3*_');
  }
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
  feedback: EmailFeedback,
): string {
  const email = getEmailByBatchIndex(phone, idx);
  if (!email) {
    return `⚠️ E-mail #${idx} não encontrado. Use *meus emails* para ver a lista atual.`;
  }

  setEmailFeedback(email.id, feedback);
  updateSenderReputation(email.sender, feedback);

  const FEEDBACK_LABEL: Record<EmailFeedback, string> = {
    urgente: '🚨 Urgente',
    importante: '✅ Importante',
    important: '✅ Importante',
    baixa_prioridade: '📋 Baixa prioridade',
    nao_importante: '🚫 Não importante',
    not_important: '🚫 Não importante',
  };
  const label = FEEDBACK_LABEL[feedback] ?? feedback;
  const rep = getSenderReputation(email.sender);
  const total = rep ? rep.important_count + rep.not_important_count : 1;
  const ratio = rep
    ? Math.round((rep.important_count / total) * 100)
    : feedback === 'urgente' || feedback === 'importante' || feedback === 'important'
      ? 100
      : 0;

  return [
    `${label} — e-mail #${idx} registrado.`,
    `📊 *${email.sender}*: ${ratio}% relevante (${total} avaliação(ões))`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Legacy compat — fetchNewImportantEmails used by /trigger-gmail endpoint
// and "meus emails" command
// ---------------------------------------------------------------------------

export async function fetchNewImportantEmails(): Promise<FetchResult> {
  return fetchAndScoreEmails();
}

export function formatEmailsForWhatsApp(emails: EmailToNotify[]): string {
  return formatEmailNotification(emails);
}
