import cron from 'node-cron';
import { listTasksDueToday, getTasksDueNow, markTaskNotified, getEnabledGoogleAccounts } from '../db/database';
import { listTasks } from '../modules/tasks';
import { runSeoRadar } from '../modules/seoRadar';
import { fetchNewImportantEmails, formatEmailsForWhatsApp, persistNotificationBatch } from '../modules/gmail';
import { checkAndSendCalendarReminders } from '../modules/googleCalendar';
import { sendWhatsApp } from '../twilio';

const TZ = 'America/Sao_Paulo';

// ---------------------------------------------------------------------------
// Job 1 — Daily task reminder (08:00 BRT, every day)
// ---------------------------------------------------------------------------

async function runDailyReminder(): Promise<void> {
  console.log('[jobs] Running daily task reminder…');

  const tasksByPhone = listTasksDueToday();

  if (tasksByPhone.size === 0) {
    console.log('[jobs] No tasks due today.');
    return;
  }

  const sends = Array.from(tasksByPhone.entries()).map(async ([phone, _tasks]) => {
    const message = `🔔 *Lembretes de hoje!*\n\n${listTasks(phone)}`;
    try {
      await sendWhatsApp(phone.replace('whatsapp:', ''), message);
      console.log(`[jobs] Reminder sent to ${phone}`);
    } catch (err) {
      console.error(`[jobs] Failed to send reminder to ${phone}:`, (err as Error).message);
    }
  });

  await Promise.allSettled(sends);
}

// ---------------------------------------------------------------------------
// Job 2 — Weekly SEO digest (09:00 BRT, every Monday)
// ---------------------------------------------------------------------------

function getNotifyPhones(): string[] {
  return (process.env.NOTIFY_PHONES ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

async function runWeeklySeoDigest(): Promise<void> {
  console.log('[jobs] Running weekly SEO digest…');

  const phones = getNotifyPhones();
  if (phones.length === 0) {
    console.warn('[jobs] NOTIFY_PHONES is empty — skipping SEO digest.');
    return;
  }

  let digest: string;
  try {
    digest = await runSeoRadar();
  } catch (err) {
    console.error('[jobs] Failed to fetch SEO digest:', (err as Error).message);
    return;
  }

  const sends = phones.map(async (phone) => {
    try {
      await sendWhatsApp(phone.replace('whatsapp:', ''), digest);
      console.log(`[jobs] SEO digest sent to ${phone}`);
    } catch (err) {
      console.error(`[jobs] Failed to send SEO digest to ${phone}:`, (err as Error).message);
    }
  });

  await Promise.allSettled(sends);
}

// ---------------------------------------------------------------------------
// Register jobs
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Job 3 — Per-minute task due-time alert
// ---------------------------------------------------------------------------

async function runDueTimeAlerts(): Promise<void> {
  const now = new Date();
  const date = now.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); // YYYY-MM-DD

  // Use en-GB + hour12:false to guarantee "HH:MM" — pt-BR can produce "14h30" on some Node versions
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Sao_Paulo',
  }).format(now); // HH:MM

  const tasks = getTasksDueNow(date, time);
  if (tasks.length === 0) return;

  console.log(`[jobs] ${tasks.length} task(s) due at ${date} ${time}`);

  for (const task of tasks) {
    const lines = [
      `⏰ *Lembrete de tarefa!*`,
      `📌 *${task.title}*`,
    ];
    if (task.description) lines.push(`📝 ${task.description}`);
    lines.push(`🕐 Agora — ${time}`);

    try {
      await sendWhatsApp(task.phone.replace('whatsapp:', ''), lines.join('\n'));
      markTaskNotified(task.id);
      console.log(`[jobs] Due-time alert sent to ${task.phone} for task #${task.id}`);
    } catch (err) {
      console.error(`[jobs] Failed to send alert for task #${task.id}:`, (err as Error).message);
    }
  }
}

// ---------------------------------------------------------------------------
// Job 4 — Gmail important email polling (every 5 minutes)
// ---------------------------------------------------------------------------

