import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.DB_PATH || path.resolve(process.cwd(), 'data', 'bot.db');

let db: Database.Database;

export function initDb(): Database.Database {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  db = new Database(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      phone       TEXT    NOT NULL,
      title       TEXT    NOT NULL,
      description TEXT    NOT NULL DEFAULT '',
      due_date    TEXT,
      due_time    TEXT,
      status      TEXT    NOT NULL DEFAULT 'pending'
                          CHECK(status IN ('pending', 'done')),
      notified    INTEGER NOT NULL DEFAULT 0,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversation_memory (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      phone      TEXT NOT NULL,
      role       TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content    TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS gmail_notified (
      message_id  TEXT PRIMARY KEY,
      notified_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Smart Gmail: per-email record with AI score + user feedback
    CREATE TABLE IF NOT EXISTS gmail_emails (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id   TEXT    UNIQUE NOT NULL,
      sender       TEXT    NOT NULL,
      subject      TEXT    NOT NULL,
      ai_score     REAL    NOT NULL DEFAULT 0,
      notified     INTEGER NOT NULL DEFAULT 0,
      feedback     TEXT    CHECK(feedback IN ('important', 'not_important', NULL)),
      fetched_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Learned sender reputation from user feedback
    CREATE TABLE IF NOT EXISTS sender_reputation (
      sender              TEXT PRIMARY KEY,
      important_count     INTEGER NOT NULL DEFAULT 0,
      not_important_count INTEGER NOT NULL DEFAULT 0,
      updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Maps the numbered index shown in the notification to email IDs (per phone)
    CREATE TABLE IF NOT EXISTS gmail_notification_batch (
      phone      TEXT    NOT NULL,
      idx        INTEGER NOT NULL,
      email_id   INTEGER NOT NULL REFERENCES gmail_emails(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (phone, idx)
    );

    -- Google OAuth2 tokens per linked account
    CREATE TABLE IF NOT EXISTS google_accounts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT    UNIQUE NOT NULL,
      display_name  TEXT    NOT NULL DEFAULT '',
      access_token  TEXT,
      refresh_token TEXT    NOT NULL,
      token_expiry  TEXT,
      scopes        TEXT    NOT NULL DEFAULT '',
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Deduplication: one row per calendar event that has been notified
    CREATE TABLE IF NOT EXISTS calendar_notified (
      event_id    TEXT    NOT NULL,
      account_id  INTEGER NOT NULL REFERENCES google_accounts(id),
      notified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (event_id, account_id)
    );

    -- Generic key-value state (e.g. last poll timestamps)
    CREATE TABLE IF NOT EXISTS poll_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Pending multi-step actions (e.g. calendar event awaiting account selection)
    CREATE TABLE IF NOT EXISTS pending_actions (
      phone       TEXT    PRIMARY KEY,
      action_type TEXT    NOT NULL,
      payload     TEXT    NOT NULL,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- User facts extracted from conversations (long-term memory)
    CREATE TABLE IF NOT EXISTS user_facts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      phone      TEXT    NOT NULL,
      fact       TEXT    NOT NULL,
      category   TEXT    NOT NULL DEFAULT 'general',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Per-user preferences and settings
    CREATE TABLE IF NOT EXISTS user_preferences (
      phone                      TEXT PRIMARY KEY,
      timezone                   TEXT    NOT NULL DEFAULT 'America/Sao_Paulo',
      language                   TEXT    NOT NULL DEFAULT 'pt-BR',
      silent_start               TEXT    NOT NULL DEFAULT '22:00',
      silent_end                 TEXT    NOT NULL DEFAULT '07:00',
      email_notify_categories    TEXT    NOT NULL DEFAULT 'urgente,importante',
      daily_email_limit          INTEGER NOT NULL DEFAULT 20,
      calendar_reminder_minutes  INTEGER NOT NULL DEFAULT 15,
      calendar_reminder_enabled  INTEGER NOT NULL DEFAULT 1,
      briefing_enabled           INTEGER NOT NULL DEFAULT 1,
      briefing_time              TEXT    NOT NULL DEFAULT '07:30',
      verbose_mode               INTEGER NOT NULL DEFAULT 0,
      updated_at                 DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Log of every email classification + user feedback for accuracy tracking
    CREATE TABLE IF NOT EXISTS email_feedback_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      phone         TEXT    NOT NULL,
      sender        TEXT    NOT NULL,
      subject       TEXT,
      ai_category   TEXT    NOT NULL,
      user_category TEXT    NOT NULL,
      was_correct   INTEGER NOT NULL,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Bot usage metrics per interaction
    CREATE TABLE IF NOT EXISTS bot_metrics (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      phone         TEXT    NOT NULL,
      module        TEXT    NOT NULL,
      action        TEXT    NOT NULL,
      latency_ms    INTEGER,
      success       INTEGER NOT NULL DEFAULT 1,
      error_message TEXT,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ---------------------------------------------------------------------------
  // Migrations on existing tables
  // ---------------------------------------------------------------------------

  const migrations: [string, string][] = [
    ['tasks', 'notified INTEGER NOT NULL DEFAULT 0'],
    ['tasks', 'priority TEXT NOT NULL DEFAULT \'media\''],
    ['tasks', 'category TEXT NOT NULL DEFAULT \'geral\''],
    ['tasks', 'completed_at DATETIME DEFAULT NULL'],
    ['tasks', 'recurrence TEXT DEFAULT NULL'],
    ['tasks', 'recurrence_end DATE DEFAULT NULL'],
    ['conversation_memory', 'is_summary INTEGER NOT NULL DEFAULT 0'],
  ];

  for (const [table, colDef] of migrations) {
    const colName = colDef.split(' ')[0];
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!info.some((c) => c.name === colName)) {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
        console.log(`[db] Migration: added ${table}.${colName}`);
      } catch (e) {
        console.warn(`[db] Migration skipped (${table}.${colName}):`, (e as Error).message);
      }
    }
  }

  // Migration: expand gmail_emails.feedback CHECK to 4-category system
  const gmailEmailsSchema = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='gmail_emails'")
    .get() as { sql: string } | undefined;
  if (gmailEmailsSchema?.sql && !gmailEmailsSchema.sql.includes('urgente')) {
    try {
      db.pragma('foreign_keys = OFF');
      db.exec(`
        CREATE TABLE gmail_emails_new (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id   TEXT    UNIQUE NOT NULL,
          sender       TEXT    NOT NULL,
          subject      TEXT    NOT NULL,
          ai_score     REAL    NOT NULL DEFAULT 0,
          notified     INTEGER NOT NULL DEFAULT 0,
          feedback     TEXT    CHECK(feedback IN ('urgente', 'importante', 'baixa_prioridade', 'nao_importante', 'important', 'not_important')),
          fetched_at   DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT OR IGNORE INTO gmail_emails_new SELECT * FROM gmail_emails;
        DROP TABLE gmail_emails;
        ALTER TABLE gmail_emails_new RENAME TO gmail_emails;
      `);
      db.pragma('foreign_keys = ON');
      console.log('[db] Migrated gmail_emails: feedback column now supports 4-category system');
    } catch (e) {
      db.pragma('foreign_keys = ON');
      console.warn('[db] gmail_emails migration skipped:', (e as Error).message);
    }
  }

  console.log('[db] Database initialised at', DB_PATH);
  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialised — call initDb() first');
  return db;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type TaskPriority = 'alta' | 'media' | 'baixa';
export type TaskCategory = 'trabalho' | 'pessoal' | 'saude' | 'financeiro' | 'geral';
export type TaskRecurrence = 'daily' | 'weekly' | 'monthly' | 'weekdays';

export interface Task {
  id: number;
  phone: string;
  title: string;
  description: string;
  due_date: string | null;
  due_time: string | null;
  status: 'pending' | 'done';
  priority: TaskPriority;
  category: TaskCategory;
  completed_at: string | null;
  recurrence: TaskRecurrence | null;
  recurrence_end: string | null;
  notified: 0 | 1;
  created_at: string;
}

export function saveTask(
  phone: string,
  title: string,
  description: string,
  dueDate?: string,
  dueTime?: string,
  priority: TaskPriority = 'media',
  category: TaskCategory = 'geral',
  recurrence?: TaskRecurrence,
  recurrenceEnd?: string,
): Task {
  const stmt = getDb().prepare(`
    INSERT INTO tasks (phone, title, description, due_date, due_time, priority, category, recurrence, recurrence_end)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `);
  return stmt.get(
    phone, title, description,
    dueDate ?? null, dueTime ?? null,
    priority, category,
    recurrence ?? null, recurrenceEnd ?? null,
  ) as Task;
}

export function listPendingTasks(phone: string): Task[] {
  return getDb()
    .prepare(
      `SELECT * FROM tasks
       WHERE phone = ? AND status = 'pending' AND completed_at IS NULL
       ORDER BY due_date ASC NULLS LAST, due_time ASC NULLS LAST, created_at ASC`,
    )
    .all(phone) as Task[];
}

export function getTasksDueNow(date: string, time: string): Task[] {
  return getDb()
    .prepare(
      `SELECT * FROM tasks
       WHERE due_date = ? AND due_time = ? AND status = 'pending'
         AND completed_at IS NULL AND notified = 0`,
    )
    .all(date, time) as Task[];
}

export function markTaskNotified(id: number): void {
  getDb().prepare(`UPDATE tasks SET notified = 1 WHERE id = ?`).run(id);
}

export function deleteTask(phone: string, id: number): boolean {
  const result = getDb()
    .prepare(`DELETE FROM tasks WHERE id = ? AND phone = ?`)
    .run(id, phone);
  return result.changes > 0;
}

export function completeTask(phone: string, id: number): boolean {
  const result = getDb()
    .prepare(`UPDATE tasks SET completed_at = CURRENT_TIMESTAMP, status = 'done' WHERE id = ? AND phone = ? AND completed_at IS NULL`)
    .run(id, phone);
  return result.changes > 0;
}

export function postponeTask(phone: string, id: number, newDate: string, newTime?: string): boolean {
  const result = getDb()
    .prepare(`UPDATE tasks SET due_date = ?, due_time = COALESCE(?, due_time), notified = 0 WHERE id = ? AND phone = ?`)
    .run(newDate, newTime ?? null, id, phone);
  return result.changes > 0;
}

export function updateTaskPriority(phone: string, id: number, priority: TaskPriority): boolean {
  const result = getDb()
    .prepare(`UPDATE tasks SET priority = ? WHERE id = ? AND phone = ?`)
    .run(priority, id, phone);
  return result.changes > 0;
}

export function deleteAllTasks(phone: string): number {
  const result = getDb()
    .prepare(`DELETE FROM tasks WHERE phone = ? AND status = 'pending' AND completed_at IS NULL`)
    .run(phone);
  return result.changes as number;
}

export function listTasksDueToday(): Map<string, Task[]> {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const rows = getDb()
    .prepare(
      `SELECT * FROM tasks
       WHERE due_date = ? AND status = 'pending' AND completed_at IS NULL
       ORDER BY due_time ASC NULLS LAST, created_at ASC`,
    )
    .all(today) as Task[];

  const byPhone = new Map<string, Task[]>();
  for (const task of rows) {
    const list = byPhone.get(task.phone) ?? [];
    list.push(task);
    byPhone.set(task.phone, list);
  }
  return byPhone;
}

/** Spawn the next recurrence of a task after completion */
export function spawnNextRecurrence(task: Task): Task | null {
  if (!task.recurrence || !task.due_date) return null;

  const current = new Date(`${task.due_date}T12:00:00-03:00`);
  let next: Date;

  switch (task.recurrence) {
    case 'daily':
      next = new Date(current);
      next.setDate(next.getDate() + 1);
      break;
    case 'weekly':
      next = new Date(current);
      next.setDate(next.getDate() + 7);
      break;
    case 'monthly':
      next = new Date(current);
      next.setMonth(next.getMonth() + 1);
      break;
    case 'weekdays': {
      next = new Date(current);
      do { next.setDate(next.getDate() + 1); } while (next.getDay() === 0 || next.getDay() === 6);
      break;
    }
    default:
      return null;
  }

  const nextDate = next.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  if (task.recurrence_end && nextDate > task.recurrence_end) return null;

  return saveTask(
    task.phone, task.title, task.description,
    nextDate, task.due_time ?? undefined,
    task.priority, task.category,
    task.recurrence, task.recurrence_end ?? undefined,
  );
}

// ---------------------------------------------------------------------------
// Gmail — legacy notified table (kept for backward compat)
// ---------------------------------------------------------------------------

export function isEmailNotified(messageId: string): boolean {
  const inOld = getDb()
    .prepare(`SELECT 1 FROM gmail_notified WHERE message_id = ?`)
    .get(messageId);
  if (inOld) return true;
  const inNew = getDb()
    .prepare(`SELECT 1 FROM gmail_emails WHERE message_id = ?`)
    .get(messageId);
  return !!inNew;
}

export function markEmailNotified(messageId: string): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO gmail_notified (message_id) VALUES (?)`)
    .run(messageId);
}

// ---------------------------------------------------------------------------
// Gmail — smart emails
// ---------------------------------------------------------------------------

export type EmailCategory = 'urgente' | 'importante' | 'baixa_prioridade' | 'nao_importante';
export type EmailFeedback = EmailCategory | 'important' | 'not_important';

export interface GmailEmail {
  id: number;
  message_id: string;
  sender: string;
  subject: string;
  ai_score: number;
  notified: 0 | 1;
  feedback: EmailFeedback | null;
  fetched_at: string;
}

export interface SenderReputation {
  sender: string;
  important_count: number;
  not_important_count: number;
}

export function upsertGmailEmail(
  messageId: string,
  sender: string,
  subject: string,
  aiScore: number,
): GmailEmail {
  getDb().prepare(`
    INSERT INTO gmail_emails (message_id, sender, subject, ai_score)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET ai_score = excluded.ai_score
  `).run(messageId, sender, subject, aiScore);
  return getDb()
    .prepare(`SELECT * FROM gmail_emails WHERE message_id = ?`)
    .get(messageId) as GmailEmail;
}

export function markGmailEmailNotified(id: number): void {
  getDb().prepare(`UPDATE gmail_emails SET notified = 1 WHERE id = ?`).run(id);
}

export function getSenderReputation(sender: string): SenderReputation | null {
  return getDb()
    .prepare(`SELECT * FROM sender_reputation WHERE sender = ?`)
    .get(sender) as SenderReputation | null;
}

export function updateSenderReputation(sender: string, feedback: EmailFeedback): void {
  const col =
    feedback === 'important' || feedback === 'urgente' || feedback === 'importante'
      ? 'important_count'
      : 'not_important_count';
  getDb().prepare(`
    INSERT INTO sender_reputation (sender, ${col})
    VALUES (?, 1)
    ON CONFLICT(sender) DO UPDATE SET ${col} = ${col} + 1, updated_at = CURRENT_TIMESTAMP
  `).run(sender);
}

export function setEmailFeedback(id: number, feedback: EmailFeedback): GmailEmail | null {
  getDb()
    .prepare(`UPDATE gmail_emails SET feedback = ? WHERE id = ?`)
    .run(feedback, id);
  return getDb()
    .prepare(`SELECT * FROM gmail_emails WHERE id = ?`)
    .get(id) as GmailEmail | null;
}

export function saveNotificationBatch(phone: string, entries: { idx: number; emailId: number }[]): void {
  const db = getDb();
  db.prepare(`DELETE FROM gmail_notification_batch WHERE phone = ?`).run(phone);
  const stmt = db.prepare(
    `INSERT INTO gmail_notification_batch (phone, idx, email_id) VALUES (?, ?, ?)`,
  );
  for (const { idx, emailId } of entries) {
    stmt.run(phone, idx, emailId);
  }
}

export function getEmailByBatchIndex(phone: string, idx: number): GmailEmail | null {
  return getDb().prepare(`
    SELECT e.* FROM gmail_emails e
    JOIN gmail_notification_batch b ON b.email_id = e.id
    WHERE b.phone = ? AND b.idx = ?
  `).get(phone, idx) as GmailEmail | null;
}

export function logEmailFeedback(
  phone: string,
  sender: string,
  subject: string | null,
  aiCategory: string,
  userCategory: string,
): void {
  getDb().prepare(`
    INSERT INTO email_feedback_log (phone, sender, subject, ai_category, user_category, was_correct)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(phone, sender, subject ?? null, aiCategory, userCategory, aiCategory === userCategory ? 1 : 0);
}

export function getEmailClassificationStats(phone: string): {
  total: number;
  correct: number;
  accuracy: number;
  topMistake: string | null;
} {
  const total = (getDb().prepare(`SELECT COUNT(*) as c FROM email_feedback_log WHERE phone = ?`).get(phone) as { c: number }).c;
  if (total === 0) return { total: 0, correct: 0, accuracy: 0, topMistake: null };
  const correct = (getDb().prepare(`SELECT COUNT(*) as c FROM email_feedback_log WHERE phone = ? AND was_correct = 1`).get(phone) as { c: number }).c;

  const mistake = getDb().prepare(`
    SELECT ai_category || ' → ' || user_category as pair, COUNT(*) as cnt
    FROM email_feedback_log WHERE phone = ? AND was_correct = 0
    GROUP BY pair ORDER BY cnt DESC LIMIT 1
  `).get(phone) as { pair: string; cnt: number } | undefined;

  return {
    total,
    correct,
    accuracy: Math.round((correct / total) * 100),
    topMistake: mistake ? `${mistake.pair} (${mistake.cnt}x)` : null,
  };
}

// ---------------------------------------------------------------------------
// Google accounts
// ---------------------------------------------------------------------------

export interface GoogleAccount {
  id: number;
  email: string;
  display_name: string;
  access_token: string | null;
  refresh_token: string;
  token_expiry: string | null;
  scopes: string;
  enabled: 0 | 1;
  created_at: string;
  updated_at: string;
}

export function upsertGoogleAccount(
  email: string,
  displayName: string,
  refreshToken: string,
  accessToken: string | null,
  tokenExpiry: string | null,
  scopes: string,
): GoogleAccount {
  getDb().prepare(`
    INSERT INTO google_accounts (email, display_name, refresh_token, access_token, token_expiry, scopes)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      display_name  = excluded.display_name,
      refresh_token = COALESCE(excluded.refresh_token, refresh_token),
      access_token  = excluded.access_token,
      token_expiry  = excluded.token_expiry,
      scopes        = excluded.scopes,
      enabled       = 1,
      updated_at    = CURRENT_TIMESTAMP
  `).run(email, displayName, refreshToken, accessToken, tokenExpiry, scopes);
  return getDb()
    .prepare(`SELECT * FROM google_accounts WHERE email = ?`)
    .get(email) as GoogleAccount;
}

export function updateGoogleAccountTokens(
  id: number,
  accessToken: string,
  tokenExpiry: string,
): void {
  getDb().prepare(`
    UPDATE google_accounts
    SET access_token = ?, token_expiry = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(accessToken, tokenExpiry, id);
}

export function disableGoogleAccount(id: number): void {
  getDb().prepare(`UPDATE google_accounts SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
}

export function getEnabledGoogleAccounts(): GoogleAccount[] {
  return getDb()
    .prepare(`SELECT * FROM google_accounts WHERE enabled = 1 ORDER BY id ASC`)
    .all() as GoogleAccount[];
}

export function getGoogleAccountByEmail(email: string): GoogleAccount | null {
  return getDb()
    .prepare(`SELECT * FROM google_accounts WHERE email = ?`)
    .get(email) as GoogleAccount | null;
}

// ---------------------------------------------------------------------------
// Calendar notification deduplication
// ---------------------------------------------------------------------------

export function isCalendarEventNotified(eventId: string, accountId: number): boolean {
  return !!getDb()
    .prepare(`SELECT 1 FROM calendar_notified WHERE event_id = ? AND account_id = ?`)
    .get(eventId, accountId);
}

export function markCalendarEventNotified(eventId: string, accountId: number): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO calendar_notified (event_id, account_id) VALUES (?, ?)`)
    .run(eventId, accountId);
}

// ---------------------------------------------------------------------------
// Conversation memory
// ---------------------------------------------------------------------------

export interface MemoryEntry {
  id: number;
  phone: string;
  role: 'user' | 'assistant';
  content: string;
  is_summary: 0 | 1;
  created_at: string;
}

export function getMemory(phone: string, limit = 20): MemoryEntry[] {
  return getDb()
    .prepare(
      `SELECT * FROM (
         SELECT * FROM conversation_memory
         WHERE phone = ?
         ORDER BY id DESC
         LIMIT ?
       ) ORDER BY id ASC`,
    )
    .all(phone, limit) as MemoryEntry[];
}

export function saveMemory(
  phone: string,
  role: 'user' | 'assistant',
  content: string,
  isSummary = false,
): MemoryEntry {
  const stmt = getDb().prepare(`
    INSERT INTO conversation_memory (phone, role, content, is_summary)
    VALUES (?, ?, ?, ?)
    RETURNING *
  `);
  return stmt.get(phone, role, content, isSummary ? 1 : 0) as MemoryEntry;
}

export function countMemory(phone: string): number {
  return (getDb()
    .prepare(`SELECT COUNT(*) as c FROM conversation_memory WHERE phone = ? AND is_summary = 0`)
    .get(phone) as { c: number }).c;
}

export function getOldestNonSummaryMessages(phone: string, n: number): MemoryEntry[] {
  return getDb()
    .prepare(`SELECT * FROM conversation_memory WHERE phone = ? AND is_summary = 0 ORDER BY id ASC LIMIT ?`)
    .all(phone, n) as MemoryEntry[];
}

export function deleteMessagesByIds(ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  getDb().prepare(`DELETE FROM conversation_memory WHERE id IN (${placeholders})`).run(...ids);
}

export function pruneMemory(phone: string, keep = 20): void {
  getDb()
    .prepare(
      `DELETE FROM conversation_memory
       WHERE phone = ?
         AND id NOT IN (
           SELECT id FROM conversation_memory
           WHERE phone = ?
           ORDER BY id DESC
           LIMIT ?
         )`,
    )
    .run(phone, phone, keep);
}

// ---------------------------------------------------------------------------
// Poll state (generic key-value)
// ---------------------------------------------------------------------------

export function getPollState(key: string): string | null {
  const row = getDb()
    .prepare(`SELECT value FROM poll_state WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setPollState(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO poll_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    )
    .run(key, value);
}

// ---------------------------------------------------------------------------
// Pending actions (multi-step interactions)
// ---------------------------------------------------------------------------

export function savePendingAction(phone: string, actionType: string, payload: object): void {
  getDb()
    .prepare(
      `INSERT INTO pending_actions (phone, action_type, payload, created_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(phone) DO UPDATE SET action_type = excluded.action_type,
         payload = excluded.payload, created_at = excluded.created_at`,
    )
    .run(phone, actionType, JSON.stringify(payload));
}

export function getPendingAction(phone: string): { action_type: string; payload: string } | null {
  return getDb()
    .prepare(`SELECT action_type, payload FROM pending_actions WHERE phone = ?`)
    .get(phone) as { action_type: string; payload: string } | null;
}

export function clearPendingAction(phone: string): void {
  getDb().prepare(`DELETE FROM pending_actions WHERE phone = ?`).run(phone);
}

// ---------------------------------------------------------------------------
// User facts (long-term memory extracted from conversations)
// ---------------------------------------------------------------------------

export type FactCategory = 'preference' | 'project' | 'person' | 'habit' | 'general';

export interface UserFact {
  id: number;
  phone: string;
  fact: string;
  category: FactCategory;
  created_at: string;
  last_used: string;
}

export function getUserFacts(phone: string, limit = 20): UserFact[] {
  return getDb()
    .prepare(`SELECT * FROM user_facts WHERE phone = ? ORDER BY last_used DESC LIMIT ?`)
    .all(phone, limit) as UserFact[];
}

export function saveUserFact(phone: string, fact: string, category: FactCategory): void {
  // Skip if an almost-identical fact already exists
  const existing = getDb()
    .prepare(`SELECT id FROM user_facts WHERE phone = ? AND fact LIKE ?`)
    .get(phone, `%${fact.slice(0, 30)}%`) as { id: number } | undefined;
  if (existing) return;

  getDb().prepare(`INSERT INTO user_facts (phone, fact, category) VALUES (?, ?, ?)`).run(phone, fact, category);

  // Cap at 50 facts per phone — remove oldest by last_used
  const count = (getDb().prepare(`SELECT COUNT(*) as c FROM user_facts WHERE phone = ?`).get(phone) as { c: number }).c;
  if (count > 50) {
    const oldest = getDb()
      .prepare(`SELECT id FROM user_facts WHERE phone = ? ORDER BY last_used ASC LIMIT ?`)
      .all(phone, count - 50) as { id: number }[];
    const ids = oldest.map((r) => r.id);
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      getDb().prepare(`DELETE FROM user_facts WHERE id IN (${ph})`).run(...ids);
    }
  }
}

export function touchUserFacts(ids: number[]): void {
  if (ids.length === 0) return;
  const ph = ids.map(() => '?').join(',');
  getDb().prepare(`UPDATE user_facts SET last_used = CURRENT_TIMESTAMP WHERE id IN (${ph})`).run(...ids);
}

// ---------------------------------------------------------------------------
// User preferences
// ---------------------------------------------------------------------------

export interface UserPreferences {
  phone: string;
  timezone: string;
  language: string;
  silent_start: string;
  silent_end: string;
  email_notify_categories: string;
  daily_email_limit: number;
  calendar_reminder_minutes: number;
  calendar_reminder_enabled: 0 | 1;
  briefing_enabled: 0 | 1;
  briefing_time: string;
  verbose_mode: 0 | 1;
  updated_at: string;
}

const DEFAULT_PREFS: Omit<UserPreferences, 'phone' | 'updated_at'> = {
  timezone: 'America/Sao_Paulo',
  language: 'pt-BR',
  silent_start: '22:00',
  silent_end: '07:00',
  email_notify_categories: 'urgente,importante',
  daily_email_limit: 20,
  calendar_reminder_minutes: 15,
  calendar_reminder_enabled: 1,
  briefing_enabled: 1,
  briefing_time: '07:30',
  verbose_mode: 0,
};

export function getUserPreferences(phone: string): UserPreferences {
  const row = getDb()
    .prepare(`SELECT * FROM user_preferences WHERE phone = ?`)
    .get(phone) as UserPreferences | undefined;
  if (row) return row;
  // Return defaults without persisting (lazily created on first set)
  return { phone, updated_at: new Date().toISOString(), ...DEFAULT_PREFS };
}

export function setUserPreference<K extends keyof Omit<UserPreferences, 'phone' | 'updated_at'>>(
  phone: string,
  key: K,
  value: UserPreferences[K],
): void {
  const current = getUserPreferences(phone);
  const merged = { ...current, [key]: value };
  getDb().prepare(`
    INSERT INTO user_preferences (phone, timezone, language, silent_start, silent_end,
      email_notify_categories, daily_email_limit, calendar_reminder_minutes,
      calendar_reminder_enabled, briefing_enabled, briefing_time, verbose_mode, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(phone) DO UPDATE SET ${key} = excluded.${key}, updated_at = CURRENT_TIMESTAMP
  `).run(
    phone, merged.timezone, merged.language, merged.silent_start, merged.silent_end,
    merged.email_notify_categories, merged.daily_email_limit, merged.calendar_reminder_minutes,
    merged.calendar_reminder_enabled, merged.briefing_enabled, merged.briefing_time, merged.verbose_mode,
  );
}

// ---------------------------------------------------------------------------
// Bot metrics
// ---------------------------------------------------------------------------

export function logMetric(
  phone: string,
  module: string,
  action: string,
  latencyMs: number | null,
  success: boolean,
  errorMessage?: string,
): void {
  try {
    getDb().prepare(`
      INSERT INTO bot_metrics (phone, module, action, latency_ms, success, error_message)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(phone, module, action, latencyMs, success ? 1 : 0, errorMessage ?? null);
  } catch {
    // Metrics must never crash the bot
  }
}

export function getMetricStats(phone: string, days = 7): {
  total: number;
  successRate: number;
  avgLatencyMs: number;
  topModules: { module: string; count: number }[];
  errors: { message: string; count: number }[];
} {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const total = (getDb().prepare(`SELECT COUNT(*) as c FROM bot_metrics WHERE phone = ? AND created_at >= ?`).get(phone, since) as { c: number }).c;
  if (total === 0) return { total: 0, successRate: 100, avgLatencyMs: 0, topModules: [], errors: [] };

  const ok = (getDb().prepare(`SELECT COUNT(*) as c FROM bot_metrics WHERE phone = ? AND created_at >= ? AND success = 1`).get(phone, since) as { c: number }).c;
  const avgRow = getDb().prepare(`SELECT AVG(latency_ms) as a FROM bot_metrics WHERE phone = ? AND created_at >= ? AND latency_ms IS NOT NULL`).get(phone, since) as { a: number | null };

  const topModules = getDb().prepare(`
    SELECT module, COUNT(*) as count FROM bot_metrics WHERE phone = ? AND created_at >= ?
    GROUP BY module ORDER BY count DESC LIMIT 5
  `).all(phone, since) as { module: string; count: number }[];

  const errors = getDb().prepare(`
    SELECT error_message as message, COUNT(*) as count
    FROM bot_metrics WHERE phone = ? AND created_at >= ? AND success = 0 AND error_message IS NOT NULL
    GROUP BY message ORDER BY count DESC LIMIT 3
  `).all(phone, since) as { message: string; count: number }[];

  return {
    total,
    successRate: Math.round((ok / total) * 100),
    avgLatencyMs: Math.round(avgRow.a ?? 0),
    topModules,
    errors,
  };
}
