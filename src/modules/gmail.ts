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
  getUserPreferences,
  logEmailFeedback,
  getEmailClassificationStats,
  SenderReputation,
  GmailEmail,
  GoogleAccount,
  EmailCategory,
  EmailFeedback,
} from '../db/database';
import { withRetry } from '../utils/retry';

const TZ = 'America/Sao_Paulo';

// ---------------------------------------------------------------------------
// OpenAI client
// ---------------------------------------------------------------------------

let openai: OpenAI;
function getOpenAI(): OpenAI {
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

// ---------------------------------------------------------------------------
// OAuth2 client factory
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
// Parse "From" header
// ---------------------------------------------------------------------------

function parseSender(fromHeader: string): string {
  const match = fromHeader.match(/<([^>]+)>/);
  return match ? match[1] : fromHeader.trim();
}

// ---------------------------------------------------------------------------
// Silent hours check
// ---------------------------------------------------------------------------

function isInSilentHours(phone: string, category: EmailCategory): boolean {
  if (category === 'urgente') return false; // urgent always goes through

  const prefs = getUserPreferences(phone);
  const nowTime = new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ,
  }); // HH:MM

  const start = prefs.silent_start; // e.g. "22:00"
  const end = prefs.silent_end;     // e.g. "07:00"

  if (start <= end) {
    return nowTime >= start && nowTime < end;
  } else {
    // Wraps midnight: 22:00-07:00
    return nowTime >= start || nowTime < end;
  }
}

function shouldNotifyCategory(phone: string, category: EmailCategory): boolean {
  const prefs = getUserPreferences(phone);
  const allowedCategories = prefs.email_notify_categories.split(',').map((c) => c.trim());
  return allowedCategories.includes(category);
}

// ---------------------------------------------------------------------------
// Scoring — reputation-based bypass + AI fallback
// ---------------------------------------------------------------------------

function reputationDecision(rep: SenderReputation | null): 'important' | 'not_important' | null {
  if (!rep) return null;
  const total = rep.important_count + rep.not_important_count;
  if (total < 3) return null;
  const ratio = rep.important_count / total;
  if (ratio >= 0.8) return 'important';
  if (ratio <= 0.2) return 'not_important';
  return null;
}

async function classifyWithAI(
  sender: string,
  subject: string,
  rep: SenderReputation | null,
): Promise<{ category: EmailCategory; reason: string }> {
  const now = new Date();
  const dayOfWeek = now.toLocaleDateString('pt-BR', { weekday: 'long', timeZone: TZ });
  const hour = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: TZ });

  let repCtx = '';
  if (rep) {
    const total = rep.important_count + rep.not_important_count;
    if (total > 0) {
      repCtx = `\nHistórico do remetente: ${rep.important_count}x importante/urgente, ${rep.not_important_count}x ignorado.`;
    }
  }

  const completion = await withRetry(() =>
    getOpenAI().chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `Classifique este e-mail em uma das 4 categorias. Retorne JSON:
{"category":"urgente|importante|baixa_prioridade|nao_importante","reason":"motivo em 1 frase PT"}

Categorias:
- urgente: ação imediata — alertas de segurança, pagamentos vencidos, problemas de conta
- importante: relevante mas não urgente — bancos, trabalho, pessoas conhecidas
- baixa_prioridade: informativo — atualizações de serviço, confirmações de pedido, newsletters úteis
- nao_importante: irrelevante — promoções, marketing, redes sociais

Contexto: ${dayOfWeek}, ${hour}${repCtx}`,
        },
        {
          role: 'user',
          content: `De: ${sender}\nAssunto: ${subject}`,
        },
      ],
    }),
  );

  const VALID: EmailCategory[] = ['urgente', 'importante', 'baixa_prioridade', 'nao_importante'];
  try {
    const parsed = JSON.parse(completion.choices[0]?.message?.content ?? '{}');
    const category = VALID.includes(parsed.category) ? (parsed.category as EmailCategory) : 'importante';
    return { category, reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
  } catch {
    return { category: 'importante', reason: '' };
  }
}

const NOTIFY_CATEGORIES: EmailCategory[] = ['urgente', 'importante'];

