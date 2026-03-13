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
  `);

  // Migration: add notified column if it doesn't exist yet
  try {
    db.exec('ALTER TABLE tasks ADD COLUMN notified INTEGER NOT NULL DEFAULT 0');
  } catch {
    // Column already exists — ignore
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

export interface Task {
  id: number;
  phone: string;
  title: string;
  description: string;
  due_date: string | null;
  due_time: string | null;
  status: 'pending' | 'done';
  notified: 0 | 1;
  created_at: string;
}

export function saveTask(
  phone: string,
  title: string,
  description: string,
  dueDate?: string,
  dueTime?: string,
): Task {
  const stmt = getDb().prepare(`
    INSERT INTO tasks (phone, title, description, due_date, due_time)
    VALUES (?, ?, ?, ?, ?)
    RETURNING *
  `);
  return stmt.get(phone, title, description, dueDate ?? null, dueTime ?? null) as Task;
}

export function listPendingTasks(phone: string): Task[] {
  return getDb()
    .prepare(
      `SELECT * FROM tasks
       WHERE phone = ? AND status = 'pending'
       ORDER BY due_date ASC, due_time ASC, created_at ASC`,
    )
    .all(phone) as Task[];
}

export function getTasksDueNow(date: string, time: string): Task[] {
  return getDb()
    .prepare(
      `SELECT * FROM tasks
       WHERE due_date = ? AND due_time = ? AND status = 'pending' AND notified = 0`,
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

export function deleteAllTasks(phone: string): number {
  const result = getDb()
    .prepare(`DELETE FROM tasks WHERE phone = ? AND status = 'pending'`)
    .run(phone);
  return result.changes as number;
}

export function listTasksDueToday(): Map<string, Task[]> {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); // YYYY-MM-DD
  const rows = getDb()
    .prepare(
      `SELECT * FROM tasks
       WHERE due_date = ? AND status = 'pending'
       ORDER BY due_time ASC, created_at ASC`,
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

// ---------------------------------------------------------------------------
// Gmail — legacy notified table (kept for backward compat)
// ---------------------------------------------------------------------------

export function isEmailNotified(messageId: string): boolean {
  const inOld = getDb()
    .prepare(`SELECT 1 FROM gmail_notified WHERE message_id = ?`)
    .get(messageId);
  if (inOld) return true;
  const inNew = getDb()
    .prepare(`SELECT 1 FROM gmail_emails WHERE message_id = ? AND notified = 1`)
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

export interface GmailEmail {
  id: number;
  message_id: string;
  sender: string;
  subject: string;
  ai_score: number;
  notified: 0 | 1;
  feedback: 'important' | 'not_important' | null;
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

export function updateSenderReputation(sender: string, feedback: 'important' | 'not_important'): void {
  const col = feedback === 'important' ? 'important_count' : 'not_important_count';
  getDb().prepare(`
    INSERT INTO sender_reputation (sender, ${col})
    VALUES (?, 1)
    ON CONFLICT(sender) DO UPDATE SET ${col} = ${col} + 1, updated_at = CURRENT_TIMESTAMP
  `).run(sender);
}

export function setEmailFeedback(id: number, feedback: 'important' | 'not_important'): GmailEmail | null {
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
  created_at: string;
}

export function getMemory(phone: string, limit = 10): MemoryEntry[] {
  // Return oldest-first so they can be fed directly into a chat messages array
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
): MemoryEntry {
  const stmt = getDb().prepare(`
    INSERT INTO conversation_memory (phone, role, content)
    VALUES (?, ?, ?)
    RETURNING *
  `);
  return stmt.get(phone, role, content) as MemoryEntry;
}

export function pruneMemory(phone: string, keep = 10): void {
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
