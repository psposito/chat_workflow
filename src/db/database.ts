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
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversation_memory (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      phone      TEXT NOT NULL,
      role       TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content    TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

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
