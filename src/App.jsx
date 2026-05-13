import { useEffect, useMemo, useRef, useState } from 'react'
import { createId, loadData, saveData } from './storage.js'

const VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'
const STARTING_CASH = 100000
const DEFAULT_PROMPT = `You are an intraday equity trader with $100,000 and zero commissions. Your goal is to maximize returns and exit all positions to cash by 4 PM ET.`
const RISK_VALUES = { Low: 1, Medium: 2, High: 3 }

function formatDate(date) {
  return date.toISOString().slice(0, 10)
}

function displayDate(value) {
  return new Date(value).toLocaleDateString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return null
  let gains = 0
  let losses = 0
  for (let i = prices.length - period; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1]
    if (change > 0) gains += change
    else losses += Math.abs(change)
  }
  const avgGain = gains / period
  const avgLoss = losses / period
  if (avgLoss === 0) return gains > 0 ? 100 : 0
  const rs = avgGain / avgLoss
  return 100 - (100 / (1 + rs))
}

function calculateMA(prices, period) {
  if (prices.length < period) return null
  const sum = prices.slice(-period).reduce((a, b) => a + b, 0)
  return sum / period
}

function getCurrentHour() {
  const now = new Date()
  return now.getHours() + now.getMinutes() / 60
}

function updateTradingPhase() {
  const hour = getCurrentHour()
  if (hour < 9.5) return 'pre-market'
  if (hour < 10.5) return 'opening-drive'
  if (hour < 15) return 'midday-fade'
  if (hour < 15.75) return 'power-hour'
  return 'after-hours'
}

const PHASE_SCHEDULE = [
  { phase: 'pre-market',    signalType: 'gapper',         startHour: 8.0,   endHour: 9.5,   label: 'Pre-Market Scan',  window: '8:00 – 9:30 AM',   description: 'Scan for gappers (3%+ move on high relative volume) and earnings reactions' },
  { phase: 'opening-drive', signalType: 'orb-breakout',   startHour: 9.5,   endHour: 10.5,  label: 'Opening Drive',    window: '9:30 – 10:30 AM',  description: 'ORB breakouts — enter on 15-min high break with volume confirmation. Four $25K blocks.' },
  { phase: 'midday-fade',   signalType: 'mean-reversion', startHour: 10.5,  endHour: 15.0,  label: 'Mid-Day Fade',     window: '10:30 AM – 3:00 PM', description: 'Mean reversion — RSI overbought (>70) short to MA20, oversold (<30) buy to MA20' },
  { phase: 'power-hour',    signalType: 'power-hour',     startHour: 15.0,  endHour: 15.75, label: 'Power Hour',       window: '3:00 – 3:45 PM',   description: 'Ride VWAP momentum on relative strength leaders. Begin position reduction.' },
  { phase: 'after-hours',   signalType: 'hard-exit',      startHour: 15.75, endHour: 16.0,  label: 'Hard Exit',        window: '3:45 PM',          description: 'SELL EVERYTHING — all positions to cash before 3:59 PM. No exceptions.' },
]

function detectGapper(symbol, yesterdayClose, currentPrice) {
  if (!yesterdayClose || !currentPrice) return 0
  const gapPercent = Math.abs((currentPrice - yesterdayClose) / yesterdayClose) * 100
  return gapPercent >= 3 ? gapPercent : 0
}

function detectORB(intraday, timeWindowMinutes = 15) {
  if (!intraday || intraday.length === 0) return null
  // intraday is sorted newest-first; opening bars are the oldest entries for today
  const todayPrefix = intraday[0].dateTime.slice(0, 10)
  const todayBars = intraday.filter((d) => d.dateTime.startsWith(todayPrefix)).reverse()
  if (todayBars.length === 0) return null
  const openingBars = todayBars.slice(0, Math.ceil(timeWindowMinutes / 5))
  if (openingBars.length === 0) return null
  const high = Math.max(...openingBars.map((d) => d.high))
  const low = Math.min(...openingBars.map((d) => d.low))
  const latestClose = intraday[0].close
  const avgOpeningVolume = openingBars.reduce((s, d) => s + d.volume, 0) / openingBars.length
  const latestVolume = intraday[0].volume
  const range = high - low
  return {
    high, low, range, latestClose,
    volumeConfirmed: avgOpeningVolume === 0 || latestVolume > avgOpeningVolume * 1.2,
    breakoutUp: latestClose > high * 0.995,
    breakoutDown: latestClose < low * 1.005,
  }
}

function calculateVWAP(intraday) {
  if (!intraday || intraday.length === 0) return null
  const todayPrefix = intraday[0].dateTime.slice(0, 10)
  const todayBars = intraday.filter((d) => d.dateTime.startsWith(todayPrefix))
  if (todayBars.length === 0) return null
  const totalVolume = todayBars.reduce((sum, d) => sum + d.volume, 0)
  if (totalVolume === 0) return null
  const tpv = todayBars.reduce((sum, d) => sum + ((d.high + d.low + d.close) / 3) * d.volume, 0)
  return tpv / totalVolume
}

function buildSignals(symbols, marketData) {
  const phase = updateTradingPhase()
  const signals = []

  for (const symbol of symbols) {
    const md = marketData[symbol]
    if (!md?.quote) continue
    const quote = md.quote
    const intraday = md.intraday || []
    const dailySeries = md.dailySeries || []

    if (phase === 'pre-market' && dailySeries.length > 0) {
      const gapPercent = detectGapper(symbol, dailySeries[0]?.close, quote.price)
      if (gapPercent > 0) {
        signals.push({
          id: createId(), symbol, type: 'gapper', value: gapPercent,
          message: `${symbol}: ${gapPercent.toFixed(1)}% gap at $${quote.price.toFixed(2)}`,
          action: 'Watch for entry on pullback after open',
          timestamp: new Date().toISOString(),
        })
      }
    }

    if (phase === 'opening-drive' && intraday.length > 2) {
      const orb = detectORB(intraday, 15)
      if (orb?.breakoutUp) {
        signals.push({
          id: createId(), symbol, type: 'orb-breakout', value: orb.range,
          message: `${symbol}: ORB breakout above $${orb.high.toFixed(2)} — close $${orb.latestClose.toFixed(2)}${orb.volumeConfirmed ? ' ✓ vol' : ' ⚠ low vol'}`,
          action: orb.volumeConfirmed ? 'BUY — volume confirmed breakout' : 'Watch — breakout lacks volume confirmation',
          timestamp: new Date().toISOString(),
        })
      }
    }

    if (phase === 'midday-fade' && intraday.length > 14) {
      const closes = intraday.map((d) => d.close)
      const rsi = calculateRSI(closes, 14)
      const ma20 = calculateMA(closes, 20)
      if (rsi !== null && rsi > 70 && ma20) {
        signals.push({
          id: createId(), symbol, type: 'mean-reversion', value: rsi,
          message: `${symbol}: Overbought RSI ${rsi.toFixed(1)} — MA20 $${ma20.toFixed(2)}`,
          action: 'SHORT for reversion to MA20',
          timestamp: new Date().toISOString(),
        })
      }
      if (rsi !== null && rsi < 30 && ma20) {
        signals.push({
          id: createId(), symbol, type: 'mean-reversion', value: rsi,
          message: `${symbol}: Oversold RSI ${rsi.toFixed(1)} — MA20 $${ma20.toFixed(2)}`,
          action: 'BUY for bounce to MA20',
          timestamp: new Date().toISOString(),
        })
      }
    }

    if (phase === 'power-hour') {
      const gain = ((quote.price - quote.previousClose) / quote.previousClose) * 100
      const vwap = intraday.length > 0 ? calculateVWAP(intraday) : null
      const aboveVwap = vwap !== null && quote.price > vwap
      if (gain > 1) {
        signals.push({
          id: createId(), symbol, type: 'power-hour', value: gain,
          message: `${symbol}: +${gain.toFixed(2)}% strength${vwap ? ` | VWAP $${vwap.toFixed(2)} — price ${aboveVwap ? '↑ above' : '↓ below'}` : ''}`,
          action: aboveVwap ? 'RIDE momentum (above VWAP)' : 'Caution — below VWAP, momentum may fade',
          timestamp: new Date().toISOString(),
        })
      }
    }

    if (phase === 'after-hours') {
      signals.push({
        id: createId(), symbol, type: 'hard-exit', value: 0,
        message: `${symbol}: SELL-EVERYTHING protocol`,
        action: 'LIQUIDATE all positions — hard stop 3:45 PM',
        timestamp: new Date().toISOString(),
      })
    }
  }

  return { signals, phase }
}

function parseWatchSymbols(text) {
  return (text || '')
    .split(/[,;|\s]+/)
    .map((token) => token.trim().toUpperCase().replace(/[^A-Z0-9.]/g, ''))
    .filter((token) => token.length > 0 && token.length <= 5)
}

