import { getDb, ensureSchema } from './lib/db.js'
import { getUserId } from './lib/auth.js'

export default async function handler(req, res) {
  const db = getDb()
  await ensureSchema(db)

  const userId = await getUserId(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  // ── GET: load all user data ──────────────────────────────────────────────
  if (req.method === 'GET') {
    const [trades, sessions, plans, signals, activity, settingsRes] = await Promise.all([
      db.execute({ sql: 'SELECT * FROM trades WHERE user_id = ? ORDER BY created_at', args: [userId] }),
      db.execute({ sql: 'SELECT * FROM daily_sessions WHERE user_id = ? ORDER BY created_at', args: [userId] }),
      db.execute({ sql: 'SELECT * FROM daily_plans WHERE user_id = ? ORDER BY created_at', args: [userId] }),
      db.execute({ sql: 'SELECT * FROM executed_signals WHERE user_id = ? ORDER BY created_at', args: [userId] }),
      db.execute({ sql: 'SELECT * FROM activity_log WHERE user_id = ? ORDER BY timestamp DESC LIMIT 200', args: [userId] }),
      db.execute({ sql: 'SELECT * FROM settings WHERE user_id = ?', args: [userId] }),
    ])
    const s = settingsRes.rows[0]
    return res.json({
      trades: trades.rows.map((r) => ({
        id: r.id, date: r.date, symbol: r.symbol, action: r.action,
        quantity: r.quantity, entryPrice: r.entry_price, exitPrice: r.exit_price,
        riskRating: r.risk_rating, notes: r.notes, createdAt: r.created_at,
      })),
      dailySessions: sessions.rows.map((r) => ({
        id: r.id, date: r.date, phase: r.phase, response: r.response,
        watchList: r.watch_list, notes: r.notes, createdAt: r.created_at,
      })),
      dailyPlans: plans.rows.map((r) => ({
        id: r.id, date: r.date, response: r.response, watchList: r.watch_list,
        riskProfile: r.risk_profile, notes: r.notes, createdAt: r.created_at,
      })),
      executedSignals: signals.rows.map((r) => JSON.parse(r.signal_json)),
      activityLog: activity.rows.reverse().map((r) => ({
        id: r.id, date: r.date, type: r.type,
        message: r.message, detail: r.detail, timestamp: r.timestamp,
      })),
      settings: { languageModelProvider: s?.language_model_provider || 'gemini' },
    })
  }

  // ── POST: mutations ──────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { action, payload } = req.body

    if (action === 'save-session') {
      const { id, date, phase, response, watchList, notes, createdAt } = payload
      await db.batch([
        { sql: 'DELETE FROM daily_sessions WHERE user_id = ? AND date = ? AND phase = ?', args: [userId, date, phase] },
        { sql: 'INSERT INTO daily_sessions (id, user_id, date, phase, response, watch_list, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', args: [id, userId, date, phase, response || '', watchList || '', notes || '', createdAt] },
      ])
      return res.json({ ok: true })
    }

    if (action === 'delete-session') {
      await db.execute({ sql: 'DELETE FROM daily_sessions WHERE user_id = ? AND date = ? AND phase = ?', args: [userId, payload.date, payload.phase] })
      return res.json({ ok: true })
    }

    if (action === 'add-trade') {
      const t = payload
      await db.execute({
        sql: 'INSERT INTO trades (id, user_id, date, symbol, action, quantity, entry_price, exit_price, risk_rating, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [t.id, userId, t.date, t.symbol, t.action, t.quantity, t.entryPrice, t.exitPrice, t.riskRating || 'Medium', t.notes || '', t.createdAt],
      })
      return res.json({ ok: true })
    }

    if (action === 'delete-trade') {
      await db.execute({ sql: 'DELETE FROM trades WHERE id = ? AND user_id = ?', args: [payload.id, userId] })
      return res.json({ ok: true })
    }

    if (action === 'save-trades-for-date') {
      const { date, trades } = payload
      const stmts = [
        { sql: 'DELETE FROM trades WHERE user_id = ? AND date = ?', args: [userId, date] },
        ...trades.map((t) => ({
          sql: 'INSERT INTO trades (id, user_id, date, symbol, action, quantity, entry_price, exit_price, risk_rating, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          args: [t.id, userId, t.date, t.symbol, t.action, t.quantity, t.entryPrice, t.exitPrice, t.riskRating || 'Medium', t.notes || '', t.createdAt],
        })),
      ]
      await db.batch(stmts)
      return res.json({ ok: true })
    }

    if (action === 'add-signals') {
      const { signals } = payload
      if (!signals?.length) return res.json({ ok: true })
      await db.batch(signals.map((s) => {
        const id = `${s.date || ''}-${s.symbol || ''}-${s.type || ''}`
        return {
          sql: 'INSERT OR IGNORE INTO executed_signals (id, user_id, sig_date, signal_json, created_at) VALUES (?, ?, ?, ?, ?)',
          args: [id, userId, s.date || '', JSON.stringify(s), s.timestamp || new Date().toISOString()],
        }
      }))
      return res.json({ ok: true })
    }

    if (action === 'reset-signals') {
      await db.execute({ sql: 'DELETE FROM executed_signals WHERE user_id = ? AND sig_date = ?', args: [userId, payload.date] })
      return res.json({ ok: true })
    }

    if (action === 'add-activity') {
      const { entries } = payload
      if (!entries?.length) return res.json({ ok: true })
      await db.batch(entries.map((e) => ({
        sql: 'INSERT OR IGNORE INTO activity_log (id, user_id, date, type, message, detail, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [e.id, userId, e.date || '', e.type, e.message || '', e.detail || '', e.timestamp],
      })))
      return res.json({ ok: true })
    }

    if (action === 'update-settings') {
      await db.execute({
        sql: 'INSERT OR REPLACE INTO settings (user_id, language_model_provider) VALUES (?, ?)',
        args: [userId, payload.languageModelProvider || 'gemini'],
      })
      return res.json({ ok: true })
    }

    if (action === 'migrate') {
      const { trades = [], dailySessions = [], dailyPlans = [], executedSignals = [], activityLog = [], settings: s } = payload
      const stmts = []
      for (const t of trades) {
        stmts.push({ sql: 'INSERT OR IGNORE INTO trades (id, user_id, date, symbol, action, quantity, entry_price, exit_price, risk_rating, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [t.id, userId, t.date, t.symbol, t.action, t.quantity, t.entryPrice, t.exitPrice, t.riskRating || 'Medium', t.notes || '', t.createdAt] })
      }
      for (const sess of dailySessions) {
        stmts.push({ sql: 'INSERT OR IGNORE INTO daily_sessions (id, user_id, date, phase, response, watch_list, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', args: [sess.id, userId, sess.date, sess.phase, sess.response || '', sess.watchList || '', sess.notes || '', sess.createdAt] })
      }
      for (const plan of dailyPlans) {
        stmts.push({ sql: 'INSERT OR IGNORE INTO daily_plans (id, user_id, date, response, watch_list, risk_profile, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', args: [plan.id, userId, plan.date, plan.response || '', plan.watchList || '', plan.riskProfile || '', plan.notes || '', plan.createdAt] })
      }
      for (const sig of executedSignals) {
        const id = `${sig.date || ''}-${sig.symbol || ''}-${sig.type || ''}`
        stmts.push({ sql: 'INSERT OR IGNORE INTO executed_signals (id, user_id, sig_date, signal_json, created_at) VALUES (?, ?, ?, ?, ?)', args: [id, userId, sig.date || '', JSON.stringify(sig), sig.timestamp || new Date().toISOString()] })
      }
      for (const e of activityLog) {
        stmts.push({ sql: 'INSERT OR IGNORE INTO activity_log (id, user_id, date, type, message, detail, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [e.id, userId, e.date || '', e.type, e.message || '', e.detail || '', e.timestamp] })
      }
      if (s) {
        stmts.push({ sql: 'INSERT OR REPLACE INTO settings (user_id, language_model_provider) VALUES (?, ?)', args: [userId, s.languageModelProvider || 'gemini'] })
      }
      if (stmts.length > 0) await db.batch(stmts)
      return res.json({ ok: true, migrated: stmts.length })
    }

    return res.status(400).json({ error: `Unknown action: ${action}` })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
