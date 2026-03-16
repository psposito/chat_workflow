import { chat } from './modules/chat';
import { extractAndSaveTask, listTasks, removeTask, removeAllTasks, completeTaskByIndex, postponeTaskByIndex } from './modules/tasks';
import { runSeoRadar } from './modules/seoRadar';
import {
  fetchNewImportantEmails,
  formatEmailsForWhatsApp,
  persistNotificationBatch,
  recordEmailFeedback,
  getEmailStatusPanel,
} from './modules/gmail';
import {
  listTodayEventsForPhone,
  listEventsForRangeForPhone,
  createEventForPhone,
  completePendingCalendarEvent,
  completePendingCalendarInfo,
  confirmPendingCalendarEvent,
  cancelPendingCalendarEvent,
  listLinkedAccounts,
} from './modules/googleCalendar';
import { buildMeuDia } from './modules/myDay';
import { handlePreferencesCommand, showPreferences } from './modules/userPreferences';
import { classifyIntent } from './modules/intentClassifier';
import { logMetric } from './db/database';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
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
    '  • _concluir tarefa 2_ — marca a tarefa como concluída',
    '  • _adiar tarefa 2 para amanhã_ — adia a tarefa',
    '  • _excluir todas as tarefas_ — apaga todas as tarefas pendentes',
    '',
    '📅 *Agenda (Google Calendar)*',
    '  • _minha agenda_ — ver eventos de hoje',
    '  • _agenda amanhã_ / _agenda semana_ — ver outros dias',
    '  • _agendar reunião amanhã às 14h_ — criar evento no Google Agenda',
    '',
    '☀️ *Resumo do dia*',
    '  • _meu dia_ — agenda + tarefas + emails juntos',
    '',
    '📧 *Gmail*',
    '  • _meus emails_ — verifica e-mails importantes não lidos',
    '  • _status email_ — painel rápido de e-mails',
    '  • _urgente 1_ / _importante 2_ / _não importante 3_ — classificar e-mail',
    '',
    '📡 *SEO*',
    '  • _seo_, _novidades_ ou _radar_ — digest de notícias de SEO',
    '',
    '⚙️ *Configurações*',
    '  • _minhas configurações_ — ver preferências',
    '  • _silencioso das 23h às 8h_ — horário sem notificações',
    '  • _lembrete 30 minutos antes_ — alterar aviso de calendário',
    '  • _notificar só urgente_ — filtrar notificações de e-mail',
    '',
    '📊 *Estatísticas*',
    '  • _stats_ / _estatísticas_ — uso dos últimos 7 dias',
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
  const start = Date.now();
  let module = 'router';

  try {
    const result = await routeMessage(phone, message);
    logMetric(phone, module, 'route', Date.now() - start, true);
    return result;
  } catch (err) {
    logMetric(phone, module, 'route', Date.now() - start, false, (err as Error).message);
    throw err;
  }
}

