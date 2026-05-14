import { createClient } from '@libsql/client'

let _client = null

export function getDb() {
  if (_client) return _client
  _client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  })
  return _client
}

let _ready = false

export async function ensureSchema(db) {
  if (_ready) return
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      symbol TEXT NOT NULL,
      action TEXT NOT NULL,
      quantity REAL NOT NULL,
      entry_price REAL NOT NULL,
      exit_price REAL NOT NULL,
      risk_rating TEXT DEFAULT 'Medium',
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY (id, user_id)
    );
    CREATE TABLE IF NOT EXISTS daily_sessions (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      phase TEXT NOT NULL,
      response TEXT DEFAULT '',
      watch_list TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY (id, user_id)
    );
    CREATE TABLE IF NOT EXISTS daily_plans (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      response TEXT DEFAULT '',
      watch_list TEXT DEFAULT '',
      risk_profile TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY (id, user_id)
    );
    CREATE TABLE IF NOT EXISTS executed_signals (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      sig_date TEXT DEFAULT '',
      signal_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (id, user_id)
    );
    CREATE TABLE IF NOT EXISTS activity_log (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      date TEXT DEFAULT '',
      type TEXT NOT NULL,
      message TEXT DEFAULT '',
      detail TEXT DEFAULT '',
      timestamp TEXT NOT NULL,
      PRIMARY KEY (id, user_id)
    );
    CREATE TABLE IF NOT EXISTS settings (
      user_id TEXT PRIMARY KEY,
      language_model_provider TEXT DEFAULT 'gemini'
    );
  `)
  _ready = true
}
