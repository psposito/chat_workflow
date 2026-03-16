import OpenAI from 'openai';
import {
  saveTask, listPendingTasks, deleteTask, deleteAllTasks,
  completeTask, postponeTask, updateTaskPriority, spawnNextRecurrence,
  Task, TaskPriority, TaskCategory, TaskRecurrence,
} from '../db/database';
import { withRetry } from '../utils/retry';

const TZ = 'America/Sao_Paulo';

let openai: OpenAI;
function getOpenAI(): OpenAI {
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExtractedTask {
  title: string;
  description: string;
  date: string | null;
  time: string | null;
  has_date: boolean;
  has_time: boolean;
  priority: TaskPriority;
  category: TaskCategory;
  recurrence: TaskRecurrence | null;
  recurrence_end: string | null;
}

interface ExtractedPostpone {
  new_date: string | null;   // YYYY-MM-DD
  new_time: string | null;   // HH:MM
  has_date: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PRIORITY_ICON: Record<TaskPriority, string> = {
  alta: '🔴',
  media: '🟡',
  baixa: '🟢',
};

function formatDate(date: string): string {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}

function todayBRT(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

// ---------------------------------------------------------------------------
// extractAndSaveTask
// ---------------------------------------------------------------------------

export async function extractAndSaveTask(phone: string, message: string): Promise<string> {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });

  let extracted: ExtractedTask;
  try {
    const completion = await withRetry(() =>
      getOpenAI().chat.completions.create({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `Você é um extrator de tarefas. A partir da mensagem do usuário, extraia as informações e retorne JSON com exatamente estes campos:
- title: string (título curto da tarefa)
- description: string (detalhes, pode ser vazia)
- date: string | null (formato YYYY-MM-DD, ou null)
- time: string | null (formato HH:MM 24h, ou null)
- has_date: boolean
- has_time: boolean
- priority: "alta" | "media" | "baixa" (infira do contexto; reunião com cliente = alta, lembrete genérico = media)
- category: "trabalho" | "pessoal" | "saude" | "financeiro" | "geral"
- recurrence: "daily" | "weekly" | "monthly" | "weekdays" | null (null se não for recorrente)
- recurrence_end: string | null (data final da recorrência YYYY-MM-DD, ou null)

Hoje é ${today}. Interprete "amanhã", "próxima segunda", "todo dia", "toda semana", etc.
Retorne apenas o JSON, sem texto adicional.`,
          },
          { role: 'user', content: message.slice(0, 1000) },
        ],
      }),
    );

    const raw = completion.choices[0]?.message?.content ?? '{}';
    extracted = JSON.parse(raw) as ExtractedTask;
  } catch (err) {
    console.error('[tasks] extractAndSaveTask error:', (err as Error).message);
    return '⚠️ Não consegui entender a tarefa. Tente: "lembrete: reunião amanhã às 14h"';
  }

  const rawTime = extracted.has_time ? (extracted.time ?? undefined) : undefined;
  const dueTime = rawTime ? rawTime.padStart(5, '0') : undefined;

  const task = saveTask(
    phone,
    extracted.title || 'Tarefa',
    extracted.description || '',
    extracted.has_date ? (extracted.date ?? undefined) : undefined,
    dueTime,
    extracted.priority ?? 'media',
    extracted.category ?? 'geral',
    extracted.recurrence ?? undefined,
    extracted.recurrence_end ?? undefined,
  );

  return buildConfirmation(task);
}

