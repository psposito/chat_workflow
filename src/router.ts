import { chat } from './modules/chat';
import { extractAndSaveTask, listTasks } from './modules/tasks';
import { runSeoRadar } from './modules/seoRadar';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .trim();
}

function matchesAny(text: string, keywords: string[]): boolean {
  return keywords.some((kw) => text.includes(kw));
}

function buildHelpText(): string {
  return [
    '🤖 *Comandos disponíveis:*',
    '',
    '📋 *Tarefas*',
    '  • _minhas tarefas_ — lista suas tarefas pendentes',
    '  • _lembrete: reunião amanhã às 14h_ — salva uma tarefa',
    '',
    '📡 *SEO*',
    '  • _seo_, _novidades_ ou _radar_ — digest de notícias de SEO',
    '',
    '🕐 *Data e hora*',
    '  • _que horas_, _que dia_ ou _data_ — data e hora atual',
    '',
    '💬 *Chat livre*',
    '  • Qualquer outra mensagem inicia uma conversa com IA',
    '',
    'Dúvidas? É só perguntar! 😊',
  ].join('\n');
}

function buildDateTimeText(): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString('pt-BR', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'America/Sao_Paulo',
  });
  const timeStr = now.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  });
  return `🗓️ *${dateStr}*\n🕐 *${timeStr}* (horário de Brasília)`;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function router(phone: string, message: string): Promise<string> {
  const n = normalize(message);

  // Help
  if (matchesAny(n, ['ajuda', 'help', '/ajuda', '/help'])) {
    return buildHelpText();
  }

  // Date / time
  if (matchesAny(n, ['que horas', 'que dia', 'data', 'hora', 'horario'])) {
    return buildDateTimeText();
  }

  // SEO radar
  if (matchesAny(n, ['seo', 'novidades', 'radar'])) {
    return runSeoRadar();
  }

  // List tasks
  if (matchesAny(n, ['minhas tarefas', 'listar tarefas', 'ver tarefas', 'lista de tarefas'])) {
    return listTasks(phone);
  }

  // Save task — triggered by task-related keywords or time patterns (e.g. "14h", "14:00")
  const hasTaskKeyword = matchesAny(n, ['tarefa', 'lembrete', 'amanha', 'agendar', 'agenda']);
  const hasTimePattern = /\b\d{1,2}[h:]\d{0,2}\b/.test(n);

  if (hasTaskKeyword || hasTimePattern) {
    return extractAndSaveTask(phone, message);
  }

  // Fallback: free chat with memory
  return chat(phone, message);
}
