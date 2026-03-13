import OpenAI from 'openai';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import {
  GoogleAccount,
  getEnabledGoogleAccounts,
  updateGoogleAccountTokens,
  disableGoogleAccount,
  isCalendarEventNotified,
  markCalendarEventNotified,
} from '../db/database';

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
// OAuth2 client factory with auto-persist token refresh
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

  // Persist new access_token whenever googleapis performs a silent refresh
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
// Types
// ---------------------------------------------------------------------------

export interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  location?: string;
  description?: string;
  allDay: boolean;
  accountEmail: string;
}

export interface NewEventDetails {
  title: string;
  startDateTime: Date;
  endDateTime: Date;
  description?: string;
  location?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dayBounds(tz: string): { start: Date; end: Date } {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
  const start = new Date(`${dateStr}T00:00:00`);
  const end = new Date(`${dateStr}T23:59:59`);
  // Adjust for timezone offset
  const offsetMs = now.getTimezoneOffset() * 60_000;
  return {
    start: new Date(start.getTime() + offsetMs),
    end: new Date(end.getTime() + offsetMs),
  };
}

function parseGoogleEvent(item: any, accountEmail: string): CalendarEvent {
  const allDay = !!item.start?.date;
  const start = allDay ? new Date(`${item.start.date}T00:00:00`) : new Date(item.start.dateTime);
  const end = allDay ? new Date(`${item.end?.date ?? item.start.date}T23:59:59`) : new Date(item.end?.dateTime ?? item.start.dateTime);

  return {
    id: item.id,
    title: item.summary ?? '(sem título)',
    start,
    end,
    location: item.location ?? undefined,
    description: item.description ?? undefined,
    allDay,
    accountEmail,
  };
}

async function withTokenErrorHandling<T>(
  account: GoogleAccount,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (err: any) {
    const status = err?.response?.status ?? err?.code;
    if (status === 401 || status === 403) {
      console.error(`[calendar] Token inválido para ${account.email} — desativando conta`);
      disableGoogleAccount(account.id);
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Core API functions
// ---------------------------------------------------------------------------

export async function listTodayEvents(account: GoogleAccount): Promise<CalendarEvent[]> {
  const auth = buildOAuth2Client(account);
  const cal = google.calendar({ version: 'v3', auth });
  const { start, end } = dayBounds(TZ);

  const result = await withTokenErrorHandling(account, () =>
    cal.events.list({
      calendarId: 'primary',
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 20,
    }),
  );

  return (result?.data.items ?? []).map((item) => parseGoogleEvent(item, account.email));
}

export async function listUpcomingEvents(
  account: GoogleAccount,
  minutesAhead: number,
): Promise<CalendarEvent[]> {
  const auth = buildOAuth2Client(account);
  const cal = google.calendar({ version: 'v3', auth });
  const now = new Date();
  const windowStart = new Date(now.getTime() + (minutesAhead - 2) * 60_000);
  const windowEnd = new Date(now.getTime() + (minutesAhead + 2) * 60_000);

  const result = await withTokenErrorHandling(account, () =>
    cal.events.list({
      calendarId: 'primary',
      timeMin: windowStart.toISOString(),
      timeMax: windowEnd.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 10,
    }),
  );

  return (result?.data.items ?? [])
    .filter((item) => item.start?.dateTime) // only timed events, not all-day
    .map((item) => parseGoogleEvent(item, account.email));
}

export async function createEvent(
  account: GoogleAccount,
  details: NewEventDetails,
): Promise<CalendarEvent> {
  const auth = buildOAuth2Client(account);
  const cal = google.calendar({ version: 'v3', auth });

  const response = await cal.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: details.title,
      description: details.description,
      location: details.location,
      start: { dateTime: details.startDateTime.toISOString(), timeZone: TZ },
      end: { dateTime: details.endDateTime.toISOString(), timeZone: TZ },
    },
  });

  return parseGoogleEvent(response.data, account.email);
}

// ---------------------------------------------------------------------------
// AI event extraction (mirrors extractAndSaveTask in tasks.ts)
// ---------------------------------------------------------------------------

interface ExtractedEvent {
  title: string;
  description: string;
  date: string | null;       // YYYY-MM-DD
  time: string | null;       // HH:MM (24h)
  duration_minutes: number;
  has_date: boolean;
  has_time: boolean;
}

async function extractEventFromMessage(message: string): Promise<ExtractedEvent> {
  const today = new Date().toISOString().slice(0, 10);
  const completion = await getOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `Você é um extrator de eventos de calendário. A partir da mensagem do usuário, extraia as informações e retorne JSON com exatamente estes campos:
- title: string (título do evento)
- description: string (detalhes, pode ser vazio)
- date: string | null (formato YYYY-MM-DD, ou null)
- time: string | null (formato HH:MM 24h, ou null)
- duration_minutes: number (duração em minutos, padrão 60 se não mencionado)
- has_date: boolean
- has_time: boolean

Hoje é ${today}. Interprete "amanhã", "próxima segunda", "daqui a 3 dias", etc.
Retorne apenas o JSON, sem texto adicional.`,
      },
      { role: 'user', content: message },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? '{}';
  const extracted = JSON.parse(raw) as ExtractedEvent;
  return {
    title: extracted.title ?? 'Evento',
    description: extracted.description ?? '',
    date: extracted.date ?? null,
    time: extracted.time ?? null,
    duration_minutes: extracted.duration_minutes ?? 60,
    has_date: extracted.has_date ?? false,
    has_time: extracted.has_time ?? false,
  };
}

