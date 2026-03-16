import { listPendingTasks } from '../db/database';
import { getTodayEventsRaw } from './googleCalendar';

const TZ = 'America/Sao_Paulo';

function formatTime(date: Date): string {
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
}

function todayBRT(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

function findFreeSlots(events: import('./googleCalendar').CalendarEvent[]): string[] {
  const timedEvents = events
    .filter((e) => !e.allDay)
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const today = todayBRT();
  const dayStart = new Date(`${today}T08:00:00-03:00`);
  const dayEnd = new Date(`${today}T19:00:00-03:00`);
  const minSlot = 30 * 60_000;

  const slots: string[] = [];
  let cursor = dayStart;

  for (const e of timedEvents) {
    if (e.start > cursor && e.start.getTime() - cursor.getTime() >= minSlot) {
      slots.push(`${formatTime(cursor)}–${formatTime(e.start)}`);
    }
    if (e.end > cursor) cursor = e.end;
  }
  if (dayEnd.getTime() - cursor.getTime() >= minSlot) {
    slots.push(`${formatTime(cursor)}–${formatTime(dayEnd)}`);
  }

  return slots;
}

export async function buildMeuDia(phone: string): Promise<string> {
  const today = todayBRT();
  const todayStr = new Date().toLocaleDateString('pt-BR', {
    weekday: 'long', day: '2-digit', month: 'long', timeZone: TZ,
  });

  const lines: string[] = [`☀️ *Seu dia — ${todayStr}:*`, ''];

  // Calendar events
  let events: import('./googleCalendar').CalendarEvent[] = [];
  try {
    events = await getTodayEventsRaw();
  } catch { /* non-fatal */ }

  if (events.length > 0) {
    lines.push('📅 *Agenda:*');
    for (const e of events) {
      if (e.allDay) {
        lines.push(`  • ${e.title} — dia inteiro`);
      } else {
        lines.push(`  • ${formatTime(e.start)}–${formatTime(e.end)} — ${e.title}`);
      }
    }
    lines.push('');
  } else {
    lines.push('📅 *Agenda:* Nenhum evento hoje.', '');
  }

  // Tasks due today
  const allTasks = listPendingTasks(phone);
  const todayTasks = allTasks.filter((t) => t.due_date === today);
  const overdueTasks = allTasks.filter((t) => t.due_date && t.due_date < today);

  if (overdueTasks.length > 0) {
    lines.push(`⚠️ *Tarefas atrasadas (${overdueTasks.length}):*`);
    for (const t of overdueTasks.slice(0, 3)) {
      lines.push(`  • ${t.title}`);
    }
    if (overdueTasks.length > 3) lines.push(`  ... e mais ${overdueTasks.length - 3}`);
    lines.push('');
  }

  if (todayTasks.length > 0) {
    lines.push(`📋 *Tarefas de hoje (${todayTasks.length}):*`);
    for (const t of todayTasks) {
      const timePart = t.due_time ? ` — ${t.due_time}` : '';
      const icon = t.priority === 'alta' ? '🔴' : t.priority === 'baixa' ? '🟢' : '🟡';
      lines.push(`  ${icon} ${t.title}${timePart}`);
    }
    lines.push('');
  } else if (overdueTasks.length === 0) {
    lines.push('📋 *Tarefas:* Nenhuma tarefa para hoje.', '');
  }

  // Free slots
  if (events.length > 0) {
    const freeSlots = findFreeSlots(events);
    if (freeSlots.length > 0) {
      lines.push(`💡 *Horários livres:* ${freeSlots.join(', ')}`);
    }
  }

  return lines.join('\n').trimEnd();
}