async function routeMessage(phone: string, message: string): Promise<string> {
  const n = normalize(message);

  // ── 1. Help ──────────────────────────────────────────────────────────────
  if (matchesAny(n, ['ajuda', 'help', '/ajuda', '/help'])) {
    return buildHelpText();
  }

  // ── 2. Date / time ───────────────────────────────────────────────────────
  if (matchesAny(n, ['que horas', 'que dia', 'data', 'hora', 'horario'])) {
    return buildDateTimeText();
  }

  // ── 3. Pending actions (multi-step flows — highest priority) ─────────────
  {
    const { getPendingAction, clearPendingAction } = await import('./db/database');
    const pending = getPendingAction(phone);

    if (pending?.action_type === 'calendar_missing_info') {
      const result = await completePendingCalendarInfo(phone, message);
      if (result) return result;
    }

    if (pending?.action_type === 'confirm_calendar_event') {
      if (matchesAny(n, ['sim', 'confirmar', 'confirma', 'ok', 'pode', 'cria', 'criar', 's'])) {
        return confirmPendingCalendarEvent(phone);
      }
      if (matchesAny(n, ['nao', 'não', 'cancelar', 'cancela', 'n'])) {
        return cancelPendingCalendarEvent(phone);
      }
      // Any other message while awaiting confirmation → treat as edit/new info
      const result = await completePendingCalendarInfo(phone, message);
      if (result) return result;
    }

    if (pending?.action_type === 'create_calendar_event') {
      const contaMatch = n.match(/^(?:conta\s+)?(\d+)$/);
      if (contaMatch) {
        return completePendingCalendarEvent(phone, parseInt(contaMatch[1], 10) - 1);
      }
    }
  }

  // ── 4. Number-only reply (account selection) ─────────────────────────────
  const contaMatch = n.match(/^(?:conta\s+)?(\d+)$/);
  if (contaMatch) {
    const { getPendingAction } = await import('./db/database');
    const pending = getPendingAction(phone);
    if (pending?.action_type === 'create_calendar_event') {
      return completePendingCalendarEvent(phone, parseInt(contaMatch[1], 10) - 1);
    }
  }

  // ── 5. Linked accounts ───────────────────────────────────────────────────
  if (matchesAny(n, ['minhas contas', 'contas vinculadas', 'contas google', 'quais contas'])) {
    return listLinkedAccounts(phone);
  }

  // ── 6. Calendar — list (today / tomorrow / week / day-of-week) ───────────
  if (matchesAny(n, ['minha agenda', 'agenda hoje', 'eventos hoje', 'meus eventos', 'agenda do dia'])) {
    return listTodayEventsForPhone(phone);
  }
  if (matchesAny(n, ['agenda amanha', 'eventos amanha', 'compromissos amanha'])) {
    return listEventsForRangeForPhone(phone, 1, 1);
  }
  if (matchesAny(n, ['agenda semana', 'minha semana', 'proximos eventos', 'agenda proximos dias'])) {
    return listEventsForRangeForPhone(phone, 0, 6);
  }

  // ── 7. Calendar — create ─────────────────────────────────────────────────
  const hasCalendarKeyword = matchesAny(n, ['reuniao', 'evento', 'encontro', 'call', 'meeting', 'calendario', 'google agenda', 'google calendar']);
  const hasScheduleKeyword = matchesAny(n, ['agendar', 'marcar', 'criar evento', 'novo evento']);
  const hasTimePatternEarly = /\b\d{1,2}[h:]\d{0,2}\b/.test(n);
  if (hasCalendarKeyword && (hasScheduleKeyword || hasTimePatternEarly)) {
    return createEventForPhone(phone, message);
  }

  // ── 8. Meu dia ───────────────────────────────────────────────────────────
  if (matchesAny(n, ['meu dia', 'como ta meu dia', 'resumo do dia', 'overview do dia', 'visao geral'])) {
    return buildMeuDia(phone);
  }

  // ── 9. Stats ─────────────────────────────────────────────────────────────
  if (matchesAny(n, ['stats', 'estatisticas', 'metricas', 'como ta indo', 'uso do bot'])) {
    const { getMetricStats } = await import('./db/database');
    const stats = getMetricStats(phone);
    const lines = [
      `📊 *Estatísticas (últimos 7 dias):*`,
      `💬 Interações: ${stats.total}`,
      `✅ Taxa de sucesso: ${stats.successRate}%`,
      `⏱ Latência média: ${stats.avgLatencyMs}ms`,
    ];
    if (stats.topModules.length) {
      lines.push('', '🧠 *Módulos mais usados:*');
      stats.topModules.forEach((m) => lines.push(`  • ${m.module}: ${m.count}x`));
    }
    if (stats.errors.length) {
      lines.push('', '❌ *Erros recorrentes:*');
      stats.errors.forEach((e) => lines.push(`  • ${e.message.slice(0, 60)} (${e.count}x)`));
    }
    return lines.join('\n');
  }

  // ── 10. Gmail feedback ───────────────────────────────────────────────────
  const urgenteMatch = n.match(/^urgente\s+(\d+)$|^(?:email\s+)?(\d+)\s+(?:e|é)\s+urgente$/);
  const importanteMatch = n.match(/^importante\s+(\d+)$|^(?:email\s+)?(\d+)\s+(?:e|é)\s+importante$/);
  const baixaMatch = n.match(/^baixa\s+prioridade\s+(\d+)$|^(?:email\s+)?(\d+)\s+(?:e|é)\s+baixa\s+prioridade$/);
  const naoImportanteMatch = n.match(/^n[aã]o\s+importante\s+(\d+)$|^(?:email\s+)?(\d+)\s+n[aã]o\s+(?:e|é)\s+importante$/);

  if (urgenteMatch) return recordEmailFeedback(phone, parseInt(urgenteMatch[1] ?? urgenteMatch[2], 10), 'urgente');
  if (importanteMatch) return recordEmailFeedback(phone, parseInt(importanteMatch[1] ?? importanteMatch[2], 10), 'importante');
  if (baixaMatch) return recordEmailFeedback(phone, parseInt(baixaMatch[1] ?? baixaMatch[2], 10), 'baixa_prioridade');
  if (naoImportanteMatch) return recordEmailFeedback(phone, parseInt(naoImportanteMatch[1] ?? naoImportanteMatch[2], 10), 'nao_importante');

  if (n === 'urgente') return recordEmailFeedback(phone, 1, 'urgente');
  if (n === 'importante') return recordEmailFeedback(phone, 1, 'importante');
  if (n === 'baixa prioridade') return recordEmailFeedback(phone, 1, 'baixa_prioridade');
  if (n === 'não importante' || n === 'nao importante') return recordEmailFeedback(phone, 1, 'nao_importante');

  // ── 11. Gmail check on demand ─────────────────────────────────────────────
  if (matchesAny(n, ['meus emails', 'meu email', 'checar email', 'verificar email', 'emails novos', 'novos emails'])) {
    const { emails } = await fetchNewImportantEmails();
    if (emails.length > 0) persistNotificationBatch(phone, emails);
    return formatEmailsForWhatsApp(emails);
  }
  if (matchesAny(n, ['status email', 'painel email', 'como ta meu email'])) {
    return getEmailStatusPanel(phone);
  }

  // ── 12. SEO radar ─────────────────────────────────────────────────────────
  if (matchesAny(n, ['seo', 'novidades', 'radar'])) {
    return runSeoRadar();
  }

  // ── 13. Tasks — list ──────────────────────────────────────────────────────
  if (matchesAny(n, ['minhas tarefas', 'listar tarefas', 'ver tarefas', 'lista de tarefas', 'tarefas pendentes'])) {
    return listTasks(phone);
  }

  // ── 14. Tasks — delete all ────────────────────────────────────────────────
  if (matchesAny(n, ['excluir todas', 'apagar todas', 'deletar todas', 'limpar tarefas', 'remover todas'])) {
    return removeAllTasks(phone);
  }

  // ── 15. Tasks — complete ──────────────────────────────────────────────────
  const completeMatch = n.match(/(?:concluir|completar|feita?|pronta?|marcar como (?:feita?|concluida?))\s+(?:tarefa\s+)?#?(\d+)/);
  if (completeMatch) {
    return completeTaskByIndex(phone, parseInt(completeMatch[1], 10));
  }

  // ── 16. Tasks — postpone ──────────────────────────────────────────────────
  const postponeMatch = n.match(/(?:adiar|remarcar|mover)\s+(?:tarefa\s+)?#?(\d+)/);
  if (postponeMatch) {
    return postponeTaskByIndex(phone, parseInt(postponeMatch[1], 10), message);
  }

  // ── 17. Tasks — delete specific ───────────────────────────────────────────
  const deleteMatch = n.match(/(?:excluir|apagar|deletar|remover)\s+(?:tarefa\s+)?#?(\d+)/);
  if (deleteMatch) {
    return removeTask(phone, parseInt(deleteMatch[1], 10));
  }

  // ── 18. Preferences ───────────────────────────────────────────────────────
  if (matchesAny(n, ['minhas configuracoes', 'minha configuracao', 'minhas prefs', 'configuracoes'])) {
    return showPreferences(phone);
  }
  const prefResult = await handlePreferencesCommand(phone, n, message);
  if (prefResult) return prefResult;

  // ── 19. Tasks — save (keyword or time pattern) ────────────────────────────
  const hasTaskKeyword = matchesAny(n, ['tarefa', 'lembrete', 'amanha', 'agendar', 'agenda']);
  const hasTimePattern = /\b\d{1,2}[h:]\d{0,2}\b/.test(n);
  if (hasTaskKeyword || hasTimePattern) {
    return extractAndSaveTask(phone, message);
  }

  // ── 20. Intent classifier fallback (GPT) ─────────────────────────────────
  try {
    const intent = await classifyIntent(message);
    if (intent.confidence >= 0.65) {
      switch (intent.intent) {
        case 'help':            return buildHelpText();
        case 'datetime':        return buildDateTimeText();
        case 'calendar_list':   return listTodayEventsForPhone(phone);
        case 'calendar_create': return createEventForPhone(phone, message);
        case 'email_list': {
          const { emails } = await fetchNewImportantEmails();
          if (emails.length > 0) persistNotificationBatch(phone, emails);
          return formatEmailsForWhatsApp(emails);
        }
        case 'tasks_list':     return listTasks(phone);
        case 'tasks_create':   return extractAndSaveTask(phone, message);
        case 'tasks_delete': {
          const idxStr = String(intent.params?.index ?? '');
          const idx = parseInt(idxStr, 10);
          if (idx > 0) return removeTask(phone, idx);
          return '⚠️ Qual número da tarefa você quer excluir? Use _minhas tarefas_ para ver a lista.';
        }
        case 'tasks_complete': {
          const idxStr = String(intent.params?.index ?? '');
          const idx = parseInt(idxStr, 10);
          if (idx > 0) return completeTaskByIndex(phone, idx);
          return '⚠️ Qual número da tarefa você concluiu? Use _minhas tarefas_ para ver a lista.';
        }
        case 'tasks_postpone': {
          const idxStr = String(intent.params?.index ?? '');
          const idx = parseInt(idxStr, 10);
          if (idx > 0) return postponeTaskByIndex(phone, idx, message);
          return '⚠️ Qual número da tarefa você quer adiar? Use _minhas tarefas_ para ver a lista.';
        }
        case 'seo':           return runSeoRadar();
        case 'meu_dia':       return buildMeuDia(phone);
        case 'accounts_list': return listLinkedAccounts(phone);
        case 'preferences':   return showPreferences(phone);
        // 'chat' and others fall through to chat()
      }
    }
  } catch {
    // Intent classifier failure is non-fatal — fall through to chat
  }

  // ── 21. Fallback: free chat with memory ───────────────────────────────────
  return chat(phone, message);
}
