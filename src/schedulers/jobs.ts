import cron from 'node-cron';
import { listTasksDueToday } from '../db/database';
import { listTasks } from '../modules/tasks';
import { runSeoRadar } from '../modules/seoRadar';
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

export async function triggerSeoDigest(): Promise<void> {
  return runWeeklySeoDigest();
}

export function startJobs(): void {
  // Daily reminder — 08:00 BRT every day
  cron.schedule('0 8 * * *', runDailyReminder, { timezone: TZ });
  console.log('[jobs] Daily reminder scheduled — 08:00 BRT');

  // Weekly SEO digest — 09:00 BRT every Monday
  cron.schedule('0 9 * * 1', runWeeklySeoDigest, { timezone: TZ });
  console.log('[jobs] Weekly SEO digest scheduled — Mon 09:00 BRT');
}
