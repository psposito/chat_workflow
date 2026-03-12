import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.resolve(process.cwd(), 'data', 'bot.db');

let db: Database.Database;

export function initDb(): Database.Database {
  const Database = require('better-sqlite3');
  db = new Database(DB_PATH, { verbose: console.log });

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      from_num  TEXT    NOT NULL,
      body      TEXT    NOT NULL,
      direction TEXT    NOT NULL CHECK(direction IN ('inbound', 'outbound')),
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
