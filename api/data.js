import { PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb'
import { db, TABLE, pk, queryAll, queryPrefix, batchWrite } from './lib/db.js'
import { getUserId } from './lib/auth.js'

// ── Mappers: DynamoDB item → app shape ──────────────────────────────────────

function toTrade(item) {
  return { id: item.id, date: item.date, symbol: item.symbol, action: item.action, quantity: item.quantity, entryPrice: item.entryPrice, exitPrice: item.exitPrice, riskRating: item.riskRating, notes: item.notes, createdAt: item.createdAt }
}
function toSession(item) {
  return { id: item.id, date: item.date, phase: item.phase, response: item.response, watchList: item.watchList, notes: item.notes, createdAt: item.createdAt }
}
function toPlan(item) {
  return { id: item.id, date: item.date, response: item.response, watchList: item.watchList, riskProfile: item.riskProfile, notes: item.notes, createdAt: item.createdAt }
}
function toActivity(item) {
  return { id: item.id, date: item.date, type: item.logType, message: item.message, detail: item.detail, timestamp: item.timestamp }
}

// ── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const userId = await getUserId(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const userPk = pk(userId)

  // ── GET: load all user data ───────────────────────────────────────────────
  if (req.method === 'GET') {
    const items = await queryAll(userId)

    const trades = []
    const dailySessions = []
    const dailyPlans = []
    const executedSignals = []
    const activityLog = []
    let settings = { languageModelProvider: 'gemini' }

    for (const item of items) {
      const { sk } = item
      if (sk.startsWith('TRADE#'))    trades.push(toTrade(item))
      else if (sk.startsWith('SESSION#'))  dailySessions.push(toSession(item))
      else if (sk.startsWith('PLAN#'))     dailyPlans.push(toPlan(item))
      else if (sk.startsWith('SIGNAL#'))   executedSignals.push(JSON.parse(item.signalJson))
      else if (sk.startsWith('ACTIVITY#')) activityLog.push(toActivity(item))
      else if (sk === 'SETTINGS')          settings = { languageModelProvider: item.languageModelProvider || 'gemini' }
    }

    // Activity log: keep latest 200, sorted ascending
    activityLog.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    const trimmedLog = activityLog.slice(-200)

    return res.json({ trades, dailySessions, dailyPlans, executedSignals, activityLog: trimmedLog, settings })
  }

  // ── POST: mutations ───────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { action, payload } = req.body

    if (action === 'save-session') {
      const { id, date, phase, response, watchList, notes, createdAt } = payload
      await db.send(new PutCommand({
        TableName: TABLE,
        Item: { pk: userPk, sk: `SESSION#${date}#${phase}`, id, date, phase, response: response || '', watchList: watchList || '', notes: notes || '', createdAt },
      }))
      return res.json({ ok: true })
    }

    if (action === 'delete-session') {
      const { date, phase } = payload
      await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: userPk, sk: `SESSION#${date}#${phase}` } }))
      return res.json({ ok: true })
    }

    if (action === 'add-trade') {
      const t = payload
      await db.send(new PutCommand({
        TableName: TABLE,
        Item: { pk: userPk, sk: `TRADE#${t.id}`, id: t.id, date: t.date, symbol: t.symbol, action: t.action, quantity: t.quantity, entryPrice: t.entryPrice, exitPrice: t.exitPrice, riskRating: t.riskRating || 'Medium', notes: t.notes || '', createdAt: t.createdAt },
      }))
      return res.json({ ok: true })
    }

    if (action === 'delete-trade') {
      await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: userPk, sk: `TRADE#${payload.id}` } }))
      return res.json({ ok: true })
    }

    if (action === 'save-trades-for-date') {
      const { date, trades } = payload
      // Delete all existing trades for this date, then insert the new set
      const existing = await queryPrefix(userId, 'TRADE#')
      const toDelete = existing.filter((i) => i.date === date).map((i) => ({ DeleteRequest: { Key: { pk: userPk, sk: i.sk } } }))
      const toInsert = trades.map((t) => ({ PutRequest: { Item: { pk: userPk, sk: `TRADE#${t.id}`, id: t.id, date: t.date, symbol: t.symbol, action: t.action, quantity: t.quantity, entryPrice: t.entryPrice, exitPrice: t.exitPrice, riskRating: t.riskRating || 'Medium', notes: t.notes || '', createdAt: t.createdAt } } }))
      await batchWrite([...toDelete, ...toInsert])
      return res.json({ ok: true })
    }

    if (action === 'add-signals') {
      const { signals } = payload
      if (!signals?.length) return res.json({ ok: true })
      await batchWrite(signals.map((s) => ({
        PutRequest: { Item: { pk: userPk, sk: `SIGNAL#${s.date || ''}#${s.symbol || ''}#${s.type || ''}`, signalJson: JSON.stringify(s) } },
      })))
      return res.json({ ok: true })
    }

    if (action === 'reset-signals') {
      const items = await queryPrefix(userId, `SIGNAL#${payload.date}`)
      if (!items.length) return res.json({ ok: true })
      await batchWrite(items.map((i) => ({ DeleteRequest: { Key: { pk: userPk, sk: i.sk } } })))
      return res.json({ ok: true })
    }

    if (action === 'add-activity') {
      const { entries } = payload
      if (!entries?.length) return res.json({ ok: true })
      await batchWrite(entries.map((e) => ({
        PutRequest: { Item: { pk: userPk, sk: `ACTIVITY#${e.timestamp}#${e.id}`, id: e.id, date: e.date || '', logType: e.type, message: e.message || '', detail: e.detail || '', timestamp: e.timestamp } },
      })))
      return res.json({ ok: true })
    }

    if (action === 'update-settings') {
      await db.send(new PutCommand({
        TableName: TABLE,
        Item: { pk: userPk, sk: 'SETTINGS', languageModelProvider: payload.languageModelProvider || 'gemini' },
      }))
      return res.json({ ok: true })
    }

    if (action === 'migrate') {
      const { trades = [], dailySessions = [], dailyPlans = [], executedSignals = [], activityLog = [], settings: s } = payload
      const requests = [
        ...trades.map((t) => ({ PutRequest: { Item: { pk: userPk, sk: `TRADE#${t.id}`, id: t.id, date: t.date, symbol: t.symbol, action: t.action, quantity: t.quantity, entryPrice: t.entryPrice, exitPrice: t.exitPrice, riskRating: t.riskRating || 'Medium', notes: t.notes || '', createdAt: t.createdAt } } })),
        ...dailySessions.map((sess) => ({ PutRequest: { Item: { pk: userPk, sk: `SESSION#${sess.date}#${sess.phase}`, id: sess.id, date: sess.date, phase: sess.phase, response: sess.response || '', watchList: sess.watchList || '', notes: sess.notes || '', createdAt: sess.createdAt } } })),
        ...dailyPlans.map((plan) => ({ PutRequest: { Item: { pk: userPk, sk: `PLAN#${plan.date}#${plan.id}`, id: plan.id, date: plan.date, response: plan.response || '', watchList: plan.watchList || '', riskProfile: plan.riskProfile || '', notes: plan.notes || '', createdAt: plan.createdAt } } })),
        ...executedSignals.map((sig) => ({ PutRequest: { Item: { pk: userPk, sk: `SIGNAL#${sig.date || ''}#${sig.symbol || ''}#${sig.type || ''}`, signalJson: JSON.stringify(sig) } } })),
        ...activityLog.map((e) => ({ PutRequest: { Item: { pk: userPk, sk: `ACTIVITY#${e.timestamp}#${e.id}`, id: e.id, date: e.date || '', logType: e.type, message: e.message || '', detail: e.detail || '', timestamp: e.timestamp } } })),
        ...(s ? [{ PutRequest: { Item: { pk: userPk, sk: 'SETTINGS', languageModelProvider: s.languageModelProvider || 'gemini' } } }] : []),
      ]
      if (requests.length) await batchWrite(requests)
      return res.json({ ok: true, migrated: requests.length })
    }

    return res.status(400).json({ error: `Unknown action: ${action}` })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
