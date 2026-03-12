import OpenAI from 'openai';
import { saveTask, listPendingTasks, deleteTask, deleteAllTasks, Task } from '../db/database';

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
  date: string | null;   // YYYY-MM-DD or null
  time: string | null;   // HH:MM or null
  has_date: boolean;
  has_time: boolean;
}

// ---------------------------------------------------------------------------
// extractAndSaveTask
// ---------------------------------------------------------------------------

export async function extractAndSaveTask(
  phone: string,
  message: string,
): Promise<string> {
  const completion = await getOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `Você é um extrator de tarefas. A partir da mensagem do usuário, extraia as informações da tarefa e retorne um JSON com exatamente estes campos:
- title: string (título curto da tarefa)
- description: string (descrição detalhada, pode ser vazia)
- date: string | null (data no formato YYYY-MM-DD, ou null se não mencionada)
- time: string | null (horário no formato HH:MM, ou null se não mencionado)
- has_date: boolean
- has_time: boolean

Considere a data de hoje como ${new Date().toISOString().slice(0, 10)}.
Interprete expressões como "amanhã", "segunda-feira", "próxima semana", etc.
Retorne apenas o JSON, sem texto adicional.`,
      },
      { role: 'user', content: message },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? '{}';
  const extracted: ExtractedTask = JSON.parse(raw);

  const task = saveTask(
    phone,
    extracted.title,
    extracted.description,
    extracted.has_date ? (extracted.date ?? undefined) : undefined,
    extracted.has_time ? (extracted.time ?? undefined) : undefined,
  );

  return buildConfirmation(task);
}

function buildConfirmation(task: Task): string {
  const lines: string[] = [`✅ *Tarefa salva!*`, `📌 *${task.title}*`];

  if (task.description) {
    lines.push(`📝 ${task.description}`);
  }

  if (task.due_date) {
    const [year, month, day] = task.due_date.split('-');
    lines.push(`📅 Data: ${day}/${month}/${year}`);
  }

  if (task.due_time) {
    lines.push(`🕐 Horário: ${task.due_time}`);
  }

  lines.push(`\nUse *listar tarefas* para ver seus lembretes.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// removeTask / removeAllTasks
// ---------------------------------------------------------------------------

export function removeTask(phone: string, id: number): string {
  const removed = deleteTask(phone, id);
  if (removed) return `✅ Tarefa #${id} excluída com sucesso.`;
  return `⚠️ Tarefa #${id} não encontrada ou não pertence a você.`;
}

export function removeAllTasks(phone: string): string {
  const count = deleteAllTasks(phone);
  if (count === 0) return '📭 Você não tem tarefas pendentes para excluir.';
  return `🗑️ ${count} tarefa(s) excluída(s) com sucesso.`;
}

// ---------------------------------------------------------------------------
// listTasks
// ---------------------------------------------------------------------------

export function listTasks(phone: string): string {
  const tasks = listPendingTasks(phone);

  if (tasks.length === 0) {
    return '📭 Você não tem tarefas pendentes.';
  }

  const lines: string[] = [`📋 *Suas tarefas pendentes (${tasks.length}):*`, ''];

  tasks.forEach((task, index) => {
    lines.push(`*${index + 1}. ${task.title}*`);

    if (task.description) {
      lines.push(`   📝 ${task.description}`);
    }

    const datePart = task.due_date
      ? `📅 ${task.due_date.split('-').reverse().join('/')}`
      : null;
    const timePart = task.due_time ? `🕐 ${task.due_time}` : null;

    if (datePart || timePart) {
      lines.push(`   ${[datePart, timePart].filter(Boolean).join('  ')}`);
    }

    lines.push('');
  });

  return lines.join('\n').trimEnd();
}