function buildConfirmation(task: Task): string {
  const icon = PRIORITY_ICON[task.priority] ?? '🟡';
  const lines: string[] = [`✅ *Tarefa salva!*`, `${icon} *${task.title}*`];

  if (task.description) lines.push(`📝 ${task.description}`);
  if (task.due_date) lines.push(`📅 Data: ${formatDate(task.due_date)}`);
  if (task.due_time) lines.push(`🕐 Horário: ${task.due_time}`);
  if (task.priority !== 'media') lines.push(`⚡ Prioridade: ${task.priority}`);
  if (task.category !== 'geral') lines.push(`🏷 Categoria: ${task.category}`);
  if (task.recurrence) lines.push(`🔄 Recorrência: ${task.recurrence}`);

  lines.push(`\nUse *minhas tarefas* para ver seus lembretes.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// listTasks — organised by overdue / today / future
// ---------------------------------------------------------------------------

export function listTasks(phone: string): string {
  const tasks = listPendingTasks(phone);
  if (tasks.length === 0) return '📭 Você não tem tarefas pendentes.';

  const today = todayBRT();

  const overdue: Task[] = [];
  const todayTasks: Task[] = [];
  const future: Map<string, Task[]> = new Map();
  const noDue: Task[] = [];

  for (const task of tasks) {
    if (!task.due_date) {
      noDue.push(task);
    } else if (task.due_date < today) {
      overdue.push(task);
    } else if (task.due_date === today) {
      todayTasks.push(task);
    } else {
      const list = future.get(task.due_date) ?? [];
      list.push(task);
      future.set(task.due_date, list);
    }
  }

  // Sort today by priority (alta → media → baixa) then by time
  const priorityOrder: Record<TaskPriority, number> = { alta: 0, media: 1, baixa: 2 };
  todayTasks.sort((a, b) =>
    priorityOrder[a.priority] - priorityOrder[b.priority] ||
    (a.due_time ?? '99:99').localeCompare(b.due_time ?? '99:99'),
  );

  const lines: string[] = [`📋 *Suas tarefas (${tasks.length}):*`];
  let idx = 1;

  function addTask(task: Task): void {
    const icon = PRIORITY_ICON[task.priority] ?? '🟡';
    const timePart = task.due_time ? ` — ${task.due_time}` : '';
    const recPart = task.recurrence ? ` 🔄` : '';
    lines.push(`*${idx}.* ${icon} ${task.title}${timePart}${recPart}`);
    if (task.description) lines.push(`   📝 ${task.description}`);
    idx++;
  }

  if (overdue.length > 0) {
    lines.push('', '⚠️ *ATRASADAS:*');
    for (const t of overdue) {
      const icon = PRIORITY_ICON[t.priority] ?? '🟡';
      const datePart = t.due_date ? ` (era ${formatDate(t.due_date)})` : '';
      lines.push(`*${idx}.* ${icon} ${t.title}${datePart}`);
      idx++;
    }
  }

  if (todayTasks.length > 0) {
    const todayStr = new Date(`${today}T12:00:00`).toLocaleDateString('pt-BR', {
      weekday: 'short', day: '2-digit', month: '2-digit', timeZone: TZ,
    });
    lines.push('', `📅 *HOJE (${todayStr}):*`);
    for (const t of todayTasks) addTask(t);
  }

  // Sort future dates
  const sortedFutureDates = Array.from(future.keys()).sort();
  for (const date of sortedFutureDates) {
    const tasksOnDate = future.get(date)!;
    const dateStr = new Date(`${date}T12:00:00`).toLocaleDateString('pt-BR', {
      weekday: 'short', day: '2-digit', month: '2-digit', timeZone: TZ,
    });
    lines.push('', `📅 *${dateStr.toUpperCase()}:*`);
    for (const t of tasksOnDate) addTask(t);
  }

  if (noDue.length > 0) {
    lines.push('', '📌 *SEM DATA:*');
    for (const t of noDue) addTask(t);
  }

  return lines.join('\n').trimEnd();
}

// ---------------------------------------------------------------------------
// removeTask / removeAllTasks
// ---------------------------------------------------------------------------

export function removeTask(phone: string, displayIndex: number): string {
  const tasks = listPendingTasks(phone);
  const task = tasks[displayIndex - 1];
  if (!task) return `⚠️ Tarefa #${displayIndex} não encontrada. Use *minhas tarefas* para ver a lista.`;
  const removed = deleteTask(phone, task.id);
  if (removed) return `✅ Tarefa #${displayIndex} "${task.title}" excluída.`;
  return `⚠️ Não foi possível excluir a tarefa #${displayIndex}.`;
}

export function removeAllTasks(phone: string): string {
  const count = deleteAllTasks(phone);
  if (count === 0) return '📭 Você não tem tarefas pendentes para excluir.';
  return `🗑️ ${count} tarefa(s) excluída(s) com sucesso.`;
}

// ---------------------------------------------------------------------------
// completeTaskByIndex
// ---------------------------------------------------------------------------

export function completeTaskByIndex(phone: string, displayIndex: number): string {
  const tasks = listPendingTasks(phone);
  const task = tasks[displayIndex - 1];
  if (!task) return `⚠️ Tarefa #${displayIndex} não encontrada. Use *minhas tarefas* para ver a lista.`;

  const ok = completeTask(phone, task.id);
  if (!ok) return `⚠️ Não foi possível concluir a tarefa #${displayIndex}.`;

  let msg = `✅ Tarefa #${displayIndex} "${task.title}" marcada como concluída!`;

  // Spawn next recurrence if applicable
  if (task.recurrence) {
    const next = spawnNextRecurrence(task);
    if (next) {
      const when = next.due_date ? ` para ${formatDate(next.due_date)}${next.due_time ? ' às ' + next.due_time : ''}` : '';
      msg += `\n🔄 Próxima ocorrência criada${when}.`;
    }
  }

  return msg;
}

// ---------------------------------------------------------------------------
// postponeTaskByIndex
// ---------------------------------------------------------------------------

export async function postponeTaskByIndex(
  phone: string,
  displayIndex: number,
  message: string,
): Promise<string> {
  const tasks = listPendingTasks(phone);
  const task = tasks[displayIndex - 1];
  if (!task) return `⚠️ Tarefa #${displayIndex} não encontrada. Use *minhas tarefas* para ver a lista.`;

  const today = todayBRT();

  let newDate: string | null = null;
  let newTime: string | null = null;

  // Quick patterns: "+N dias", "para amanhã", "para segunda"
  const plusDaysMatch = message.match(/\+(\d+)\s*dias?/i);
  if (plusDaysMatch) {
    const base = new Date(`${task.due_date ?? today}T12:00:00-03:00`);
    base.setDate(base.getDate() + parseInt(plusDaysMatch[1], 10));
    newDate = base.toLocaleDateString('en-CA', { timeZone: TZ });
  } else {
    // Use AI to extract new date/time from message
    try {
      const completion = await withRetry(() =>
        getOpenAI().chat.completions.create({
          model: 'gpt-4o-mini',
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: `Extraia a nova data/hora para adiar uma tarefa. Hoje é ${today}.
Retorne JSON: {"new_date":"YYYY-MM-DD|null","new_time":"HH:MM|null","has_date":boolean}`,
            },
            { role: 'user', content: message.slice(0, 300) },
          ],
        }),
      );
      const parsed = JSON.parse(completion.choices[0]?.message?.content ?? '{}') as ExtractedPostpone;
      if (parsed.has_date) newDate = parsed.new_date;
      newTime = parsed.new_time;
    } catch {
      return `⚠️ Não entendi a nova data. Tente: "adiar tarefa ${displayIndex} para amanhã" ou "+3 dias"`;
    }
  }

  if (!newDate) {
    return `⚠️ Não encontrei uma data na mensagem. Tente: "adiar tarefa ${displayIndex} para amanhã"`;
  }

  const ok = postponeTask(phone, task.id, newDate, newTime ?? undefined);
  if (!ok) return `⚠️ Não foi possível adiar a tarefa #${displayIndex}.`;

  const timePart = newTime ? ` às ${newTime}` : '';
  return `📅 Tarefa #${displayIndex} "${task.title}" adiada para *${formatDate(newDate)}${timePart}*.`;
}
