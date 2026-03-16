import { getUserPreferences, setUserPreference, UserPreferences } from '../db/database';

// ---------------------------------------------------------------------------
// Parse preference commands from natural language
// ---------------------------------------------------------------------------

export async function handlePreferencesCommand(
  phone: string,
  normalized: string,
  _original: string,
): Promise<string | null> {

  // Silent hours: "silencioso das 23h às 8h" / "sem notificacoes das 22 as 7"
  const silentMatch = normalized.match(
    /(?:silencioso|sem notificacoes?|horario silencioso|quieto)\s+das?\s+(\d{1,2})h?\s+[àa]s?\s+(\d{1,2})h?/,
  );
  if (silentMatch) {
    const start = `${silentMatch[1].padStart(2, '0')}:00`;
    const end = `${silentMatch[2].padStart(2, '0')}:00`;
    setUserPreference(phone, 'silent_start', start);
    setUserPreference(phone, 'silent_end', end);
    return `🔕 Horário silencioso configurado: *${start}* às *${end}*\n_(e-mails urgentes sempre passam)_`;
  }

  // Calendar reminder minutes: "lembrete 30 minutos" / "aviso 15 min antes"
  const reminderMatch = normalized.match(/(?:lembrete|aviso|alerta)\s+(\d+)\s*min/);
  if (reminderMatch) {
    const mins = parseInt(reminderMatch[1], 10);
    if (mins > 0 && mins <= 120) {
      setUserPreference(phone, 'calendar_reminder_minutes', mins);
      return `⏰ Lembrete de agenda configurado para *${mins} minutos* antes.`;
    }
  }

  // Disable/enable calendar reminders
  if (normalized.includes('desativar lembrete') || normalized.includes('desligar lembrete') || normalized.includes('sem lembrete')) {
    setUserPreference(phone, 'calendar_reminder_enabled', 0);
    return '🔕 Lembretes de agenda *desativados*.';
  }
  if (normalized.includes('ativar lembrete') || normalized.includes('ligar lembrete')) {
    setUserPreference(phone, 'calendar_reminder_enabled', 1);
    return '🔔 Lembretes de agenda *ativados*.';
  }

  // Email notify categories
  if (normalized.includes('notificar so urgente') || normalized.includes('notificar apenas urgente')) {
    setUserPreference(phone, 'email_notify_categories', 'urgente');
    return '📧 Notificações de e-mail: apenas *urgentes*.';
  }
  if (normalized.includes('notificar urgente e importante') || normalized.includes('notificar todos importantes')) {
    setUserPreference(phone, 'email_notify_categories', 'urgente,importante');
    return '📧 Notificações de e-mail: *urgentes* e *importantes*.';
  }
  if (normalized.includes('notificar todos') || normalized.includes('notificar tudo')) {
    setUserPreference(phone, 'email_notify_categories', 'urgente,importante,baixa_prioridade');
    return '📧 Notificações de e-mail: *todos* (exceto irrelevantes).';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Show current preferences
// ---------------------------------------------------------------------------

export function showPreferences(phone: string): string {
  const p: UserPreferences = getUserPreferences(phone);

  const reminderStatus = p.calendar_reminder_enabled ? `${p.calendar_reminder_minutes} min antes` : 'desativado';

  const categories = p.email_notify_categories
    .split(',')
    .map((c) => c.trim())
    .join(', ');

  return [
    '⚙️ *Suas configurações:*',
    '',
    `🔕 Horário silencioso: ${p.silent_start} às ${p.silent_end}`,
    `⏰ Lembrete de agenda: ${reminderStatus}`,
    `📧 Notificar e-mails: ${categories}`,
    `📅 Limite diário de e-mails: ${p.daily_email_limit}`,
    '',
    '*Para alterar:*',
    '  • _silencioso das 23h às 8h_',
    '  • _lembrete 30 minutos_',
    '  • _notificar só urgente_',
    '  • _desativar lembretes_',
  ].join('\n');
}