// ---------------------------------------------------------------------------
// Format functions for WhatsApp
// ---------------------------------------------------------------------------

function formatTime(date: Date): string {
  return date.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TZ,
  });
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('pt-BR', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    timeZone: TZ,
  });
}

export function formatEventsForWhatsApp(events: CalendarEvent[], accountCount: number): string {
  if (events.length === 0) return '📭 Nenhum evento hoje.';

  const lines = [`📅 *Agenda de hoje — ${events.length} evento(s):*`, ''];
  for (const e of events) {
    lines.push(`📌 *${e.title}*`);
    if (e.allDay) {
      lines.push(`   🗓️ Dia inteiro`);
    } else {
      lines.push(`   🕐 ${formatTime(e.start)} – ${formatTime(e.end)}`);
    }
    if (e.location) lines.push(`   📍 ${e.location}`);
    if (accountCount > 1) lines.push(`   📧 ${e.accountEmail}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function formatEventCreatedConfirmation(event: CalendarEvent): string {
  const lines = ['✅ *Evento criado no Google Agenda!*', `📌 *${event.title}*`];
  if (!event.allDay) {
    lines.push(`🕐 ${formatDate(event.start)} às ${formatTime(event.start)}`);
    lines.push(`⏱️ Até ${formatTime(event.end)}`);
  } else {
    lines.push(`🗓️ ${formatDate(event.start)} — dia inteiro`);
  }
  if (event.location) lines.push(`📍 ${event.location}`);
  return lines.join('\n');
}

export function formatCalendarReminder(event: CalendarEvent, minutesAhead: number): string {
  const lines = [
    `⏰ *Lembrete de agenda!*`,
    `📌 *${event.title}*`,
    `🕐 Em ${minutesAhead} minutos — ${formatTime(event.start)}`,
  ];
  if (event.location) lines.push(`📍 ${event.location}`);
  lines.push(`📧 ${event.accountEmail}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Router entry points
// ---------------------------------------------------------------------------

const NO_ACCOUNTS_MSG =
  '⚠️ Nenhuma conta Google vinculada.\n\nAcesse pelo navegador para conectar:\n`https://<seu-dominio>/auth/google`';

export async function listTodayEventsForPhone(_phone: string): Promise<string> {
  const accounts = getEnabledGoogleAccounts();
  if (accounts.length === 0) return NO_ACCOUNTS_MSG;

  const allEvents: CalendarEvent[] = [];
  for (const account of accounts) {
    try {
      const events = await listTodayEvents(account);
      allEvents.push(...events);
    } catch (err) {
      console.error(`[calendar] Error fetching events for ${account.email}:`, (err as Error).message);
    }
  }

  // Sort by start time
  allEvents.sort((a, b) => a.start.getTime() - b.start.getTime());
  return formatEventsForWhatsApp(allEvents, accounts.length);
}

export async function createEventForPhone(_phone: string, message: string): Promise<string> {
  const accounts = getEnabledGoogleAccounts();
  if (accounts.length === 0) return NO_ACCOUNTS_MSG;

  const account = accounts[0]; // use primary (first) account

  let extracted: ExtractedEvent;
  try {
    extracted = await extractEventFromMessage(message);
  } catch {
    return '⚠️ Não consegui entender os detalhes do evento. Tente: "agendar reunião amanhã às 14h"';
  }

  if (!extracted.has_date) {
    return '📅 Por favor informe a *data* do evento.\nEx: "agendar reunião amanhã às 14h"';
  }
  if (!extracted.has_time) {
    return '🕐 Por favor informe o *horário* do evento.\nEx: "agendar reunião amanhã às 14h"';
  }

  // Build Date objects in BRT
  const startLocal = new Date(`${extracted.date}T${extracted.time}:00`);
  const endLocal = new Date(startLocal.getTime() + extracted.duration_minutes * 60_000);

  try {
    const event = await createEvent(account, {
      title: extracted.title,
      description: extracted.description,
      startDateTime: startLocal,
      endDateTime: endLocal,
    });
    return formatEventCreatedConfirmation(event);
  } catch (err) {
    console.error('[calendar] Error creating event:', (err as Error).message);
    return '⚠️ Erro ao criar o evento no Google Agenda. Verifique se a conta está vinculada corretamente.';
  }
}

// ---------------------------------------------------------------------------
// Cron job helper — used by jobs.ts
// ---------------------------------------------------------------------------

export async function checkAndSendCalendarReminders(
  notifyPhones: string[],
  sendFn: (phone: string, message: string) => Promise<void>,
): Promise<void> {
  const accounts = getEnabledGoogleAccounts();
  if (accounts.length === 0) return;

  for (const account of accounts) {
    let events: CalendarEvent[];
    try {
      events = await listUpcomingEvents(account, 15);
    } catch (err) {
      console.error(`[calendar] Reminder check error for ${account.email}:`, (err as Error).message);
      continue;
    }

    for (const event of events) {
      if (isCalendarEventNotified(event.id, account.id)) continue;

      const minutesAhead = Math.round((event.start.getTime() - Date.now()) / 60_000);
      const message = formatCalendarReminder(event, minutesAhead);

      for (const phone of notifyPhones) {
        try {
          await sendFn(phone.replace('whatsapp:', ''), message);
        } catch (err) {
          console.error(`[calendar] Failed to send reminder to ${phone}:`, (err as Error).message);
        }
      }

      markCalendarEventNotified(event.id, account.id);
      console.log(`[calendar] Reminder sent for event "${event.title}" (${account.email})`);
    }
  }
}
