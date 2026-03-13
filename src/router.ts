import { chat } from './modules/chat';
import { extractAndSaveTask, listTasks, removeTask, removeAllTasks } from './modules/tasks';
import { runSeoRadar } from './modules/seoRadar';
import {
  fetchNewImportantEmails,
  formatEmailsForWhatsApp,
  persistNotificationBatch,
  recordEmailFeedback,
} from './modules/gmail';
import { listTodayEventsForPhone, createEventForPhone } from './modules/googleCalendar';

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
    '  • _excluir tarefa 2_ — exclui a tarefa pelo número',
    '  • _excluir todas as tarefas_ — apaga todas as tarefas pendentes',
    '',
    '📅 *Agenda (Google Calendar)*',
    '  • _minha agenda_ — ver eventos de hoje',
    '  • _agendar reunião amanhã às 14h_ — criar evento no Google Agenda',
    '',
    '📧 *Gmail*',
    '  • _meus emails_ — verifica e-mails importantes não lidos',
    '  • _importante 1_ — marca o e-mail #1 como importante (treina a IA)',
    '  • _não importante 2_ — marca o e-mail #2 como irrelevante (treina a IA)',
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

  // Calendar — list today's events
  if (matchesAny(n, ['minha agenda', 'agenda hoje', 'eventos hoje', 'meus eventos', 'agenda do dia'])) {
    return listTodayEventsForPhone(phone);
  }

  // Calendar — create event (keywords that clearly indicate a calendar event, not a task)
  const hasCalendarKeyword = matchesAny(n, ['reuniao', 'evento', 'encontro', 'call', 'meeting', 'calendario', 'google agenda', 'google calendar']);
  const hasScheduleKeyword = matchesAny(n, ['agendar', 'marcar', 'criar evento', 'novo evento']);
  const hasTimePatternEarly = /\b\d{1,2}[h:]\d{0,2}\b/.test(n);
  if (hasCalendarKeyword && (hasScheduleKeyword || hasTimePatternEarly)) {
    return createEventForPhone(phone, message);
  }

  // Gmail feedback — "importante 2" / "não importante 1"
  const importantMatch = n.match(/^(?:email\s+)?(\d+)\s+(?:e|é)\s+importante$|^importante\s+(\d+)$/);
  const notImportantMatch = n.match(/^(?:email\s+)?(\d+)\s+n[aã]o\s+(?:e|é)\s+importante$|^n[aã]o\s+importante\s+(\d+)$/);
  if (importantMatch) {
    const idx = parseInt(importantMatch[1] ?? importantMatch[2], 10);
    return recordEmailFeedback(phone, idx, 'important');
  }
  if (notImportantMatch) {
    const idx = parseInt(notImportantMatch[1] ?? notImportantMatch[2], 10);
    return recordEmailFeedback(phone, idx, 'not_important');
  }

  // Gmail check on demand
  if (matchesAny(n, ['meus emails', 'meu email', 'checar email', 'verificar email', 'emails novos', 'novos emails'])) {
    const emails = await fetchNewImportantEmails();
    if (emails.length > 0) persistNotificationBatch(phone, emails);
    return formatEmailsForWhatsApp(emails);
  }

  // SEO radar
  if (matchesAny(n, ['seo', 'novidades', 'radar'])) {
    return runSeoRadar();
  }

  // List tasks
  if (matchesAny(n, ['minhas tarefas', 'listar tarefas', 'ver tarefas', 'lista de tarefas'])) {
    return listTasks(phone);
  }

  // Delete all tasks
  if (
    matchesAny(n, ['excluir todas', 'apagar todas', 'deletar todas', 'limpar tarefas', 'remover todas'])
  ) {
    return removeAllTasks(phone);
  }

  // Delete specific task — "excluir tarefa 2", "apagar tarefa 3", etc.
  const deleteMatch = n.match(/(?:excluir|apagar|deletar|remover)\s+(?:tarefa\s+)?#?(\d+)/);
  if (deleteMatch) {
    return removeTask(phone, parseInt(deleteMatch[1], 10));
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