// ---------------------------------------------------------------------------
// Main fetch + score pipeline
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
    const lastPolledMs = lastPolledStr ? parseInt(lastPolledStr, 10) : Date.now() - 60 * 60 * 1000;
    const afterSecs = Math.floor((lastPolledMs - 120_000) / 1000);
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
      if (err?.status === 401 || err?.code === 401) {
        disableGoogleAccount(account.id);
        accountErrors.push(`${account.email}: token inválido (conta desativada)`);
      } else {
        accountErrors.push(msg);
      }
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
        date = rawDate ? new Date(rawDate).toLocaleString('pt-BR', { timeZone: TZ }) : '';
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
// Format notification — grouped when 3+ emails
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

  if (emails.length >= 3) {
    // Grouped format
    const groups: Partial<Record<EmailCategory, EmailToNotify[]>> = {};
    for (const e of emails) {
      groups[e.category] = groups[e.category] ?? [];
      groups[e.category]!.push(e);
    }
    const order: EmailCategory[] = ['urgente', 'importante', 'baixa_prioridade', 'nao_importante'];
    let idx = 1;
    for (const cat of order) {
      const group = groups[cat];
      if (!group?.length) continue;
      lines.push(`${CATEGORY_LABEL[cat]}:`);
      for (const e of group) {
        const srcIcon = e.decisionSource === 'reputation' ? '⭐' : '';
        lines.push(`  *${idx}.* ${e.sender} — ${e.subject}${srcIcon ? ' ' + srcIcon : ''}`);
        idx++;
      }
      lines.push('');
    }
  } else {
    // Detailed format for 1-2 emails
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
  }

  if (emails.length === 1) {
    lines.push('_Classifique: *urgente*, *importante*, *baixa prioridade* ou *não importante*_');
  } else {
    lines.push('_Classifique com o número: *urgente 1*, *importante 2*, *não importante 3*_');
  }

  return lines.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Persist notification batch
// ---------------------------------------------------------------------------

export function persistNotificationBatch(phone: string, emails: EmailToNotify[]): void {
  saveNotificationBatch(
    phone,
    emails.map((e, i) => ({ idx: i + 1, emailId: e.dbId })),
  );
}

// ---------------------------------------------------------------------------
// Record user feedback with accuracy tracking
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

  // Map old ai_score to category for logging
  const aiCat: EmailCategory =
    email.ai_score >= 1.0 ? 'urgente' :
    email.ai_score >= 0.7 ? 'importante' :
    email.ai_score >= 0.2 ? 'baixa_prioridade' : 'nao_importante';

  setEmailFeedback(email.id, feedback);
  updateSenderReputation(email.sender, feedback);
  logEmailFeedback(phone, email.sender, email.subject, aiCat, feedback);

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
    : (feedback === 'urgente' || feedback === 'importante' || feedback === 'important') ? 100 : 0;

  return [
    `${label} — e-mail #${idx} registrado.`,
    `📊 *${email.sender}*: ${ratio}% relevante (${total} avaliação(ões))`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Email status panel
// ---------------------------------------------------------------------------

export function getEmailStatusPanel(phone: string): string {
  const stats = getEmailClassificationStats(phone);
  const lastPoll = getPollState('gmail_last_polled_default') ?? getPollState('gmail_last_polled_undefined');

  let lastPollStr = 'desconhecido';
  if (lastPoll) {
    const ms = Date.now() - parseInt(lastPoll, 10);
    const mins = Math.floor(ms / 60_000);
    lastPollStr = mins < 1 ? 'agora mesmo' : mins === 1 ? 'há 1 min' : `há ${mins} min`;
  }

  const lines = [
    `📧 *Status do e-mail:*`,
    `📊 Precisão da IA: ${stats.accuracy}% (${stats.correct}/${stats.total} classificações)`,
    `🕐 Último check: ${lastPollStr}`,
  ];

  if (stats.topMistake) {
    lines.push(`❌ Erro mais comum: _${stats.topMistake}_`);
  }

  lines.push('', '_Use *meus emails* para verificar novos e-mails._');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Filter emails by phone preferences before sending notifications
// ---------------------------------------------------------------------------

export function filterEmailsForPhone(phone: string, emails: EmailToNotify[]): EmailToNotify[] {
  return emails.filter((e) => {
    if (isInSilentHours(phone, e.category)) return false;
    if (!shouldNotifyCategory(phone, e.category)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Legacy compat
// ---------------------------------------------------------------------------

export async function fetchNewImportantEmails(): Promise<FetchResult> {
  return fetchAndScoreEmails();
}

export function formatEmailsForWhatsApp(emails: EmailToNotify[]): string {
  return formatEmailNotification(emails);
}
