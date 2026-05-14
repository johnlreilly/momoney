// One-time migration: Turso → DynamoDB
// Usage: node scripts/migrate.mjs
// Reads credentials from .env.local

import { readFileSync } from 'fs'
import { createClient } from '@libsql/client'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb'

// Load .env.local
const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => l.split('=').map((s) => s.trim()))
)
Object.assign(process.env, env)

const TABLE  = process.env.DYNAMODB_TABLE || 'momoney'
const REGION = process.env.AWS_REGION     || 'us-east-1'

const turso = createClient({
  url:       process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
})

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }))

async function batchWrite(requests) {
  for (let i = 0; i < requests.length; i += 25) {
    const chunk = requests.slice(i, i + 25)
    await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: chunk } }))
  }
}

async function run() {
  console.log('Fetching users from Turso...')
  const users = await turso.execute('SELECT DISTINCT user_id FROM settings')

  for (const row of users.rows) {
    const userId = row.user_id
    const pk     = `USER#${userId}`
    console.log(`\nMigrating user ${userId}...`)

    const [trades, sessions, plans, signals, activity, settings] = await Promise.all([
      turso.execute({ sql: 'SELECT * FROM trades WHERE user_id = ?',           args: [userId] }),
      turso.execute({ sql: 'SELECT * FROM daily_sessions WHERE user_id = ?',   args: [userId] }),
      turso.execute({ sql: 'SELECT * FROM daily_plans WHERE user_id = ?',      args: [userId] }),
      turso.execute({ sql: 'SELECT * FROM executed_signals WHERE user_id = ?', args: [userId] }),
      turso.execute({ sql: 'SELECT * FROM activity_log WHERE user_id = ?',     args: [userId] }),
      turso.execute({ sql: 'SELECT * FROM settings WHERE user_id = ?',         args: [userId] }),
    ])

    const requests = [
      ...trades.rows.map((r) => ({ PutRequest: { Item: { pk, sk: `TRADE#${r.id}`, id: r.id, date: r.date, symbol: r.symbol, action: r.action, quantity: r.quantity, entryPrice: r.entry_price, exitPrice: r.exit_price, riskRating: r.risk_rating, notes: r.notes || '', createdAt: r.created_at } } })),
      ...sessions.rows.map((r) => ({ PutRequest: { Item: { pk, sk: `SESSION#${r.date}#${r.phase}`, id: r.id, date: r.date, phase: r.phase, response: r.response || '', watchList: r.watch_list || '', notes: r.notes || '', createdAt: r.created_at } } })),
      ...plans.rows.map((r) => ({ PutRequest: { Item: { pk, sk: `PLAN#${r.date}#${r.id}`, id: r.id, date: r.date, response: r.response || '', watchList: r.watch_list || '', riskProfile: r.risk_profile || '', notes: r.notes || '', createdAt: r.created_at } } })),
      ...signals.rows.map((r) => {
        const sig = JSON.parse(r.signal_json)
        return { PutRequest: { Item: { pk, sk: `SIGNAL#${r.sig_date}#${sig.symbol || ''}#${sig.type || ''}`, signalJson: r.signal_json } } }
      }),
      ...activity.rows.map((r) => ({ PutRequest: { Item: { pk, sk: `ACTIVITY#${r.timestamp}#${r.id}`, id: r.id, date: r.date || '', logType: r.type, message: r.message || '', detail: r.detail || '', timestamp: r.timestamp } } })),
      ...(settings.rows[0] ? [{ PutRequest: { Item: { pk, sk: 'SETTINGS', languageModelProvider: settings.rows[0].language_model_provider || 'gemini' } } }] : []),
    ]

    if (requests.length) {
      await batchWrite(requests)
      console.log(`  ✓ ${requests.length} items written (${trades.rows.length} trades, ${sessions.rows.length} sessions, ${plans.rows.length} plans, ${signals.rows.length} signals, ${activity.rows.length} activity)`)
    } else {
      console.log('  (no data)')
    }
  }

  console.log('\nMigration complete.')
}

run().catch((err) => { console.error(err); process.exit(1) })
