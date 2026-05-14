// AWS Lambda handler — invoked by EventBridge on a cron schedule.
// AWS SDK v3 is built into the Lambda Node.js 20.x runtime; no bundling needed.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb'

const TABLE  = process.env.DYNAMODB_TABLE || 'momoney'
const REGION = process.env.AWS_REGION     || 'us-east-1'
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }))

const PHASES = [
  { phase: 'pre-market',    startHour: 8.0,  label: 'Pre-Market' },
  { phase: 'opening-drive', startHour: 9.5,  label: 'Opening Drive' },
  { phase: 'midday-fade',   startHour: 10.5, label: 'Mid-Day Fade' },
  { phase: 'power-hour',    startHour: 15.0, label: 'Power Hour' },
]

const PHASE_PROMPTS = {
  'pre-market': `You are an intraday equity trader with $100,000 and zero commissions. It is pre-market (before 9:30 AM ET). Identify the best 3-5 gapper opportunities for today's open — stocks with 3%+ pre-market moves on meaningful volume or a clear catalyst (earnings, news, upgrade). Focus on gap magnitude, relative volume vs average, and float size. Avoid extended pre-market moves with no volume.

Format your reply EXACTLY as follows:
Plan: [2-3 sentence pre-market thesis based on the specific movers above]
Watch list: [3-5 ticker symbols, comma-separated]
Notes: [key pre-market levels, expected gap fill or continuation, stop loss below pre-market low]`,

  'opening-drive': `You are an intraday equity trader with $100,000 and zero commissions. It is the opening drive (9:30–10:30 AM ET). Identify 3-5 stocks showing the strongest ORB (Opening Range Breakout) setups — price breaking above the first 15-minute high on elevated volume. Prioritize stocks with a clean pre-market range and institutional interest.

Format your reply EXACTLY as follows:
Plan: [2-3 sentence opening drive thesis using the specific movers above]
Watch list: [3-5 ticker symbols, comma-separated]
Notes: [ORB high/low levels, volume confirmation threshold, stop loss at ORB low, target = 2× range]`,

  'midday-fade': `You are an intraday equity trader with $100,000 and zero commissions. It is mid-day (10:30 AM–3:00 PM ET). Identify 3-5 mean-reversion candidates — stocks that are extended (RSI > 70 or RSI < 30) and likely to revert to their VWAP or 20-period MA. Avoid names with ongoing news catalysts. Prefer liquid large-caps for safer fades.

Format your reply EXACTLY as follows:
Plan: [2-3 sentence midday thesis based on the specific movers above]
Watch list: [3-5 ticker symbols, comma-separated]
Notes: [current RSI estimate, distance from VWAP, entry trigger, target VWAP, stop above/below recent extreme]`,

  'power-hour': `You are an intraday equity trader with $100,000 and zero commissions. It is power hour (3:00–3:45 PM ET). ALL positions must be closed by 3:45 PM — no exceptions. Identify 3-5 relative strength leaders to ride into the close and any weak names to fade. Focus on VWAP relationship and momentum. Size down — this is an exit-focused session.

Format your reply EXACTLY as follows:
Plan: [2-3 sentence power hour thesis — momentum plays and exit plan]
Watch list: [3-5 ticker symbols, comma-separated]
Notes: [VWAP levels, position sizing (smaller), hard exit at 3:45 PM, no overnight holds]`,
}

function getEasternHour() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(new Date())
  const h = parseInt(parts.find((p) => p.type === 'hour').value, 10)
  const m = parseInt(parts.find((p) => p.type === 'minute').value, 10)
  return h + m / 60
}

function getEasternDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
}

function upcomingPhase(minutesAhead = 15) {
  const h = getEasternHour()
  return PHASES.find((p) => p.startHour > h && p.startHour <= h + minutesAhead / 60) || null
}

function parseAiPlanResponse(text) {
  const normalized = text.replace(/\r/g, '').replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1').replace(/^[\s*#-]+/gm, (m) => m.replace(/[*#-]/g, ''))
  const planMatch  = normalized.match(/Plan\s*[:]\s*([\s\S]*?)(?=(Watch\s*list|Watchlist|Tickers|Symbols|Notes|$))/i)
  const watchMatch = normalized.match(/(?:Watch\s*list|Watchlist|Tickers|Symbols)\s*[:]\s*([\s\S]*?)(?=(Notes|$))/i)
  const notesMatch = normalized.match(/Notes\s*[:]\s*([\s\S]*)/i)
  const plan = planMatch ? planMatch[1].trim() : normalized.trim()
  const watchList = watchMatch ? watchMatch[1].trim().replace(/[\r\n]+/g, ', ').replace(/^[\s\-•*]+/gm, '').replace(/\s*,\s*/g, ', ').trim() : ''
  const notes = notesMatch ? notesMatch[1].trim() : ''
  return { plan, watchList, notes }
}

async function queryUsers() {
  const results = []
  let lastKey
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE,
      IndexName: 'sk-index',
      KeyConditionExpression: 'sk = :sk',
      ExpressionAttributeValues: { ':sk': 'SETTINGS' },
      ExclusiveStartKey: lastKey,
    }))
    results.push(...(res.Items || []))
    lastKey = res.LastEvaluatedKey
  } while (lastKey)
  return results.map((i) => i.pk.replace('USER#', ''))
}

export const handler = async () => {
  const phase = upcomingPhase(15)
  if (!phase) return { message: 'No phase starting in the next 15 minutes' }

  const today = getEasternDate()

  // Get all registered users
  const userIds = await queryUsers()
  if (!userIds.length) return { message: 'No users found' }

  // Fetch live movers
  let moversContext = ''
  try {
    const res = await fetch(`https://www.alphavantage.co/query?function=TOP_GAINERS_LOSERS&apikey=${process.env.ALPHA_VANTAGE_API_KEY}`)
    const data = await res.json()
    const fmt = (list) => (list || []).slice(0, 5).map((s) => `${s.ticker} ${s.change_percentage} @ $${parseFloat(s.price).toFixed(2)}`).join(', ')
    if (data.top_gainers) {
      moversContext = `\n\nLIVE MARKET DATA for ${today}:\nTop gainers: ${fmt(data.top_gainers)}\nTop losers: ${fmt(data.top_losers)}\nMost active: ${fmt(data.most_actively_traded)}`
    }
  } catch { /* skip movers if unavailable */ }

  // Call Gemini
  const prompt = `${PHASE_PROMPTS[phase.phase]}${moversContext}\n\nToday is ${today}.`
  const aiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
  )
  const aiData = await aiRes.json()
  const aiText = aiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || ''
  if (!aiText) throw new Error('AI returned empty response')

  const parsed = parseAiPlanResponse(aiText)
  const now = new Date().toISOString()
  const results = []

  for (const userId of userIds) {
    const userPk = `USER#${userId}`
    // Check if session already exists
    const existing = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND sk = :sk',
      ExpressionAttributeValues: { ':pk': userPk, ':sk': `SESSION#${today}#${phase.phase}` },
    }))
    if (existing.Items?.length) { results.push({ userId, status: 'skipped' }); continue }

    const id = crypto.randomUUID()
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: { pk: userPk, sk: `SESSION#${today}#${phase.phase}`, id, date: today, phase: phase.phase, response: parsed.plan, watchList: parsed.watchList, notes: parsed.notes, createdAt: now },
    }))
    results.push({ userId, status: 'generated' })
  }

  return { phase: phase.phase, today, results }
}