async function runGmailPoll(): Promise<void> {
  console.log('[jobs] Polling Gmail for important emails…');

  const phones = getNotifyPhones();
  if (phones.length === 0) {
    console.warn('[jobs] NOTIFY_PHONES is empty — skipping Gmail poll.');
    return;
  }

  let fetchResult;
  try {
    fetchResult = await fetchNewImportantEmails();
  } catch (err) {
    console.error('[jobs] Gmail poll error:', (err as Error).message);
    return;
  }

  const { emails } = fetchResult;

  if (emails.length === 0) {
    console.log('[jobs] No new important emails.');
    return;
  }

  const message = formatEmailsForWhatsApp(emails);
  for (const phone of phones) {
    try {
      await sendWhatsApp(phone.replace('whatsapp:', ''), message);
      persistNotificationBatch(phone, emails);
      console.log(`[jobs] Gmail notification sent to ${phone}`);
    } catch (err) {
      console.error(`[jobs] Failed to send Gmail notification to ${phone}:`, (err as Error).message);
    }
  }
}

// ---------------------------------------------------------------------------
// Job 5 — Google Calendar 15-min reminders (every minute)
// ---------------------------------------------------------------------------

async function runCalendarReminders(): Promise<void> {
  await checkAndSendCalendarReminders(getNotifyPhones(), sendWhatsApp);
}

export async function triggerSeoDigest(): Promise<void> {
  return runWeeklySeoDigest();
}

export async function triggerCalendarReminders(): Promise<void> {
  return runCalendarReminders();
}

export interface GmailPollResult {
  phones: string[];
  emailsScanned: number;
  emailsImportant: number;
  emailsSent: number;
  errors: string[];
}

export async function triggerGmailPoll(): Promise<GmailPollResult> {
  const phones = getNotifyPhones();
  const errors: string[] = [];

  if (phones.length === 0) {
    return { phones, emailsScanned: 0, emailsImportant: 0, emailsSent: 0, errors: ['NOTIFY_PHONES is empty'] };
  }

  let fetchResult;
  try {
    fetchResult = await fetchNewImportantEmails();
  } catch (err) {
    return { phones, emailsScanned: 0, emailsImportant: 0, emailsSent: 0, errors: [(err as Error).message] };
  }

  const { emails, scanned } = fetchResult;

  if (emails.length === 0) {
    return { phones, emailsScanned: scanned, emailsImportant: 0, emailsSent: 0, errors: [] };
  }

  const message = formatEmailsForWhatsApp(emails);
  let emailsSent = 0;
  for (const phone of phones) {
    try {
      await sendWhatsApp(phone.replace('whatsapp:', ''), message);
      persistNotificationBatch(phone, emails);
      emailsSent++;
    } catch (err) {
      errors.push(`Failed to send to ${phone}: ${(err as Error).message}`);
    }
  }

  return { phones, emailsScanned: scanned, emailsImportant: emails.length, emailsSent, errors };
}

export async function triggerDueTimeAlerts(): Promise<void> {
  return runDueTimeAlerts();
}

export function startJobs(): void {
  // Daily reminder — 08:00 BRT every day
  cron.schedule('0 8 * * *', runDailyReminder, { timezone: TZ });
  console.log('[jobs] Daily reminder scheduled — 08:00 BRT');

  // Weekly SEO digest — 09:00 BRT every Monday
  cron.schedule('0 9 * * 1', runWeeklySeoDigest, { timezone: TZ });
  console.log('[jobs] Weekly SEO digest scheduled — Mon 09:00 BRT');

  // Per-minute due-time alerts
  cron.schedule('* * * * *', runDueTimeAlerts, { timezone: TZ });
  console.log('[jobs] Due-time alerts scheduled — every minute');

  // Gmail polling — every 5 minutes (credentials checked at poll time)
  cron.schedule('*/5 * * * *', runGmailPoll, { timezone: TZ });
  console.log('[jobs] Gmail polling scheduled — every 5 minutes');

  // Google Calendar reminders — every minute (only if accounts are linked)
  if (getEnabledGoogleAccounts().length > 0) {
    cron.schedule('* * * * *', runCalendarReminders, { timezone: TZ });
    console.log('[jobs] Google Calendar reminders scheduled — every minute');
  } else {
    console.log('[jobs] Google Calendar reminders disabled — run: npx tsx scripts/setup-google-account.ts');
  }
}
