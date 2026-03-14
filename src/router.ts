import { chat } from './modules/chat';
import { extractAndSaveTask, listTasks, removeTask, removeAllTasks } from './modules/tasks';
import { runSeoRadar } from './modules/seoRadar';
import {
  fetchNewImportantEmails,
  formatEmailsForWhatsApp,
  persistNotificationBatch,
  recordEmailFeedback,
} from './modules/gmail';
import {
  listTodayEventsForPhone,
  createEventForPhone,
  completePendingCalendarEvent,
  completePendingCalendarInfo,
  listLinkedAccounts,
} from './modules/googleCalendar';

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

  // Pending calendar_missing_info — must be checked BEFORE task/time-pattern handlers
  // so a reply like "hoje às 14h" isn't mistaken for a new task
  {
    const { getPendingAction: pa } = await import('./db/database');
    const pend = pa(phone);
    if (pend?.action_type === 'calendar_missing_info') {
      const result = await completePendingCalendarInfo(phone, message);
      if (result) return result;
    }
  }

  // Pending action: account selection for calendar event ("conta 1", "2", etc.)
  const contaMatch = n.match(/^(?:conta\s+)?(\d+)$/);
  if (contaMatch) {
    const { getPendingAction } = await import('./db/database');
    const pending = getPendingAction(phone);
    if (pending?.action_type === 'create_calendar_event') {
      return completePendingCalendarEvent(phone, parseInt(contaMatch[1], 10) - 1);
    }
  }

  // Linked accounts list
  if (matchesAny(n, ['minhas contas', 'contas vinculadas', 'contas google', 'quais contas'])) {
    return listLinkedAccounts(phone);
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

  // Gmail feedback — 4 categories with or without email index
  // Patterns: "urgente 1", "importante 2", "baixa prioridade 3", "não importante 1"
  // Also: "1 é urgente", "2 é importante", etc.
  const urgenteMatch = n.match(/^urgente\s+(\d+)$|^(?:email\s+)?(\d+)\s+(?:e|é)\s+urgente$/);
  const importanteMatch = n.match(/^importante\s+(\d+)$|^(?:email\s+)?(\d+)\s+(?:e|é)\s+importante$/);
  const baixaMatch = n.match(/^baixa\s+prioridade\s+(\d+)$|^(?:email\s+)?(\d+)\s+(?:e|é)\s+baixa\s+prioridade$/);
  const naoImportanteMatch = n.match(/^n[aã]o\s+importante\s+(\d+)$|^(?:email\s+)?(\d+)\s+n[aã]o\s+(?:e|é)\s+importante$/);

  if (urgenteMatch) return recordEmailFeedback(phone, parseInt(urgenteMatch[1] ?? urgenteMatch[2], 10), 'urgente');
  if (importanteMatch) return recordEmailFeedback(phone, parseInt(importanteMatch[1] ?? importanteMatch[2], 10), 'importante');
  if (baixaMatch) return recordEmailFeedback(phone, parseInt(baixaMatch[1] ?? baixaMatch[2], 10), 'baixa_prioridade');
  if (naoImportanteMatch) return recordEmailFeedback(phone, parseInt(naoImportanteMatch[1] ?? naoImportanteMatch[2], 10), 'nao_importante');

  // Simple form without number — assumes index 1 (single-email batch)
  if (n === 'urgente') return recordEmailFeedback(phone, 1, 'urgente');
  if (n === 'importante') return recordEmailFeedback(phone, 1, 'importante');
  if (n === 'baixa prioridade') return recordEmailFeedback(phone, 1, 'baixa_prioridade');
  if (n === 'não importante' || n === 'nao importante') return recordEmailFeedback(phone, 1, 'nao_importante');

  // Gmail check on demand
  if (matchesAny(n, ['meus emails', 'meu email', 'checar email', 'verificar email', 'emails novos', 'novos emails'])) {
    const { emails } = await fetchNewImportantEmails();
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