function parseAiPlanResponse(text) {
  // Strip markdown bold/italic and leading bullets so patterns match cleanly
  const normalized = text
    .replace(/\r/g, '')
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .replace(/^[\s*#-]+/gm, (m) => m.replace(/[*#-]/g, ''))

  const planMatch = normalized.match(/Plan\s*[:]\s*([\s\S]*?)(?=(Watch\s*list|Watchlist|Tickers|Symbols|Notes|$))/i)
  const watchMatch = normalized.match(/(?:Watch\s*list|Watchlist|Tickers|Symbols)\s*[:]\s*([\s\S]*?)(?=(Notes|$))/i)
  const notesMatch = normalized.match(/Notes\s*[:]\s*([\s\S]*)/i)

  const plan = planMatch ? planMatch[1].trim() : normalized.trim()

  let watchList = ''
  if (watchMatch) {
    // Collapse newlines, strip bullet chars, normalise commas
    watchList = watchMatch[1]
      .trim()
      .replace(/[\r\n]+/g, ', ')
      .replace(/^[\s\-•*]+/gm, '')
      .replace(/\s*,\s*/g, ', ')
      .trim()
  }

  // Fallback: scan the full response for uppercase ticker-like tokens (2–5 caps)
  // if the structured section was empty or only had noise
  const symbols = parseWatchSymbols(watchList)
  if (symbols.length === 0) {
    const tickers = [...new Set(
      (normalized.match(/\b[A-Z]{2,5}\b/g) || [])
        .filter((t) => !['AM', 'PM', 'ET', 'THE', 'FOR', 'AND', 'ORB', 'RSI', 'VWAP', 'MA', 'ATH', 'ATL', 'IPO', 'EPS', 'CEO', 'US', 'TV'].includes(t))
    )].slice(0, 5)
    if (tickers.length > 0) watchList = tickers.join(', ')
  }

  const notes = notesMatch ? notesMatch[1].trim() : ''
  return { plan, watchList, notes }
}

function inferPlanAction(text) {
  const normalized = (text || '').toLowerCase()
  if (/(short|sell|exit|bearish|reduce|fade|trim|lighten|book profit|close position)/.test(normalized)) return 'Sell'
  if (/(buy|long|bullish|accumulate|add|buying|go long|strength|breakout|retest)/.test(normalized)) return 'Buy'
  return 'Buy'
}


function summarizePlan(plan) {
  const symbols = parseWatchSymbols(plan.watchList)
  const bias = inferPlanAction(plan.response || plan.watchList)
  const signal = /(breakout|momentum|strength|uptrend|rally)/i.test(plan.response)
    ? 'momentum/breakout focus'
    : /(dip|pullback|retest|mean reversion|support)/i.test(plan.response)
    ? 'pullback/support focus'
    : 'general directional bias'
  const symbolText = symbols.length ? symbols.join(', ') : 'watch list symbols'
  return `Interpreted as a ${bias.toLowerCase()} bias for ${symbolText} with a ${signal}.`
}

export default function App() {
  const today = formatDate(new Date())
  const [data, setData] = useState(() => {
    const loaded = loadData()
    return {
      dailyPlans: loaded.dailyPlans || [],
      trades: loaded.trades || [],
      marketData: loaded.marketData || {},
      executedSignals: loaded.executedSignals || [],
      activityLog: loaded.activityLog || [],
      settings: { languageModelProvider: loaded.settings?.languageModelProvider || 'gemini' },
    }
  })
  const [selectedDate, setSelectedDate] = useState(today)
  const [planDraft, setPlanDraft] = useState({ response: '', watchList: '', riskProfile: 'Medium', notes: '' })
  const [tradeDraft, setTradeDraft] = useState({ symbol: '', action: 'Buy', quantity: '', entryPrice: '', exitPrice: '', riskRating: 'Medium', notes: '' })
  const [marketSymbol, setMarketSymbol] = useState('')
  const [intradayInterval] = useState('5min')
  const [marketStatus, setMarketStatus] = useState('')
  const [planStatus, setPlanStatus] = useState('')
  const [marketLoading, setMarketLoading] = useState(false)
  const [liveSignals, setLiveSignals] = useState([])
  const [watchMetrics, setWatchMetrics] = useState([])
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'light')
  function toggleTheme() {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark'
      localStorage.setItem('theme', next)
      return next
    })
  }
  const [tradingPhase, setTradingPhase] = useState(updateTradingPhase)
  const [lastAutoScan, setLastAutoScan] = useState(null)
  const dataRef = useRef(null)
  const marketDataRef = useRef({})
  const refreshAndScanRef = useRef(null)

  useEffect(() => {
    saveData(data)
  }, [data])

  useEffect(() => {
    dataRef.current = data
    marketDataRef.current = data.marketData
  }, [data])

  const dailyPlan = useMemo(
    () => data.dailyPlans.find((plan) => plan.date === selectedDate),
    [data.dailyPlans, selectedDate],
  )

  const dailyTrades = useMemo(
    () => data.trades.filter((trade) => trade.date === selectedDate),
    [data.trades, selectedDate],
  )

  const planInterpretation = useMemo(
    () => (dailyPlan ? summarizePlan(dailyPlan) : ''),
    [dailyPlan],
  )

  const history = useMemo(() => {
    const dates = [...new Set(data.dailyPlans.map((plan) => plan.date).concat(data.trades.map((trade) => trade.date)))]
      .sort()
      .reverse()
    return dates.slice(0, 14)
  }, [data.dailyPlans, data.trades])

  const pendingDecisions = useMemo(() => {
    const todayLog = (data.activityLog || []).filter((e) => e.date === selectedDate)
    const currentPhaseIndex = PHASE_SCHEDULE.findIndex((p) => p.phase === tradingPhase)
    return PHASE_SCHEDULE.map((phase, i) => ({
      ...phase,
      status: i < currentPhaseIndex ? 'completed' : i === currentPhaseIndex ? 'active' : 'pending',
      events: todayLog.filter((e) => e.type === phase.signalType),
    }))
  }, [data.activityLog, selectedDate, tradingPhase])

  // Auto-extract symbols when a plan exists but has no watch list
  useEffect(() => {
    if (!dailyPlan) { setPlanStatus('DEBUG auto-extract: no dailyPlan'); return }
    if (dailyPlan.watchList.trim()) { setPlanStatus(`DEBUG auto-extract: skipped — watchList already set: "${dailyPlan.watchList}"`); return }
    if (selectedDate !== today) { setPlanStatus(`DEBUG auto-extract: skipped — selectedDate ${selectedDate} !== today ${today}`); return }
    const provider = dataRef.current?.settings?.languageModelProvider || 'gemini'
    const planText = dailyPlan.response
    setPlanStatus('DEBUG auto-extract: fetching movers + calling AI...')

    // Fetch live movers first, then ask AI to pick symbols from them
    fetch('/api/market?type=movers')
      .then((r) => (r.ok ? r.json() : null))
      .then((movers) => {
        let moversContext = ''
        if (movers) {
          const fmt = (list) => list.map((s) => `${s.symbol} ${s.changePercent} @ $${s.price.toFixed(2)}`).join(', ')
          moversContext = `\n\nLive market movers today:\nGainers: ${fmt(movers.gainers)}\nLosers: ${fmt(movers.losers)}\nMost active: ${fmt(movers.mostActive)}`
        }
        setPlanStatus(`DEBUG auto-extract: movers loaded (${movers ? 'ok' : 'null'}), calling AI with provider=${provider}...`)
        return fetch('/api/ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider,
            prompt: `Today is ${selectedDate}.${moversContext}\n\nBased on the live market data above and the following trading strategy, choose the 3-5 best specific ticker symbols to trade today.\n\nStrategy:\n${planText}\n\nReturn ONLY a comma-separated list of ticker symbols. Example: NVDA, TSLA, AAPL`,
          }),
        })
      })
      .then(async (r) => {
        const body = await r?.json().catch(() => null)
        if (!r?.ok) {
          setPlanStatus(`DEBUG auto-extract: AI FAILED status=${r?.status} — ${JSON.stringify(body)}`)
          return null
        }
        return body
      })
      .then((result) => {
        const symbols = parseWatchSymbols(result?.text || '')
        setPlanStatus(`DEBUG auto-extract: AI text="${result?.text}" → symbols=[${symbols.join(', ')}]`)
        if (symbols.length === 0) return
        setData((current) => ({
          ...current,
          dailyPlans: current.dailyPlans.map((p) =>
            p.id === dailyPlan.id ? { ...p, watchList: symbols.join(', ') } : p,
          ),
        }))
        setPlanStatus(`Watch list auto-populated: ${symbols.join(', ')}`)
      })
      .catch((err) => setPlanStatus(`DEBUG auto-extract ERROR: ${err?.message || err}`))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dailyPlan?.id])

  function submitPlan(event) {
    event.preventDefault()
    const plan = {
      id: createId(),
      date: selectedDate,
      prompt: DEFAULT_PROMPT,
      response: planDraft.response.trim(),
      watchList: planDraft.watchList.trim() || parseAiPlanResponse(planDraft.response.trim()).watchList,
      riskProfile: planDraft.riskProfile,
      notes: planDraft.notes.trim(),
      createdAt: new Date().toISOString(),
    }
    if (!plan.response) return
    const parsedDebug = parseAiPlanResponse(plan.response)
    setPlanStatus(`DEBUG submitPlan — watchList="${plan.watchList}" | parsed.watchList="${parsedDebug.watchList}" | response length=${plan.response.length}`)
    setData((current) => ({
      ...current,
      dailyPlans: [...current.dailyPlans.filter((item) => item.date !== selectedDate), plan],
    }))
    setPlanDraft({ response: '', watchList: '', riskProfile: 'Medium', notes: '' })
  }

  function submitTrade(event) {
    event.preventDefault()
    const trade = {
      id: createId(),
      date: selectedDate,
      symbol: tradeDraft.symbol.trim().toUpperCase(),
      action: tradeDraft.action,
      quantity: Number(tradeDraft.quantity),
      entryPrice: Number(tradeDraft.entryPrice),
      exitPrice: Number(tradeDraft.exitPrice),
      riskRating: tradeDraft.riskRating,
      notes: tradeDraft.notes.trim(),
      createdAt: new Date().toISOString(),
    }
    if (!trade.symbol || !trade.quantity || !trade.entryPrice || !trade.exitPrice) return
    setData((current) => ({
      ...current,
      trades: [...current.trades, trade],
    }))
    setTradeDraft({ symbol: '', action: 'Buy', quantity: '', entryPrice: '', exitPrice: '', riskRating: 'Medium', notes: '' })
  }

  function deleteTrade(tradeId) {
    setData((current) => ({
      ...current,
      trades: current.trades.filter((trade) => trade.id !== tradeId),
    }))
  }

  function clearDailyPlan() {
    setData((current) => ({
      ...current,
      dailyPlans: current.dailyPlans.filter((plan) => plan.date !== selectedDate),
    }))
    setPlanStatus('')
  }

  async function fetchMarketQuote() {
    const symbol = (marketSymbol || tradeDraft.symbol).trim().toUpperCase()
    if (!symbol) {
      setMarketStatus('Enter a symbol to fetch market data.')
      return
    }
    setMarketStatus(`Fetching quote for ${symbol}...`)
    setMarketLoading(true)
    try {
      const response = await fetch(`/api/market?type=quote&symbol=${encodeURIComponent(symbol)}`)
      if (!response.ok) {
        const errorData = await response.json().catch(() => null)
        throw new Error(errorData?.error || 'Could not fetch quote.')
      }
      const quote = await response.json()
      setData((current) => ({
        ...current,
        marketData: {
          ...current.marketData,
          [symbol]: {
            ...(current.marketData[symbol] || {}),
            quote,
          },
        },
      }))
      setMarketStatus(`Quote loaded for ${symbol}.`)
      setMarketSymbol(symbol)
    } catch (error) {
      setMarketStatus(error.message || 'Could not fetch quote.')
    } finally {
      setMarketLoading(false)
    }
  }

  async function fetchMarketHistory() {
    const symbol = (marketSymbol || tradeDraft.symbol).trim().toUpperCase()
    if (!symbol) {
      setMarketStatus('Enter a symbol to load daily history.')
      return
    }
    setMarketStatus(`Loading daily series for ${symbol}...`)
    setMarketLoading(true)
    try {
      const response = await fetch(`/api/market?type=daily&symbol=${encodeURIComponent(symbol)}`)
      if (!response.ok) {
        const errorData = await response.json().catch(() => null)
        throw new Error(errorData?.error || 'Could not load history.')
      }
      const dailySeries = await response.json()
      setData((current) => ({
        ...current,
        marketData: {
          ...current.marketData,
          [symbol]: {
            ...(current.marketData[symbol] || {}),
            dailySeries,
          },
        },
      }))
      setMarketStatus(`Daily series loaded for ${symbol}.`)
      setMarketSymbol(symbol)
    } catch (error) {
      setMarketStatus(error.message || 'Could not load history.')
    } finally {
      setMarketLoading(false)
    }
  }

  async function fetchMarketIntraday() {
    const symbol = (marketSymbol || tradeDraft.symbol).trim().toUpperCase()
    if (!symbol) {
      setMarketStatus('Enter a symbol to load intraday data.')
      return
    }
    setMarketStatus(`Loading intraday series for ${symbol} at ${intradayInterval}...`)
    setMarketLoading(true)
    try {
      const response = await fetch(`/api/market?type=intraday&symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(intradayInterval)}`)
      if (!response.ok) {
        const errorData = await response.json().catch(() => null)
        throw new Error(errorData?.error || 'Could not load intraday history.')
      }
      const intraday = await response.json()
      setData((current) => ({
        ...current,
        marketData: {
          ...current.marketData,
          [symbol]: {
            ...(current.marketData[symbol] || {}),
            intraday,
          },
        },
      }))
      setMarketStatus(`Intraday series loaded for ${symbol}.`)
      setMarketSymbol(symbol)
    } catch (error) {
      setMarketStatus(error.message || 'Could not load intraday history.')
    } finally {
      setMarketLoading(false)
    }
  }

  function fillTradePrices() {
    const symbol = tradeDraft.symbol.trim().toUpperCase()
    const saved = data.marketData[symbol]
    if (!saved?.quote) {
      setMarketStatus('Fetch a quote first to fill trade prices.')
      return
    }
    setTradeDraft((prev) => ({
      ...prev,
      entryPrice: prev.entryPrice || saved.quote.price.toFixed(2),
      exitPrice: prev.exitPrice || saved.quote.price.toFixed(2),
    }))
    setMarketStatus(`Filled trade prices with ${symbol} latest quote.`)
  }


  function autoExecuteSignals(signals, phase, freshMarketData, todayStr) {
    const current = dataRef.current
    if (!current) return

    const doneKeys = new Set(
      (current.executedSignals || [])
        .filter((es) => es.date === todayStr)
        .map((es) => `${es.symbol}|${es.type}`),
    )

    const newTrades = []
    const newExecuted = []
    const newLog = []
    const now = new Date().toISOString()
    const planRisk = (current.dailyPlans || []).find((p) => p.date === todayStr)?.riskProfile || 'Medium'

    for (const signal of signals) {
      if (signal.type === 'hard-exit') continue
      const key = `${signal.symbol}|${signal.type}`
      if (doneKeys.has(key)) continue
      const md = freshMarketData[signal.symbol]
      if (!md?.quote) continue

      const entryPrice = md.quote.price
      const action = signal.type === 'mean-reversion' && signal.value > 50 ? 'Sell' : 'Buy'
      const exitPrice = action === 'Buy' ? entryPrice * 1.015 : entryPrice * 0.985
      const quantity = Math.max(1, Math.floor((STARTING_CASH / 4) / entryPrice))

      const trade = {
        id: createId(),
        date: todayStr,
        symbol: signal.symbol,
        action,
        quantity,
        entryPrice,
        exitPrice,
        riskRating: planRisk,
        notes: `Auto [${signal.type}]: ${signal.message}`,
        createdAt: now,
      }
      newTrades.push(trade)
      newExecuted.push({ date: todayStr, symbol: signal.symbol, type: signal.type, timestamp: now })
      newLog.push({
        id: createId(),
        date: todayStr,
        timestamp: now,
        type: signal.type,
        symbol: signal.symbol,
        message: `${signal.symbol} — ${action} ${quantity} shares @ $${entryPrice.toFixed(2)}`,
        detail: signal.action,
      })
    }

    // Hard exit: update all today's auto trades' exit prices to current market price
    const alreadyHardExited = (current.executedSignals || []).some(
      (es) => es.date === todayStr && es.type === 'hard-exit',
    )
    let finalTrades = [...current.trades, ...newTrades]
    if (phase === 'after-hours' && !alreadyHardExited) {
      finalTrades = finalTrades.map((trade) => {
        if (trade.date !== todayStr || !trade.notes?.startsWith('Auto')) return trade
        const livePrice = freshMarketData[trade.symbol]?.quote?.price
        return livePrice ? { ...trade, exitPrice: livePrice } : trade
      })
      const closedCount = finalTrades.filter((t) => t.date === todayStr && t.notes?.startsWith('Auto')).length
      newExecuted.push({ date: todayStr, symbol: '*', type: 'hard-exit', timestamp: now })
      if (closedCount > 0) {
        newLog.push({
          id: createId(),
          date: todayStr,
          timestamp: now,
          type: 'hard-exit',
          symbol: '*',
          message: `HARD EXIT — ${closedCount} position${closedCount !== 1 ? 's' : ''} closed at market price`,
          detail: 'Sell-everything protocol executed at 3:45 PM',
        })
      }
    }

    if (newTrades.length === 0 && newExecuted.length === 0) return

    setData((prev) => ({
      ...prev,
      marketData: freshMarketData,
      trades: finalTrades,
      executedSignals: [...(prev.executedSignals || []), ...newExecuted],
      activityLog: [...(prev.activityLog || []).slice(-200), ...newLog],
    }))
  }

  async function refreshAndScan() {
    const current = dataRef.current
    const watchList = current?.dailyPlans?.find((p) => p.date === selectedDate)?.watchList || ''
    const symbols = parseWatchSymbols(watchList)
    if (symbols.length === 0) { setPlanStatus('Scan: no symbols in watch list'); return }

    setPlanStatus(`Scanning ${symbols.join(', ')}...`)
    const updatedMarketData = { ...marketDataRef.current }
    for (const symbol of symbols) {
      try {
        const [intradayRes, quoteRes] = await Promise.all([
          fetch(`/api/market?type=intraday&symbol=${encodeURIComponent(symbol)}&interval=5min`),
          fetch(`/api/market?type=quote&symbol=${encodeURIComponent(symbol)}`),
        ])
        updatedMarketData[symbol] = {
          ...(updatedMarketData[symbol] || {}),
          ...(intradayRes.ok ? { intraday: await intradayRes.json() } : {}),
          ...(quoteRes.ok ? { quote: await quoteRes.json() } : {}),
        }
      } catch {
        // skip symbol on error
      }
    }

    const { signals, phase } = buildSignals(symbols, updatedMarketData)
    setTradingPhase(phase)
    setLiveSignals(signals)
    autoExecuteSignals(signals, phase, updatedMarketData, selectedDate)
    setLastAutoScan(new Date().toISOString())
    setPlanStatus(`Scan complete — phase: ${phase} — ${signals.length} signal(s) found for ${symbols.join(', ')}`)

    const metrics = []
    for (const symbol of symbols) {
      const md = updatedMarketData[symbol]
      if (!md) continue
      if (phase === 'pre-market' && md.quote && md.dailySeries?.length > 0) {
        const raw = ((md.quote.price - md.dailySeries[0].close) / md.dailySeries[0].close) * 100
        metrics.push({ symbol, label: 'Gap', value: raw, min: -10, max: 10, lowThreshold: -3, highThreshold: 3, unit: '%' })
      } else if (phase === 'opening-drive' && md.intraday?.length > 0 && md.quote) {
        const orb = detectORB(md.intraday, 15)
        if (orb) {
          const distPct = ((md.quote.price - orb.high) / orb.high) * 100
          metrics.push({ symbol, label: 'vs ORB High', value: distPct, min: -5, max: 5, lowThreshold: -0.5, highThreshold: 0, unit: '%' })
        }
      } else if (phase === 'midday-fade' && md.intraday?.length > 0) {
        const closes = md.intraday.map((d) => d.close)
        const rsi = calculateRSI(closes, 14)
        if (rsi !== null) metrics.push({ symbol, label: 'RSI', value: rsi, min: 0, max: 100, lowThreshold: 30, highThreshold: 70, unit: '' })
      } else if (phase === 'power-hour' && md.quote) {
        const gain = ((md.quote.price - md.quote.previousClose) / md.quote.previousClose) * 100
        metrics.push({ symbol, label: 'Day gain', value: gain, min: -3, max: 5, lowThreshold: -1, highThreshold: 1, unit: '%' })
      }
    }
    setWatchMetrics(metrics)
  }

  // Keep ref current so the interval always calls the latest version without stale closure
  useEffect(() => { refreshAndScanRef.current = refreshAndScan })

  useEffect(() => {
    if (!dailyPlan || selectedDate !== today) return
    // Scan immediately so the user doesn't wait up to 5 minutes
    refreshAndScanRef.current?.()
    // Then keep scanning every 5 minutes; market-hours guard stays inside the callback
    const intervalId = setInterval(() => {
      refreshAndScanRef.current?.()
    }, 5 * 60 * 1000)
    return () => clearInterval(intervalId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dailyPlan?.id, selectedDate])

  async function buildEnrichedPrompt() {
    let moversContext = ''
    try {
      const moversRes = await fetch('/api/market?type=movers')
      if (moversRes.ok) {
        const movers = await moversRes.json()
        const fmt = (list) => list.map((s) => `${s.symbol} ${s.changePercent} @ $${s.price.toFixed(2)} vol ${(s.volume / 1e6).toFixed(1)}M`).join(', ')
        moversContext = `\n\nLIVE MARKET DATA for ${selectedDate}:\nTop gainers: ${fmt(movers.gainers)}\nTop losers: ${fmt(movers.losers)}\nMost active: ${fmt(movers.mostActive)}`
      }
    } catch {
      // proceed without movers if fetch fails
    }
    return `${DEFAULT_PROMPT}${moversContext}\n\nToday is ${selectedDate}. Using the live market data above, identify the best intraday opportunities and provide a specific trading plan.\n\nFormat your reply EXACTLY as follows — no other sections:\nPlan: [2-3 sentence strategy based on the specific movers above]\nWatch list: [3-5 specific ticker symbols chosen from the movers above, comma-separated]\nNotes: [key price levels, why each symbol, stop loss at 1.5%, hard exit 3:45 PM]`
  }

  async function copyEnrichedPrompt() {
    setMarketLoading(true)
    setPlanStatus('Fetching live data...')
    try {
      const prompt = await buildEnrichedPrompt()
      await navigator.clipboard.writeText(prompt)
      setPlanStatus('Prompt copied — paste it into Gemini, then paste the response into the plan field below.')
    } catch {
      setPlanStatus('Could not copy to clipboard.')
    } finally {
      setMarketLoading(false)
    }
  }

  async function generateMorningPlanFromAI() {
    const provider = data.settings.languageModelProvider || 'gemini'
    setMarketLoading(true)
    setPlanStatus('Fetching live market movers...')

    try {
      setPlanStatus('Generating plan from AI...')
      const prompt = await buildEnrichedPrompt()
      const response = await fetch('/api/ai', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider,
          prompt,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => null)
        throw new Error(errorData?.error || 'AI plan generation failed.')
      }

      const result = await response.json()
      const aiText = result?.text?.trim() || ''
      if (!aiText) {
        throw new Error('AI returned an empty response.')
      }

      const parsed = parseAiPlanResponse(aiText)
      const plan = {
        id: createId(),
        date: selectedDate,
        prompt: DEFAULT_PROMPT,
        response: parsed.plan,
        watchList: parsed.watchList,
        riskProfile: 'Medium',
        notes: parsed.notes,
        createdAt: new Date().toISOString(),
      }

      setData((current) => ({
        ...current,
        dailyPlans: [...current.dailyPlans.filter((item) => item.date !== selectedDate), plan],
      }))
      setPlanStatus('Morning plan generated and saved from AI.')
    } catch (error) {
      setPlanStatus(error.message || 'Could not generate a plan from AI.')
    } finally {
      setMarketLoading(false)
    }
  }




  function computeTradePL(trade) {
    const direction = trade.action === 'Sell' ? -1 : 1
    return direction * trade.quantity * (trade.exitPrice - trade.entryPrice)
  }

  function computeMetrics(date) {
    const tradesForDate = data.trades.filter((trade) => trade.date === date)
    const totalPL = tradesForDate.reduce((sum, trade) => sum + computeTradePL(trade), 0)
    const totalRiskScore = tradesForDate.reduce((sum, trade) => sum + (RISK_VALUES[trade.riskRating] || 1), 0)
    const reward = tradesForDate.reduce((sum, trade) => sum + Math.max(0, computeTradePL(trade)), 0)
    const risk = totalRiskScore === 0 ? 0 : tradesForDate.reduce((sum, trade) => sum + Math.abs(computeTradePL(trade)) * (RISK_VALUES[trade.riskRating] || 1), 0)
    const riskReward = totalRiskScore === 0 ? 0 : Number((totalPL / totalRiskScore).toFixed(2))
    return {
      totalPL,
      trades: tradesForDate.length,
      avgRiskRating: tradesForDate.length
        ? (totalRiskScore / tradesForDate.length).toFixed(2)
        : '—',
      riskReward,
      reward,
      risk,
    }
  }

  function escapeCsv(value) {
    if (value === null || value === undefined) return ''
    const text = String(value)
    return text.includes(',') || text.includes('"') || text.includes('\n')
      ? `"${text.replace(/"/g, '""')}"`
      : text
  }

  function downloadCsv(filename, rows) {
    const csv = rows.map((row) => row.map(escapeCsv).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.setAttribute('download', filename)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  function exportDayCsv() {
    const rows = [['Date', selectedDate], ['Section', 'Field', 'Value'], []]
    if (dailyPlan) {
      rows.push(['Morning plan', 'Response', dailyPlan.response])
      rows.push(['Morning plan', 'Watch list', dailyPlan.watchList])
      rows.push(['Morning plan', 'Risk profile', dailyPlan.riskProfile])
      rows.push(['Morning plan', 'Notes', dailyPlan.notes])
      rows.push([])
    }
    rows.push(['Trades', 'Symbol', 'Action', 'Quantity', 'Entry', 'Exit', 'P/L', 'Risk', 'Notes'])
    dailyTrades.forEach((trade) => {
      rows.push([
        '',
        trade.symbol,
        trade.action,
        trade.quantity,
        trade.entryPrice.toFixed(2),
        trade.exitPrice.toFixed(2),
        computeTradePL(trade).toFixed(2),
        trade.riskRating,
        trade.notes,
      ])
    })
    downloadCsv(`momoney-trades-${selectedDate}.csv`, rows)
  }

  function exportAllCsv() {
    const rows = [['Type', 'Date', 'Symbol', 'Action', 'Quantity', 'Entry', 'Exit', 'P/L', 'Risk', 'Notes', 'Plan response', 'Watch list', 'Risk profile', 'Plan notes']]
    const plansByDate = Object.fromEntries(data.dailyPlans.map((plan) => [plan.date, plan]))
    data.trades.forEach((trade) => {
      const plan = plansByDate[trade.date]
      rows.push([
        'Trade',
        trade.date,
        trade.symbol,
        trade.action,
        trade.quantity,
        trade.entryPrice.toFixed(2),
        trade.exitPrice.toFixed(2),
        computeTradePL(trade).toFixed(2),
        trade.riskRating,
        trade.notes,
        plan?.response || '',
        plan?.watchList || '',
        plan?.riskProfile || '',
        plan?.notes || '',
      ])
    })
    downloadCsv('momoney-all-trades.csv', rows)
  }

  const marketKey = (marketSymbol || tradeDraft.symbol).trim().toUpperCase()
  const currentMarketData = data.marketData[marketKey] || null
  const currentQuote = currentMarketData?.quote

  const currentIntraday = currentMarketData?.intraday || []
  const todaysMetrics = computeMetrics(selectedDate)
  const dk = theme === 'dark'
  const t = {
    app:        dk ? 'min-h-screen bg-slate-950 text-slate-100 px-4 py-6'    : 'min-h-screen bg-gray-100 text-gray-900 px-4 py-6',
    card:       dk ? 'rounded-3xl border border-slate-800 bg-slate-900/90'   : 'rounded-3xl border border-gray-200 bg-white',
    cardInner:  dk ? 'bg-slate-950/80'                                        : 'bg-gray-50',
    input:      dk ? 'bg-slate-900/80 border-slate-700 text-slate-200'       : 'bg-gray-50 border-gray-300 text-gray-800',
    heading:    dk ? 'text-white'       : 'text-gray-900',
    body:       dk ? 'text-slate-200'   : 'text-gray-700',
    muted:      dk ? 'text-slate-400'   : 'text-gray-500',
    faint:      dk ? 'text-slate-500'   : 'text-gray-400',
    divider:    dk ? 'border-slate-800' : 'border-gray-200',
    // badges
    bAmber:     dk ? 'bg-amber-600/20 text-amber-300 border-amber-600/40'   : 'bg-amber-100 text-amber-700 border-amber-300',
    bGreen:     dk ? 'bg-green-500/20 text-green-300'                        : 'bg-green-100 text-green-700',
    bBlue:      dk ? 'bg-blue-500/20 text-blue-300'                          : 'bg-blue-100 text-blue-700',
    bOrange:    dk ? 'bg-orange-500/20 text-orange-300'                      : 'bg-orange-100 text-orange-700',
    bCyan:      dk ? 'bg-cyan-500/20 text-cyan-300'                          : 'bg-cyan-100 text-cyan-700',
    bRed:       dk ? 'bg-red-500/20 text-red-300'                            : 'bg-red-100 text-red-700',
    bIndigo:    dk ? 'bg-indigo-500/20 text-indigo-300'                      : 'bg-indigo-100 text-indigo-700',
    bGray:      dk ? 'bg-gray-300/40 text-gray-400'                          : 'bg-gray-200 text-gray-600',
    // signal & activity cards
    sigGapper:  dk ? 'border-green-800/50 bg-green-950/30'  : 'border-green-300 bg-green-50',
    sigOrb:     dk ? 'border-blue-800/50 bg-blue-950/30'    : 'border-blue-300 bg-blue-50',
    sigMean:    dk ? 'border-orange-800/50 bg-orange-950/30': 'border-orange-300 bg-orange-50',
    sigPower:   dk ? 'border-cyan-800/50 bg-cyan-950/30'    : 'border-cyan-300 bg-cyan-50',
    sigExit:    dk ? 'border-red-800/50 bg-red-950/30'      : 'border-red-300 bg-red-50',
    actGapper:  dk ? 'bg-green-950/30 border border-green-800/30'   : 'bg-green-50 border border-green-200',
    actOrb:     dk ? 'bg-blue-950/30 border border-blue-800/30'     : 'bg-blue-50 border border-blue-200',
    actMean:    dk ? 'bg-orange-950/30 border border-orange-800/30' : 'bg-orange-50 border border-orange-200',
    actPower:   dk ? 'bg-cyan-950/30 border border-cyan-800/30'     : 'bg-cyan-50 border border-cyan-200',
    actExit:    dk ? 'bg-red-950/40 border border-red-800/40'       : 'bg-red-50 border border-red-200',
    actTrade:   dk ? 'bg-slate-800/40 border border-slate-700'      : 'bg-gray-100 border border-gray-200',
    // controls
    btnScan:    dk ? 'bg-amber-600/20 border border-amber-600/40 text-amber-300 hover:bg-amber-600/30' : 'bg-amber-100 border border-amber-300 text-amber-700 hover:bg-amber-200',
    btnDel:     dk ? 'bg-rose-500/20 text-rose-300 hover:bg-rose-500/40' : 'bg-rose-100 text-rose-700 hover:bg-rose-200',
    // plan decisions
    decActive:    dk ? 'border-amber-600/50 bg-amber-950/20'        : 'border-amber-400 bg-amber-50',
    decCompleted: dk ? 'border-slate-700 bg-slate-800/40 opacity-50': 'border-gray-200 bg-gray-100 opacity-50',
    decPending:   dk ? 'border-slate-700/40 bg-transparent'         : 'border-gray-200 bg-transparent',
    // values
    statValue:  dk ? 'font-semibold text-white'      : 'font-semibold text-gray-900',
    vwapValue:  dk ? 'font-semibold text-cyan-300'   : 'font-semibold text-cyan-700',
    plGain:     dk ? 'text-emerald-400' : 'text-emerald-600',
    plLoss:     dk ? 'text-rose-400'    : 'text-rose-600',
    planStatus: dk ? 'text-amber-400'   : 'text-amber-600',
  }

  return (
    <div className={t.app}>
      <div className="mx-auto max-w-7xl space-y-6">
        {/* ── Header: glanceable KPI ── */}
        <header className={`${t.card} p-5 shadow-xl`}>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-baseline gap-3">
              <h1 className={`text-xl font-semibold ${t.heading}`}>momoney</h1>
              <span className={`text-xs ${t.faint}`}>v{VERSION}</span>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className={`rounded-2xl px-4 py-2 text-lg font-bold ${todaysMetrics.totalPL >= 0 ? `bg-emerald-500/15 ${t.plGain}` : `bg-rose-500/15 ${t.plLoss}`}`}>
                {todaysMetrics.totalPL >= 0 ? '+' : ''}{todaysMetrics.totalPL.toFixed(2)}
              </div>
              <div className={`rounded-2xl ${dk ? 'bg-slate-800 text-slate-300' : 'bg-gray-200 text-gray-600'} px-4 py-2 text-sm`}>
                {todaysMetrics.trades} trade{todaysMetrics.trades !== 1 ? 's' : ''}
              </div>
              <div className={`rounded-2xl ${dk ? 'bg-slate-800 text-slate-300' : 'bg-gray-200 text-gray-600'} px-4 py-2 text-sm capitalize`}>
                {tradingPhase.replace(/-/g, ' ')}
              </div>
              {lastAutoScan && (
                <div className={`rounded-2xl ${dk ? 'bg-slate-800 text-slate-400' : 'bg-gray-200 text-gray-500'} px-4 py-2 text-xs`}>
                  scanned {new Date(lastAutoScan).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              )}
              <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} className={`rounded-2xl ${t.input} border px-3 py-2 text-sm outline-none`} />
              <button type="button" onClick={toggleTheme} className={`rounded-2xl ${dk ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-gray-200 text-gray-600 hover:bg-gray-300'} px-3 py-2 text-sm transition`}>
                {dk ? '☀ Light' : '☾ Dark'}
              </button>
            </div>
          </div>
        </header>

        {/* ── Pending Decisions ── */}
        <section className={`${t.card} p-5`}>
          <div className="flex items-center justify-between gap-4">
            <h2 className={`text-base font-semibold ${t.heading}`}>Pending decisions</h2>
            <span className={`shrink-0 text-xs ${t.faint}`}>{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ET</span>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-5">
            {pendingDecisions.map((decision) => (
              <div key={decision.phase} className={`rounded-2xl border p-3 ${
                decision.status === 'active'    ? t.decActive :
                decision.status === 'completed' ? t.decCompleted :
                                                  t.decPending
              }`}>
                <div className="flex items-start justify-between gap-1">
                  <div className="min-w-0">
                    <p className={`text-xs ${t.faint} font-mono leading-tight`}>{decision.window}</p>
                    <p className={`mt-1 text-sm font-semibold leading-tight ${decision.status === 'active' ? t.heading : t.muted}`}>{decision.label}</p>
                    {decision.events.length > 0 && (
                      <p className="mt-1 text-xs text-emerald-400">{decision.events.length} trade{decision.events.length !== 1 ? 's' : ''}</p>
                    )}
                  </div>
                  <div className={`shrink-0 w-2 h-2 rounded-full mt-1 ${
                    decision.status === 'active' ? 'bg-amber-400 animate-pulse' :
                    decision.status === 'completed' ? 'bg-emerald-500' : 'bg-gray-400'
                  }`} />
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── Activity Log ── */}
        {(() => {
          const todayLog = (data.activityLog || []).filter((e) => e.date === selectedDate).slice().reverse()
          if (todayLog.length === 0) return null
          return (
            <section className={`${t.card} p-5`}>
              <div className="flex items-center justify-between gap-4">
                <h2 className={`text-base font-semibold ${t.heading}`}>Activity log</h2>
                <span className={`text-xs ${t.faint}`}>{todayLog.length} event{todayLog.length !== 1 ? 's' : ''} today</span>
              </div>
              <div className="mt-4 space-y-2 max-h-56 overflow-y-auto">
                {todayLog.map((entry) => (
                  <div key={entry.id} className={`flex items-start gap-3 rounded-xl p-2.5 ${
                    entry.type === 'hard-exit'      ? t.actExit :
                    entry.type === 'orb-breakout'   ? t.actOrb :
                    entry.type === 'gapper'         ? t.actGapper :
                    entry.type === 'mean-reversion' ? t.actMean :
                    entry.type === 'power-hour'     ? t.actPower :
                    t.actTrade
                  }`}>
                    <span className={`shrink-0 text-xs ${t.faint} font-mono pt-0.5`}>{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm ${t.heading}`}>{entry.message}</p>
                      {entry.detail && <p className={`text-xs ${t.muted}`}>{entry.detail}</p>}
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                      entry.type === 'hard-exit'      ? t.bRed :
                      entry.type === 'orb-breakout'   ? t.bBlue :
                      entry.type === 'gapper'         ? t.bGreen :
                      entry.type === 'mean-reversion' ? t.bOrange :
                      entry.type === 'power-hour'     ? t.bCyan :
                      t.bGray
                    }`}>{entry.type?.replace(/-/g, ' ')}</span>
                  </div>
                ))}
              </div>
            </section>
          )
        })()}

        {/* ── Trade Table ── */}
        <section className={`${t.card} p-5`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className={`text-base font-semibold ${t.heading}`}>Trades — {displayDate(selectedDate)}</h2>
            <div className="flex gap-2">
              <button type="button" onClick={exportDayCsv} className="rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500">Export day</button>
              <button type="button" onClick={exportAllCsv} className={`rounded-xl ${dk ? 'bg-slate-700 text-slate-200' : 'bg-gray-300 text-gray-700'} px-3 py-1.5 text-xs font-semibold transition hover:opacity-80`}>Export all</button>
            </div>
          </div>
          <div className={`mt-4 overflow-x-auto rounded-2xl border ${t.divider} ${dk ? 'bg-slate-900/60' : 'bg-white'}`}>
            <table className="min-w-full border-collapse text-left text-sm">
              <thead className={`${dk ? 'bg-slate-800 text-slate-400' : 'bg-gray-50 text-gray-500'}`}>
                <tr>
                  <th className="px-4 py-2.5">Symbol</th>
                  <th className="px-4 py-2.5">Action</th>
                  <th className="px-4 py-2.5">Qty</th>
                  <th className="px-4 py-2.5">Entry</th>
                  <th className="px-4 py-2.5">Exit</th>
                  <th className="px-4 py-2.5">P/L</th>
                  <th className="px-4 py-2.5">Risk</th>
                  <th className="px-4 py-2.5">Notes</th>
                  <th className="px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {dailyTrades.length === 0 ? (
                  <tr><td colSpan="9" className="px-4 py-8 text-center text-gray-400">No trades yet — auto-trades will appear here as signals fire.</td></tr>
                ) : (
                  dailyTrades.map((trade) => {
                    const pl = computeTradePL(trade)
                    const isAuto = trade.notes?.startsWith('Auto')
                    return (
                      <tr key={trade.id} className={`border-t border-gray-200 ${isAuto ? 'bg-gray-100/60' : ''}`}>
                        <td className="px-4 py-2.5 text-gray-900">
                          <div className="flex items-center gap-2">
                            {trade.symbol}
                            {isAuto && <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${t.bIndigo}`}>auto</span>}
                          </div>
                        </td>
                        <td className={`px-4 py-2.5 ${t.body}`}>{trade.action}</td>
                        <td className={`px-4 py-2.5 ${t.body}`}>{trade.quantity}</td>
                        <td className={`px-4 py-2.5 ${t.body}`}>${trade.entryPrice.toFixed(2)}</td>
                        <td className={`px-4 py-2.5 ${t.body}`}>${trade.exitPrice.toFixed(2)}</td>
                        <td className={`px-4 py-2.5 font-semibold ${pl >= 0 ? t.plGain : t.plLoss}`}>${pl.toFixed(2)}</td>
                        <td className={`px-4 py-2.5 ${t.muted} text-xs`}>{trade.riskRating}</td>
                        <td className={`px-4 py-2.5 ${t.muted} text-xs max-w-[16rem] truncate`}>{trade.notes || '—'}</td>
                        <td className="px-4 py-2.5">
                          <button onClick={() => deleteTrade(trade.id)} className={`rounded-xl px-2 py-1 text-xs transition ${t.btnDel}`}>Del</button>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* ── Live Signals ── */}
        <section className={`${t.card} p-5`}>
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className={`text-base font-semibold ${t.heading}`}>Live signals</h2>
              {lastAutoScan && <p className={`text-xs ${t.faint} mt-0.5`}>Last scan {new Date(lastAutoScan).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>}
            </div>
            <button
              type="button"
              onClick={() => refreshAndScanRef.current?.()}
              disabled={!dailyPlan || marketLoading}
              className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition disabled:opacity-40 ${t.btnScan}`}
            >
              Scan now
            </button>
          </div>
          {liveSignals.length > 0 ? (
            <div className="mt-4 space-y-2">
              {liveSignals.map((signal) => (
                <div key={signal.id} className={`rounded-xl p-3 border ${
                  signal.type === 'gapper'         ? t.sigGapper :
                  signal.type === 'orb-breakout'   ? t.sigOrb :
                  signal.type === 'mean-reversion' ? t.sigMean :
                  signal.type === 'power-hour'     ? t.sigPower :
                  t.sigExit
                }`}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className={`text-sm font-semibold ${t.heading}`}>{signal.message}</p>
                      <p className={`mt-0.5 text-xs ${t.muted}`}>{signal.action}</p>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                      signal.type === 'gapper'         ? t.bGreen :
                      signal.type === 'orb-breakout'   ? t.bBlue :
                      signal.type === 'mean-reversion' ? t.bOrange :
                      signal.type === 'power-hour'     ? t.bCyan :
                      t.bRed
                    }`}>{signal.type.replace(/-/g, ' ')}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-4">
              {watchMetrics.length > 0 ? (
                <div className="space-y-4">
                  <p className="text-xs text-gray-400">Watching — no signal threshold crossed yet</p>
                  {watchMetrics.map((m) => {
                    const pct = Math.min(100, Math.max(0, ((m.value - m.min) / (m.max - m.min)) * 100))
                    const lowPct = ((m.lowThreshold - m.min) / (m.max - m.min)) * 100
                    const highPct = ((m.highThreshold - m.min) / (m.max - m.min)) * 100
                    const hot = m.value <= m.lowThreshold || m.value >= m.highThreshold
                    return (
                      <div key={m.symbol} className="space-y-1">
                        <div className="flex justify-between text-xs">
                          <span className="font-semibold text-gray-900">{m.symbol}</span>
                          <span className={hot ? 'text-amber-600 font-bold' : 'text-gray-500'}>
                            {m.label}: {m.value.toFixed(1)}{m.unit}
                            {hot ? ' ⚡' : ''}
                          </span>
                        </div>
                        <div className="relative h-3 rounded-full bg-gray-200 overflow-visible">
                          {/* oversold / buy zone */}
                          <div className="absolute left-0 top-0 h-full rounded-l-full bg-green-400/30" style={{ width: `${lowPct}%` }} />
                          {/* overbought / sell zone */}
                          <div className="absolute top-0 h-full rounded-r-full bg-red-400/30" style={{ left: `${highPct}%`, width: `${100 - highPct}%` }} />
                          {/* threshold lines */}
                          <div className="absolute top-0 w-0.5 h-full bg-green-500" style={{ left: `${lowPct}%` }} />
                          <div className="absolute top-0 w-0.5 h-full bg-red-500" style={{ left: `${highPct}%` }} />
                          {/* value marker — sits on top, outside overflow:hidden */}
                          <div
                            className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full border-2 border-white shadow transition-all ${hot ? 'bg-amber-500' : 'bg-gray-500'}`}
                            style={{ left: `${pct}%` }}
                          />
                        </div>
                        <div className="flex justify-between text-xs text-gray-400">
                          <span>{m.min}{m.unit}</span>
                          <span className="text-green-600/70">{m.lowThreshold}{m.unit}</span>
                          <span className="text-red-600/70">{m.highThreshold}{m.unit}</span>
                          <span>{m.max}{m.unit}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p className="text-sm text-gray-400">
                  {dailyPlan && parseWatchSymbols(dailyPlan.watchList).length > 0
                    ? 'Hit "Scan now" to load market data.'
                    : 'Symbols are being identified — scan will begin automatically.'}
                </p>
              )}
            </div>
          )}
        </section>

        {/* ══ SETUP — below the fold ══ */}
        <div className={`border-t ${t.divider} pt-2`}>
          <p className={`text-xs uppercase tracking-widest ${t.faint} text-center pb-4`}>Setup &amp; tools</p>
        </div>


        {/* ── Market Tools + Manual Trade Entry ── */}
        <section className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
          <div className={`${t.card} p-6 space-y-4`}>
            <h2 className={`text-base font-semibold ${t.heading}`}>Market data</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className={`block text-sm font-medium ${t.body}`}>
                AI provider
                <select value={data.settings.languageModelProvider || 'gemini'} onChange={(event) => setData((current) => ({ ...current, settings: { ...current.settings, languageModelProvider: event.target.value } }))} className={`mt-2 w-full rounded-2xl border p-3 outline-none ${t.input}`}>
                  <option value="gemini">Gemini</option>
                  <option value="openai">OpenAI</option>
                </select>
              </label>
              <label className={`block text-sm font-medium ${t.body}`}>
                Symbol
                <input value={marketSymbol} onChange={(event) => setMarketSymbol(event.target.value.toUpperCase())} placeholder="AAPL" className={`mt-2 w-full rounded-2xl border p-3 outline-none ${t.input}`} />
              </label>
            </div>
            <div className="flex flex-wrap gap-3">
              <button type="button" disabled={marketLoading} onClick={fetchMarketQuote} className="rounded-2xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:opacity-50">Fetch quote</button>
              <button type="button" disabled={marketLoading} onClick={fetchMarketHistory} className="rounded-2xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-violet-500 disabled:opacity-50">Daily history</button>
              <button type="button" disabled={marketLoading} onClick={fetchMarketIntraday} className="rounded-2xl bg-fuchsia-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-fuchsia-500 disabled:opacity-50">Intraday</button>
            </div>
            {marketStatus && <p className={`text-xs ${t.muted}`}>{marketStatus}</p>}
            {currentQuote && (
              <div className={`rounded-2xl ${dk ? 'bg-slate-950/80' : 'bg-gray-50'} p-4 space-y-3`}>
                <div className="flex items-center justify-between">
                  <p className={t.statValue}>{currentQuote.symbol} <span className={`${t.muted} text-sm font-normal`}>${currentQuote.price.toFixed(2)}</span></p>
                  <span className={`text-xs ${t.muted}`}>{currentQuote.changePercent}</span>
                </div>
                {currentIntraday.length > 0 && (
                  <div className="grid grid-cols-4 gap-2 text-xs">
                    <div className={`rounded-xl ${dk ? 'bg-slate-800' : 'bg-white'} p-2`}><p className={t.faint}>High</p><p className={t.statValue}>${Math.max(...currentIntraday.map((p) => p.high)).toFixed(2)}</p></div>
                    <div className={`rounded-xl ${dk ? 'bg-slate-800' : 'bg-white'} p-2`}><p className={t.faint}>Low</p><p className={t.statValue}>${Math.min(...currentIntraday.map((p) => p.low)).toFixed(2)}</p></div>
                    <div className={`rounded-xl ${dk ? 'bg-slate-800' : 'bg-white'} p-2`}><p className={t.faint}>VWAP</p><p className={t.vwapValue}>${(calculateVWAP(currentIntraday) ?? 0).toFixed(2)}</p></div>
                    <div className={`rounded-xl ${dk ? 'bg-slate-800' : 'bg-white'} p-2`}><p className={t.faint}>Vol</p><p className={t.statValue}>{currentIntraday[0].volume.toLocaleString()}</p></div>
                  </div>
                )}
                <button type="button" onClick={fillTradePrices} className="rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500">Use for trade prices</button>
              </div>
            )}
          </div>

          <div className={`${t.card} p-6`}>
            <h2 className={`text-base font-semibold ${t.heading} mb-4`}>Add trade manually</h2>
            <form onSubmit={submitTrade} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className={`block text-sm font-medium ${t.muted}`}>Symbol<input value={tradeDraft.symbol} onChange={(e) => setTradeDraft((p) => ({ ...p, symbol: e.target.value }))} placeholder="AAPL" className={`mt-1 w-full rounded-xl border p-2.5 outline-none text-sm ${t.input}`} /></label>
                <label className={`block text-sm font-medium ${t.muted}`}>Action<select value={tradeDraft.action} onChange={(e) => setTradeDraft((p) => ({ ...p, action: e.target.value }))} className={`mt-1 w-full rounded-xl border p-2.5 outline-none text-sm ${t.input}`}><option>Buy</option><option>Sell</option></select></label>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className={`block text-sm font-medium ${t.muted}`}>Qty<input type="number" value={tradeDraft.quantity} onChange={(e) => setTradeDraft((p) => ({ ...p, quantity: e.target.value }))} placeholder="100" className={`mt-1 w-full rounded-xl border p-2.5 outline-none text-sm ${t.input}`} /></label>
                <label className={`block text-sm font-medium ${t.muted}`}>Entry<input type="number" step="0.01" value={tradeDraft.entryPrice} onChange={(e) => setTradeDraft((p) => ({ ...p, entryPrice: e.target.value }))} placeholder="150.00" className={`mt-1 w-full rounded-xl border p-2.5 outline-none text-sm ${t.input}`} /></label>
                <label className={`block text-sm font-medium ${t.muted}`}>Exit<input type="number" step="0.01" value={tradeDraft.exitPrice} onChange={(e) => setTradeDraft((p) => ({ ...p, exitPrice: e.target.value }))} placeholder="152.00" className={`mt-1 w-full rounded-xl border p-2.5 outline-none text-sm ${t.input}`} /></label>
              </div>
              <label className={`block text-sm font-medium ${t.muted}`}>Notes<input value={tradeDraft.notes} onChange={(e) => setTradeDraft((p) => ({ ...p, notes: e.target.value }))} placeholder="Reason, signal, exit conditions" className={`mt-1 w-full rounded-xl border p-2.5 outline-none text-sm ${t.input}`} /></label>
              <button type="submit" className="w-full rounded-xl bg-sky-600 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-500">Add trade</button>
            </form>
          </div>
        </section>

        {/* ── Performance History ── */}
        <section className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
          <article className={`${t.card} p-6`}>
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className={`text-xl font-semibold ${t.heading}`}>Performance history</h2>
                <p className={`mt-2 ${t.muted}`}>Review recent daily outcomes and compare the plan to actual P/L.</p>
              </div>
            </div>

            <div className="mt-6 space-y-4">
              {history.length === 0 ? (
                <p className={t.muted}>No historical days recorded yet.</p>
              ) : (
                history.map((date) => {
                  const metrics = computeMetrics(date)
                  return (
                    <div key={date} className={`rounded-3xl ${dk ? 'bg-slate-950/80' : 'bg-gray-50'} p-4`}>
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className={`text-sm ${t.muted}`}>{displayDate(date)}</p>
                          <p className={`mt-1 text-lg font-semibold ${t.heading}`}>Net P/L: ${metrics.totalPL.toFixed(2)}</p>
                        </div>
                        <div className={`rounded-3xl ${dk ? 'bg-slate-800 text-slate-300' : 'bg-white text-gray-600'} px-3 py-2 text-sm`}>Trades: {metrics.trades}</div>
                      </div>
                      <div className="mt-4 grid gap-3 sm:grid-cols-3">
                        <div className={`rounded-3xl ${dk ? 'bg-slate-800' : 'bg-white'} p-3`}>
                          <p className={`text-xs uppercase tracking-[0.18em] ${t.faint}`}>Risk reward</p>
                          <p className={`mt-2 text-lg font-semibold ${t.heading}`}>{metrics.riskReward}</p>
                        </div>
                        <div className={`rounded-3xl ${dk ? 'bg-slate-800' : 'bg-white'} p-3`}>
                          <p className={`text-xs uppercase tracking-[0.18em] ${t.faint}`}>Total risk</p>
                          <p className={`mt-2 text-lg font-semibold ${t.heading}`}>{metrics.risk.toFixed(2)}</p>
                        </div>
                        <div className={`rounded-3xl ${dk ? 'bg-slate-800' : 'bg-white'} p-3`}>
                          <p className={`text-xs uppercase tracking-[0.18em] ${t.faint}`}>Reward</p>
                          <p className={`mt-2 text-lg font-semibold ${t.heading}`}>{metrics.reward.toFixed(2)}</p>
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </article>

          <article className={`${t.card} p-6`}>
            <h2 className={`text-xl font-semibold ${t.heading}`}>P/L graph</h2>
            <p className={`mt-2 ${t.muted}`}>Daily profit and loss trend for your latest recorded days.</p>
            <div className="mt-6 space-y-3">
              {history.length === 0 ? (
                <p className={t.muted}>Add a plan and trades to begin tracking daily performance.</p>
              ) : (
                <div className="space-y-3">
                  {(() => {
                    const recent = history.slice(0, 7)
                    const allMetrics = recent.map((date) => ({ date, metrics: computeMetrics(date) }))
                    const maxPL = Math.max(1, ...allMetrics.map(({ metrics }) => Math.abs(metrics.totalPL)))
                    return allMetrics.map(({ date, metrics }) => {
                    const barWidth = Math.max(4, (Math.abs(metrics.totalPL) / maxPL) * 100)
                    return (
                      <div key={date} className="space-y-2">
                        <div className={`flex items-center justify-between gap-3 text-sm ${t.muted}`}>
                          <span>{displayDate(date)}</span>
                          <span className={metrics.totalPL >= 0 ? t.plGain : t.plLoss}>${metrics.totalPL.toFixed(2)}</span>
                        </div>
                        <div className="h-3 rounded-full bg-gray-200">
                          <div className={`h-3 rounded-full ${metrics.totalPL >= 0 ? 'bg-emerald-400' : 'bg-rose-400'}`} style={{ width: `${barWidth}%` }} />
                        </div>
                      </div>
                    )
                  })
                  })()}
                </div>
              )}
            </div>
          </article>
        </section>

        {/* ── Morning Plan ── */}
        <section className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
          <article className={`${t.card} p-6`}>
            <h2 className={`text-xl font-semibold ${t.heading}`}>Morning plan</h2>
            <p className={`mt-2 ${t.muted}`}>Answer the research prompt and describe the decision parameters you will monitor today.</p>
            {!dailyPlan ? (
              <form onSubmit={submitPlan} className="mt-6 space-y-5">
                <div className="space-y-2">
                  <label className={`text-sm font-medium ${t.body}`}>Research prompt</label>
                  <textarea readOnly value={DEFAULT_PROMPT} rows={3} className={`w-full rounded-2xl border p-3 text-sm outline-none ${t.input}`} />
                </div>
                <div className="space-y-2">
                  <label className={`text-sm font-medium ${t.body}`}>Your plan</label>
                  <textarea value={planDraft.response} onChange={(event) => setPlanDraft((prev) => ({ ...prev, response: event.target.value }))} rows={4} className={`w-full rounded-2xl border p-3 text-sm outline-none ${t.input}`} placeholder="What are you doing today?" />
                </div>
                <div className="space-y-2">
                  <label className={`text-sm font-medium ${t.body}`}>Key parameters / watch list</label>
                  <textarea value={planDraft.watchList} onChange={(event) => setPlanDraft((prev) => ({ ...prev, watchList: event.target.value }))} rows={3} className={`w-full rounded-2xl border p-3 text-sm outline-none ${t.input}`} placeholder="Symbols, sectors, signals, macro cues, time windows..." />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className={`block text-sm font-medium ${t.body}`}>
                    Risk profile
                    <select value={planDraft.riskProfile} onChange={(event) => setPlanDraft((prev) => ({ ...prev, riskProfile: event.target.value }))} className={`mt-2 w-full rounded-2xl border p-3 outline-none ${t.input}`}>
                      <option>Low</option>
                      <option>Medium</option>
                      <option>High</option>
                    </select>
                  </label>
                  <label className={`block text-sm font-medium ${t.body}`}>
                    Notes
                    <input value={planDraft.notes} onChange={(event) => setPlanDraft((prev) => ({ ...prev, notes: event.target.value }))} className={`mt-2 w-full rounded-2xl border p-3 outline-none ${t.input}`} placeholder="Additional discipline, exit conditions, portfolio sizing" />
                  </label>
                </div>
                <div className="flex flex-wrap gap-3">
                  <button type="submit" className="inline-flex items-center justify-center rounded-2xl bg-emerald-500 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-400">
                    Save morning plan
                  </button>
                  <button type="button" onClick={generateMorningPlanFromAI} disabled={marketLoading} className="inline-flex items-center justify-center rounded-2xl bg-blue-500 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-400 disabled:opacity-50">
                    Generate plan from AI
                  </button>
                  <button type="button" onClick={copyEnrichedPrompt} disabled={marketLoading} className={`inline-flex items-center justify-center rounded-2xl px-5 py-3 text-sm font-semibold transition disabled:opacity-50 ${dk ? 'bg-slate-700 text-slate-200 hover:bg-slate-600' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}>
                    Copy prompt
                  </button>
                </div>
                {planStatus && <p className={`mt-3 text-sm ${t.planStatus}`}>{planStatus}</p>}
              </form>
            ) : (
              <div className={`mt-6 space-y-5 rounded-3xl border ${t.divider} ${dk ? 'bg-slate-950/80' : 'bg-gray-50'} p-5`}>
                <div>
                  <p className={`text-sm uppercase tracking-[0.24em] ${t.muted}`}>Morning response</p>
                  <p className={`mt-3 whitespace-pre-wrap rounded-3xl ${dk ? 'bg-slate-800 text-slate-200' : 'bg-white text-gray-800'} p-4 text-sm`}>{dailyPlan.response}</p>
                </div>
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <p className={`text-sm uppercase tracking-[0.24em] ${t.muted}`}>Watch list — ticker symbols</p>
                    <span className={`text-xs ${t.faint}`}>Edit to add/change symbols for auto-trading</span>
                  </div>
                  <textarea
                    value={dailyPlan.watchList}
                    onChange={(e) => setData((current) => ({
                      ...current,
                      dailyPlans: current.dailyPlans.map((p) =>
                        p.date === selectedDate ? { ...p, watchList: e.target.value } : p
                      ),
                    }))}
                    rows={2}
                    placeholder="AAPL, NVDA, TSLA — add symbols here to enable auto-trading"
                    className={`mt-2 w-full rounded-2xl border p-3 text-sm outline-none ${t.input}`}
                  />
                  {planStatus && <p className={`mt-2 text-xs ${t.planStatus}`}>{planStatus}</p>}
                </div>
                <div className="mt-4 flex flex-wrap gap-3">
                  <button type="button" onClick={generateMorningPlanFromAI} disabled={marketLoading} className="inline-flex items-center justify-center rounded-2xl bg-blue-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-400 disabled:opacity-50">
                    Regenerate plan from AI
                  </button>
                  <button type="button" onClick={copyEnrichedPrompt} disabled={marketLoading} className={`inline-flex items-center justify-center rounded-2xl px-4 py-3 text-sm font-semibold transition disabled:opacity-50 ${dk ? 'bg-slate-700 text-slate-200 hover:bg-slate-600' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}>
                    Copy prompt
                  </button>
                  <button type="button" onClick={clearDailyPlan} className="inline-flex items-center justify-center rounded-2xl bg-rose-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-rose-500">
                    Clear plan
                  </button>
                </div>
                {planInterpretation && <p className={`mt-3 text-sm ${t.muted}`}>{planInterpretation}</p>}
                {planStatus && <p className={`mt-3 text-sm ${t.planStatus}`}>{planStatus}</p>}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className={`rounded-3xl ${dk ? 'bg-slate-800' : 'bg-white'} p-4`}>
                    <p className={`text-sm ${t.muted}`}>Risk profile</p>
                    <p className={`mt-2 text-lg font-semibold ${t.heading}`}>{dailyPlan.riskProfile}</p>
                  </div>
                  <div className={`rounded-3xl ${dk ? 'bg-slate-800' : 'bg-white'} p-4`}>
                    <p className={`text-sm ${t.muted}`}>Notes</p>
                    <p className={`mt-2 text-lg ${t.body}`}>{dailyPlan.notes || '—'}</p>
                  </div>
                </div>
              </div>
            )}
          </article>

        </section>
      </div>
    </div>
  )
}
