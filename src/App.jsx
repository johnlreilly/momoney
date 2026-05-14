import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth, SignInButton, UserButton } from '@clerk/react'
import { createId, loadData, saveData } from './storage.js'
import { createApi } from './api.js'

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

function detectGapper(symbol, yesterdayClose, currentPrice) {
  if (!yesterdayClose || !currentPrice) return 0
  const gapPercent = Math.abs((currentPrice - yesterdayClose) / yesterdayClose) * 100
  return gapPercent >= 0.5 ? gapPercent : 0
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
    volumeConfirmed: avgOpeningVolume === 0 || latestVolume > avgOpeningVolume * 0.5,
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
      if (rsi !== null && rsi > 60 && ma20) {
        signals.push({
          id: createId(), symbol, type: 'mean-reversion', value: rsi,
          message: `${symbol}: Overbought RSI ${rsi.toFixed(1)} — MA20 $${ma20.toFixed(2)}`,
          action: 'SHORT for reversion to MA20',
          timestamp: new Date().toISOString(),
        })
      }
      if (rsi !== null && rsi < 40 && ma20) {
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
      if (gain > 0.2) {
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
  const [data, setData] = useState({
    dailyPlans: [],
    dailySessions: [],
    trades: [],
    marketData: {},
    executedSignals: [],
    activityLog: [],
    settings: { languageModelProvider: 'gemini' },
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
  const [scanStatus, setScanStatus] = useState('')
  const [scanning, setScanning] = useState(false)
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'light')
  function toggleTheme() {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark'
      localStorage.setItem('theme', next)
      return next
    })
  }
  const [tradingPhase, setTradingPhase] = useState(updateTradingPhase)
  const [selectedPhase, setSelectedPhase] = useState(updateTradingPhase)
  const [lastAutoScan, setLastAutoScan] = useState(null)
  const dataRef = useRef(null)
  const marketDataRef = useRef({})
  const refreshAndScanRef = useRef(null)
  const watchListDebounce = useRef(null)

  const { getToken, isSignedIn } = useAuth()
  const api = useMemo(() => createApi(getToken), [getToken])
  const [dataLoading, setDataLoading] = useState(true)

  useEffect(() => {
    if (!isSignedIn) { setDataLoading(false); return }
    api.load()
      .then((remote) => {
        const cached = loadData()
        setData({ ...remote, marketData: cached.marketData || {} })
        if (!remote.trades.length && !remote.dailySessions.length &&
            (cached.trades.length || cached.dailySessions.length)) {
          api.migrate(cached)
        }
      })
      .catch(() => setData(loadData()))
      .finally(() => setDataLoading(false))
  }, [isSignedIn]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!dataLoading) saveData(data)
  }, [data, dataLoading])

  useEffect(() => {
    dataRef.current = data
    marketDataRef.current = data.marketData
  }, [data])

  const dailyPlan = useMemo(
    () => data.dailyPlans.find((plan) => plan.date === selectedDate),
    [data.dailyPlans, selectedDate],
  )

  // Sessions: one per phase per day
  const sessionsForDate = useMemo(
    () => (data.dailySessions || []).filter((s) => s.date === selectedDate),
    [data.dailySessions, selectedDate],
  )
  const activeSession = useMemo(
    () => sessionsForDate.find((s) => s.phase === selectedPhase) || null,
    [sessionsForDate, selectedPhase],
  )
  function playBeep(type = 'single') {
    try {
      const ctx = new AudioContext()
      const beep = (freq, start, duration) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.frequency.value = freq
        osc.type = 'sine'
        gain.gain.setValueAtTime(0.25, ctx.currentTime + start)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + duration)
        osc.start(ctx.currentTime + start)
        osc.stop(ctx.currentTime + start + duration)
      }
      if (type === 'double') {
        beep(880, 0, 0.12)
        beep(1100, 0.18, 0.12)
      } else {
        beep(660, 0, 0.15)
      }
    } catch { /* AudioContext blocked — ignore */ }
  }

  function saveSession(phase, fields) {
    const session = { id: createId(), date: selectedDate, phase, createdAt: new Date().toISOString(), ...fields }
    setData((current) => {
      const others = (current.dailySessions || []).filter(
        (s) => !(s.date === selectedDate && s.phase === phase)
      )
      return { ...current, dailySessions: [...others, session] }
    })
    api.saveSession(session)
  }
  function clearSession(phase) {
    setData((current) => ({
      ...current,
      dailySessions: (current.dailySessions || []).filter(
        (s) => !(s.date === selectedDate && s.phase === phase)
      ),
    }))
    api.deleteSession(selectedDate, phase)
  }

  const dailyTrades = useMemo(
    () => data.trades.filter((trade) => trade.date === selectedDate),
    [data.trades, selectedDate],
  )

  const filteredDailyTrades = useMemo(() => {
    const phase = PHASE_SCHEDULE.find((p) => p.phase === selectedPhase)
    if (!phase) return dailyTrades
    return dailyTrades.filter((trade) => {
      if (!trade.createdAt) return true
      const h = new Date(trade.createdAt).getHours() + new Date(trade.createdAt).getMinutes() / 60
      return h >= phase.startHour && h < phase.endHour
    })
  }, [dailyTrades, selectedPhase])

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
    api.addTrade(trade)
    playBeep('single')
    setTradeDraft({ symbol: '', action: 'Buy', quantity: '', entryPrice: '', exitPrice: '', riskRating: 'Medium', notes: '' })
  }

  function deleteTrade(tradeId) {
    setData((current) => ({
      ...current,
      trades: current.trades.filter((trade) => trade.id !== tradeId),
    }))
    api.deleteTrade(tradeId)
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
      if (!md?.quote?.price) continue  // skip if price is 0 or missing

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
        // Only use live price if it's real and different from entry — otherwise keep planned exit
        const usePrice = livePrice > 0 && livePrice !== trade.entryPrice ? livePrice : trade.exitPrice
        return { ...trade, exitPrice: usePrice }
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

    if (newTrades.length > 0) playBeep('double')

    setData((prev) => ({
      ...prev,
      marketData: freshMarketData,
      trades: finalTrades,
      executedSignals: [...(prev.executedSignals || []), ...newExecuted],
      activityLog: [...(prev.activityLog || []).slice(-200), ...newLog],
    }))

    const todayFinalTrades = finalTrades.filter((t) => t.date === todayStr)
    Promise.all([
      todayFinalTrades.length > 0 && api.saveTradesForDate(todayStr, todayFinalTrades),
      newExecuted.length > 0 && api.addSignals(newExecuted),
      newLog.length > 0 && api.addActivity(newLog),
    ].filter(Boolean))
  }

  async function refreshAndScan() {
    const current = dataRef.current
    // Use the active session's watch list (falls back to legacy dailyPlan if no session)
    const session = (current?.dailySessions || []).find((s) => s.date === selectedDate && s.phase === selectedPhase)
    const legacyPlan = (current?.dailyPlans || []).find((p) => p.date === selectedDate)
    const watchList = session?.watchList || legacyPlan?.watchList || ''
    const symbols = parseWatchSymbols(watchList)
    if (symbols.length === 0) { setScanStatus('No symbols in watch list — save a session first.'); return }

    setScanning(true)
    setScanStatus(`Fetching data for ${symbols.join(', ')}…`)
    const updatedMarketData = { ...marketDataRef.current }
    const fetchResults = {}
    for (const symbol of symbols) {
      try {
        const [intradayRes, quoteRes] = await Promise.all([
          fetch(`/api/market?type=intraday&symbol=${encodeURIComponent(symbol)}&interval=5min`),
          fetch(`/api/market?type=quote&symbol=${encodeURIComponent(symbol)}`),
        ])
        const intraday = intradayRes.ok ? await intradayRes.json() : null
        const quote = quoteRes.ok ? await quoteRes.json() : null
        // Only overwrite stored data when the new fetch actually has content.
        // Alpha Vantage returns HTTP 200 with {"Note":"..."} when rate-limited,
        // which parses to [] / price:0 — keep last good data in that case.
        const freshIntraday = intraday?.length > 0 ? intraday : null
        const freshQuote = quote?.price > 0 ? quote : null
        updatedMarketData[symbol] = {
          ...(updatedMarketData[symbol] || {}),
          ...(freshIntraday ? { intraday: freshIntraday, intradayAt: new Date().toISOString() } : {}),
          ...(freshQuote   ? { quote:    freshQuote,    quoteAt:    new Date().toISOString() } : {}),
        }
        fetchResults[symbol] = { freshIntraday: !!freshIntraday, freshQuote: !!freshQuote }
      } catch (err) {
        fetchResults[symbol] = { error: err?.message || 'fetch failed' }
      }
    }

    const fetchSummary = symbols.map((s) => {
      const r = fetchResults[s] || {}
      if (r.error) return `${s}: error`
      const md = updatedMarketData[s]
      const price = md?.quote?.price || 0
      const bars = md?.intraday?.length || 0
      const fresh = r.freshIntraday || r.freshQuote
      return `${s}: $${price > 0 ? price.toFixed(2) : '—'} ${bars}bars${fresh ? '' : ' (cached)'}`
    }).join(' | ')

    const { signals, phase } = buildSignals(symbols, updatedMarketData)
    setTradingPhase(phase)
    setLiveSignals(signals)
    autoExecuteSignals(signals, phase, updatedMarketData, selectedDate)
    setLastAutoScan(new Date().toISOString())

    const metrics = []
    for (const symbol of symbols) {
      const md = updatedMarketData[symbol]
      const price = md?.quote?.price || 0
      const prevClose = md?.quote?.previousClose || 0
      const intradayBars = md?.intraday?.length || 0

      const stale = !fetchResults[symbol]?.freshIntraday && !fetchResults[symbol]?.freshQuote
      const dataAt = md?.quoteAt || md?.intradayAt
      const staleLabel = stale && dataAt ? `cached ${new Date(dataAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : null

      if (phase === 'pre-market' && price > 0 && md.dailySeries?.length > 0) {
        const raw = ((price - md.dailySeries[0].close) / md.dailySeries[0].close) * 100
        metrics.push({ symbol, label: 'Gap', value: raw, min: -10, max: 10, lowThreshold: -3, highThreshold: 3, unit: '%', staleLabel })
      } else if (phase === 'opening-drive' && intradayBars > 0 && price > 0) {
        const orb = detectORB(md.intraday, 15)
        if (orb) {
          const distPct = ((price - orb.high) / orb.high) * 100
          metrics.push({ symbol, label: 'vs ORB High', value: distPct, min: -5, max: 5, lowThreshold: -0.5, highThreshold: 0, unit: '%', staleLabel })
        } else {
          metrics.push({ symbol, label: 'Day gain', value: prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0, min: -5, max: 5, lowThreshold: -1, highThreshold: 1, unit: '%', noData: price === 0, staleLabel })
        }
      } else if (phase === 'midday-fade' && intradayBars >= 15) {
        const closes = md.intraday.map((d) => d.close)
        const rsi = calculateRSI(closes, 14)
        if (rsi !== null) {
          metrics.push({ symbol, label: 'RSI', value: rsi, min: 0, max: 100, lowThreshold: 30, highThreshold: 70, unit: '', staleLabel })
        } else {
          metrics.push({ symbol, label: 'Day gain', value: prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0, min: -5, max: 5, lowThreshold: -1, highThreshold: 1, unit: '%', noData: price === 0, staleLabel })
        }
      } else if (phase === 'power-hour' && price > 0 && prevClose > 0) {
        metrics.push({ symbol, label: 'Day gain', value: ((price - prevClose) / prevClose) * 100, min: -3, max: 5, lowThreshold: -1, highThreshold: 1, unit: '%', staleLabel })
      } else {
        metrics.push({
          symbol,
          label: price > 0 && prevClose > 0 ? 'Day gain' : 'No data',
          value: price > 0 && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0,
          min: -5, max: 5, lowThreshold: -1, highThreshold: 1, unit: price > 0 && prevClose > 0 ? '%' : '',
          noData: !(price > 0 && prevClose > 0),
          staleLabel,
        })
      }
    }
    setWatchMetrics(metrics)
    setScanStatus(`Phase: ${phase} | ${fetchSummary} | ${signals.length} signal(s) | ${metrics.length} gauge(s)`)
    setScanning(false)
  }

  // Keep ref current so the interval always calls the latest version without stale closure
  useEffect(() => { refreshAndScanRef.current = refreshAndScan })

  useEffect(() => {
    if (!activeSession || selectedDate !== today) return
    refreshAndScanRef.current?.()
    const intervalId = setInterval(() => {
      refreshAndScanRef.current?.()
    }, 5 * 60 * 1000)
    return () => clearInterval(intervalId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession?.id, selectedDate])





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
    app:        dk ? 'min-h-screen bg-slate-950 text-slate-100'               : 'min-h-screen bg-gray-100 text-gray-900',
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
    btnScan:    dk ? 'bg-blue-700 border border-blue-600 text-white hover:bg-blue-600'       : 'bg-blue-600 border border-blue-700 text-white hover:bg-blue-700',
    btnDel:     dk ? 'bg-slate-700 text-slate-300 hover:bg-red-900/60 hover:text-red-300'    : 'bg-gray-200 text-gray-600 hover:bg-red-100 hover:text-red-700',
    // plan decisions
    decActive:    dk ? 'border-blue-600/60 bg-blue-900/30'          : 'border-blue-400 bg-blue-50',
    decCompleted: dk ? 'border-slate-700 bg-slate-800/40 opacity-50': 'border-gray-200 bg-gray-100 opacity-50',
    decPending:   dk ? 'border-slate-700/40 bg-transparent'         : 'border-gray-200 bg-transparent',
    // values
    statValue:  dk ? 'font-semibold text-white'      : 'font-semibold text-gray-900',
    vwapValue:  dk ? 'font-semibold text-sky-300'    : 'font-semibold text-sky-700',
    plGain:     dk ? 'text-emerald-400' : 'text-emerald-600',
    plLoss:     dk ? 'text-rose-400'    : 'text-rose-600',
    scanStatus: dk ? 'text-slate-400'   : 'text-gray-500',
  }

  if (!isSignedIn) {
    return (
      <div className={`${t.app} flex items-center justify-center`}>
        <div className="text-center space-y-4">
          <h1 className={`text-2xl font-semibold ${t.heading}`}>mo' money</h1>
          <p className={`text-sm ${t.muted}`}>Sign in to access your trading dashboard</p>
          <SignInButton mode="modal">
            <button type="button" className="rounded-2xl bg-blue-600 px-6 py-3 text-sm font-semibold text-white hover:bg-blue-500 transition">Sign In</button>
          </SignInButton>
        </div>
      </div>
    )
  }

  if (dataLoading) {
    return (
      <div className={`${t.app} flex items-center justify-center`}>
        <p className={`text-sm ${t.muted}`}>Loading…</p>
      </div>
    )
  }

  return (
    <div className={t.app}>
      {/* ── Header: full-width sticky, flush with top ── */}
      <header className={`sticky top-0 z-10 w-full rounded-b-3xl border-b ${t.divider} ${dk ? 'bg-slate-900/95' : 'bg-white/95'} shadow-xl backdrop-blur px-4 pt-5 pb-4`}>
        <div className="mx-auto max-w-7xl flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-baseline gap-3">
            <h1 className={`text-xl font-semibold ${t.heading}`}>mo' money</h1>
            <span className={`text-xs ${t.faint}`}>v{VERSION}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className={`rounded-xl px-3 py-1.5 text-sm font-semibold ${todaysMetrics.totalPL >= 0 ? `bg-emerald-500/15 ${t.plGain}` : `bg-rose-500/15 ${t.plLoss}`}`}>
              {((todaysMetrics.totalPL / STARTING_CASH) * 100).toFixed(2)}% &nbsp;{todaysMetrics.totalPL >= 0 ? '+' : ''}{todaysMetrics.totalPL.toFixed(2)}
            </div>
            <div className={`rounded-xl px-3 py-1.5 text-sm ${dk ? 'bg-slate-800 text-slate-300' : 'bg-gray-200 text-gray-600'}`}>
              {todaysMetrics.trades} trade{todaysMetrics.trades !== 1 ? 's' : ''}
            </div>
            <select
              value={selectedPhase}
              onChange={(e) => setSelectedPhase(e.target.value)}
              className={`rounded-xl border px-3 py-1.5 text-sm outline-none ${t.input}`}
            >
              {PHASE_SCHEDULE.map((p) => {
                const hasSession = sessionsForDate.some((s) => s.phase === p.phase)
                const isActive = p.phase === tradingPhase
                return (
                  <option key={p.phase} value={p.phase}>
                    {isActive ? '▶ ' : ''}{p.label}{hasSession ? ' ✓' : ''}
                  </option>
                )
              })}
            </select>
            {lastAutoScan && (
              <div className={`rounded-xl px-3 py-1.5 text-sm ${dk ? 'bg-slate-800 text-slate-300' : 'bg-gray-200 text-gray-600'}`}>
                {new Date(lastAutoScan).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            )}
            <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} className={`rounded-xl ${t.input} border px-3 py-1.5 text-sm outline-none`} />
            <button type="button" onClick={toggleTheme} className={`rounded-xl px-3 py-1.5 text-sm transition ${dk ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-gray-200 text-gray-600 hover:bg-gray-300'}`}>
              {dk ? '☀ Light' : '☾ Dark'}
            </button>
            <UserButton />
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl space-y-6 px-4 py-6">

        {/* ── Live Signals ── */}
        <section className={`${scanning ? (dk ? 'rounded-3xl border border-blue-800 bg-blue-950/50' : 'rounded-3xl border border-blue-200 bg-blue-50') : t.card} p-5 transition-colors duration-500`}>
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className={`text-base font-semibold ${t.heading}`}>Live Signals</h2>
              </div>
              <button
                type="button"
                onClick={() => refreshAndScanRef.current?.()}
                disabled={!activeSession && !dailyPlan || scanning}
                className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition disabled:opacity-40 ${t.btnScan}`}
              >
                {scanning ? 'Scanning…' : 'Scan Now'}
              </button>
            </div>
            {liveSignals.length > 0 && (
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
            )}
            <div className={`${liveSignals.length > 0 ? `mt-4 pt-4 border-t ${t.divider}` : 'mt-4'}`}>
              {watchMetrics.length > 0 ? (
                <div>
                  {liveSignals.length === 0 && <p className={`text-xs ${t.faint} mb-3`}>Watching — no threshold crossed yet</p>}
                  <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                  {watchMetrics.map((m) => {
                    if (m.noData) {
                      return (
                        <div key={m.symbol} className="flex items-center justify-between text-xs py-1">
                          <span className={`font-semibold ${t.heading}`}>{m.symbol}</span>
                          <span className={t.faint}>No data — try again later</span>
                        </div>
                      )
                    }
                    const pct = Math.min(100, Math.max(0, ((m.value - m.min) / (m.max - m.min)) * 100))
                    const lowPct = ((m.lowThreshold - m.min) / (m.max - m.min)) * 100
                    const highPct = ((m.highThreshold - m.min) / (m.max - m.min)) * 100
                    const hot = !m.noData && (m.value <= m.lowThreshold || m.value >= m.highThreshold)
                    return (
                      <div key={m.symbol} className="space-y-1">
                        <div className="flex justify-between text-xs">
                          <span className={`font-semibold ${t.heading}`}>{m.symbol}</span>
                          <span className={hot ? `font-bold ${dk ? 'text-blue-400' : 'text-blue-600'}` : t.muted}>
                            {m.label}: {m.value.toFixed(1)}{m.unit}{hot ? ' ↑' : ''}{m.staleLabel ? <span className={`ml-1 ${t.faint} font-normal`}>({m.staleLabel})</span> : null}
                          </span>
                        </div>
                        <div className="relative h-2.5 rounded-full overflow-visible" style={{ background: dk ? '#1e293b' : '#e5e7eb' }}>
                          <div className="absolute left-0 top-0 h-full rounded-l-full bg-emerald-500/25" style={{ width: `${lowPct}%` }} />
                          <div className="absolute top-0 h-full rounded-r-full bg-red-500/25" style={{ left: `${highPct}%`, width: `${100 - highPct}%` }} />
                          <div className="absolute top-0 w-0.5 h-full bg-emerald-500/60" style={{ left: `${lowPct}%` }} />
                          <div className="absolute top-0 w-0.5 h-full bg-red-500/60" style={{ left: `${highPct}%` }} />
                          <div
                            className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full border-2 border-white shadow-sm transition-all ${hot ? 'bg-blue-500' : dk ? 'bg-slate-400' : 'bg-gray-400'}`}
                            style={{ left: `${pct}%` }}
                          />
                        </div>
                        <div className={`flex justify-between text-xs ${t.faint}`}>
                          <span>{m.min}{m.unit}</span>
                          <span className="text-emerald-600">{m.lowThreshold}{m.unit}</span>
                          <span className="text-red-500">{m.highThreshold}{m.unit}</span>
                          <span>{m.max}{m.unit}</span>
                        </div>
                      </div>
                    )
                  })}
                  </div>
                </div>
              ) : (
                <p className={`text-sm ${t.faint}`}>
                  {activeSession && parseWatchSymbols(activeSession.watchList).length > 0
                    ? 'Hit "Scan now" to load market data.'
                    : 'Save a session with a watch list to enable scanning.'}
                </p>
              )}
            </div>
            {lastAutoScan && (
              <p className={`mt-3 text-xs ${t.faint} border-t ${t.divider} pt-3`}>
                Last scan {new Date(lastAutoScan).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </p>
            )}
        </section>

        {/* ── Trade Table ── */}
        <section className={`${t.card} p-5`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className={`text-base font-semibold ${t.heading}`}>Trades — {displayDate(selectedDate)}</h2>
              <p className={`text-xs ${t.faint} mt-0.5`}>{PHASE_SCHEDULE.find((p) => p.phase === selectedPhase)?.label} · {filteredDailyTrades.length} of {dailyTrades.length}</p>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={exportDayCsv} className="rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500">Export Day</button>
              <button type="button" onClick={exportAllCsv} className={`rounded-xl ${dk ? 'bg-slate-700 text-slate-200' : 'bg-gray-300 text-gray-700'} px-3 py-1.5 text-xs font-semibold transition hover:opacity-80`}>Export All</button>
              <button type="button" onClick={() => {
                setData((c) => ({
                  ...c,
                  executedSignals: (c.executedSignals || []).filter((e) => e.date !== selectedDate),
                }))
                api.resetSignals(selectedDate)
              }} className={`rounded-xl ${dk ? 'bg-slate-700 text-slate-300 hover:bg-slate-600' : 'bg-gray-200 text-gray-600 hover:bg-gray-300'} px-3 py-1.5 text-xs font-semibold transition`}>Reset Signals</button>
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
                {filteredDailyTrades.length === 0 ? (
                  <tr><td colSpan="9" className="px-4 py-8 text-center text-gray-400">{dailyTrades.length > 0 ? 'No trades this phase.' : 'No trades yet — auto-trades will appear here as signals fire.'}</td></tr>
                ) : (
                  filteredDailyTrades.map((trade) => {
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



        {/* ── Market Tools + Manual Trade Entry ── */}
        <section className="grid gap-6 xl:grid-cols-2">
          <div className={`${t.card} p-6 space-y-4`}>
            <h2 className={`text-base font-semibold ${t.heading}`}>Market Data</h2>
            <label className={`block text-sm font-medium ${t.body}`}>
              Symbol
              <input value={marketSymbol} onChange={(event) => setMarketSymbol(event.target.value.toUpperCase())} placeholder="AAPL" className={`mt-2 w-full rounded-2xl border p-3 outline-none ${t.input}`} />
            </label>
            <div className="flex flex-wrap gap-3">
              <button type="button" disabled={marketLoading} onClick={fetchMarketQuote} className="rounded-2xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:opacity-50">Fetch Quote</button>
              <button type="button" disabled={marketLoading} onClick={fetchMarketHistory} className="rounded-2xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-violet-500 disabled:opacity-50">Daily History</button>
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
                <button type="button" onClick={fillTradePrices} className="rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500">Use For Trade Prices</button>
              </div>
            )}
          </div>

          <div className={`${t.card} p-6`}>
            <h2 className={`text-base font-semibold ${t.heading} mb-4`}>Add Trade</h2>
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
              <button type="submit" className="mt-3 rounded-2xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-500">Add Trade</button>
            </form>
          </div>
        </section>

        {/* ── Performance History ── */}
        <section className="grid gap-6 xl:grid-cols-2">
          <article className={`${t.card} p-6`}>
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className={`text-xl font-semibold ${t.heading}`}>Performance History</h2>
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
            <h2 className={`text-xl font-semibold ${t.heading}`}>P/L Graph</h2>
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

        {/* ── Current Plan (phase-scoped sessions) ── */}
        {(() => {
          const phaseInfo = PHASE_SCHEDULE.find((p) => p.phase === selectedPhase)
          const phasePrompt = PHASE_PROMPTS[selectedPhase]

          function handleSessionSubmit(e) {
            e.preventDefault()
            const parsed = parseAiPlanResponse(planDraft.response.trim())
            const watchList = planDraft.watchList.trim() || parsed.watchList
            const debugParsed = parseAiPlanResponse(planDraft.response.trim())
            setPlanStatus(`Saved — watchList="${watchList}" | parsed="${debugParsed.watchList}"`)
            saveSession(selectedPhase, {
              response: planDraft.response.trim(),
              watchList,
              notes: planDraft.notes.trim(),
            })
            setPlanDraft({ response: '', watchList: '', riskProfile: 'Medium', notes: '' })
          }

          async function handleCopyPrompt() {
            setMarketLoading(true)
            setPlanStatus('Fetching live data…')
            try {
              let moversContext = ''
              const moversRes = await fetch('/api/market?type=movers')
              if (moversRes.ok) {
                const movers = await moversRes.json()
                const fmt = (list) => list.map((s) => `${s.symbol} ${s.changePercent} @ $${s.price.toFixed(2)} vol ${(s.volume / 1e6).toFixed(1)}M`).join(', ')
                moversContext = `\n\nLIVE MARKET DATA for ${selectedDate}:\nTop gainers: ${fmt(movers.gainers)}\nTop losers: ${fmt(movers.losers)}\nMost active: ${fmt(movers.mostActive)}`
              }
              const prompt = `${phasePrompt || DEFAULT_PROMPT}${moversContext}\n\nToday is ${selectedDate}.`
              await navigator.clipboard.writeText(prompt)
              setPlanStatus('Prompt copied — paste into Gemini, then paste the response below.')
            } catch {
              setPlanStatus('Could not copy to clipboard.')
            } finally {
              setMarketLoading(false)
            }
          }

          async function handleGenerateFromAI() {
            setMarketLoading(true)
            setPlanStatus('Generating from AI…')
            try {
              let moversContext = ''
              const moversRes = await fetch('/api/market?type=movers')
              if (moversRes.ok) {
                const movers = await moversRes.json()
                const fmt = (list) => list.map((s) => `${s.symbol} ${s.changePercent} @ $${s.price.toFixed(2)} vol ${(s.volume / 1e6).toFixed(1)}M`).join(', ')
                moversContext = `\n\nLIVE MARKET DATA for ${selectedDate}:\nTop gainers: ${fmt(movers.gainers)}\nTop losers: ${fmt(movers.losers)}\nMost active: ${fmt(movers.mostActive)}`
              }
              const provider = data.settings.languageModelProvider || 'gemini'
              const aiRes = await fetch('/api/ai', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider, prompt: `${phasePrompt || DEFAULT_PROMPT}${moversContext}\n\nToday is ${selectedDate}.` }),
              })
              if (!aiRes.ok) throw new Error('AI request failed')
              const result = await aiRes.json()
              const aiText = result?.text?.trim() || ''
              if (!aiText) throw new Error('AI returned empty response')
              const parsed = parseAiPlanResponse(aiText)
              saveSession(selectedPhase, { response: parsed.plan, watchList: parsed.watchList, notes: parsed.notes })
              setPlanStatus(`Session generated for ${phaseInfo?.label}.`)
            } catch (err) {
              setPlanStatus(err.message || 'AI generation failed.')
            } finally {
              setMarketLoading(false)
            }
          }

          return (
            <section className={`${t.card} p-6`}>
              <div className="flex items-center justify-between gap-3 mb-1">
                <h2 className={`text-xl font-semibold ${t.heading}`}>Current Plan</h2>
                <span className={`text-sm font-medium px-3 py-1 rounded-xl ${dk ? 'bg-blue-900/40 text-blue-300' : 'bg-blue-100 text-blue-700'}`}>
                  {phaseInfo?.label || selectedPhase}
                </span>
              </div>
              <p className={`text-sm ${t.muted} mb-6`}>{phaseInfo?.description}</p>

              {!activeSession ? (
                <form onSubmit={handleSessionSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <label className={`text-sm font-medium ${t.body}`}>Phase prompt</label>
                    <textarea readOnly value={phasePrompt || DEFAULT_PROMPT} rows={3} className={`w-full rounded-2xl border p-3 text-sm outline-none ${t.input} opacity-70`} />
                  </div>
                  <div className="space-y-2">
                    <label className={`text-sm font-medium ${t.body}`}>Paste AI response</label>
                    <textarea value={planDraft.response} onChange={(e) => setPlanDraft((p) => ({ ...p, response: e.target.value }))} rows={5} className={`w-full rounded-2xl border p-3 text-sm outline-none ${t.input}`} placeholder="Paste Gemini's response here…" />
                  </div>
                  <div className="space-y-2">
                    <label className={`text-sm font-medium ${t.body}`}>Watch list (auto-extracted if blank)</label>
                    <input value={planDraft.watchList} onChange={(e) => setPlanDraft((p) => ({ ...p, watchList: e.target.value }))} className={`w-full rounded-2xl border p-3 text-sm outline-none ${t.input}`} placeholder="AAPL, NVDA, TSLA — leave blank to auto-extract from response" />
                  </div>
                  <div className="space-y-2">
                    <label className={`text-sm font-medium ${t.body}`}>Notes</label>
                    <input value={planDraft.notes} onChange={(e) => setPlanDraft((p) => ({ ...p, notes: e.target.value }))} className={`w-full rounded-2xl border p-3 text-sm outline-none ${t.input}`} placeholder="Key levels, discipline, exit conditions…" />
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <button type="submit" className="rounded-2xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 transition">Save Session</button>
                    <button type="button" onClick={handleGenerateFromAI} disabled={marketLoading} className="rounded-2xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 transition disabled:opacity-50">Generate From AI</button>
                    <button type="button" onClick={handleCopyPrompt} disabled={marketLoading} className="rounded-2xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 transition disabled:opacity-50">Copy Prompt</button>
                    <select value={data.settings.languageModelProvider || 'gemini'} onChange={(event) => { const languageModelProvider = event.target.value; setData((current) => ({ ...current, settings: { ...current.settings, languageModelProvider } })); api.updateSettings({ languageModelProvider }) }} className={`rounded-2xl border px-3 py-2.5 text-sm outline-none ${t.input}`}>
                      <option value="gemini">Gemini</option>
                      <option value="openai">OpenAI</option>
                    </select>
                  </div>
                  {planStatus && <p className={`text-sm ${t.scanStatus}`}>{planStatus}</p>}
                </form>
              ) : (
                <div className="space-y-5">
                  <div>
                    <p className={`text-xs uppercase tracking-widest ${t.muted} mb-2`}>AI Response</p>
                    <p className={`whitespace-pre-wrap rounded-2xl p-4 text-sm ${dk ? 'bg-slate-800 text-slate-200' : 'bg-gray-50 text-gray-800'}`}>{activeSession.response}</p>
                  </div>
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <p className={`text-xs uppercase tracking-widest ${t.muted}`}>Watch list</p>
                      <span className={`text-xs ${t.faint}`}>Edit to update symbols</span>
                    </div>
                    <textarea
                      value={activeSession.watchList}
                      onChange={(e) => {
                        const newWatchList = e.target.value
                        setData((current) => ({
                          ...current,
                          dailySessions: (current.dailySessions || []).map((s) =>
                            s.id === activeSession.id ? { ...s, watchList: newWatchList } : s
                          ),
                        }))
                        clearTimeout(watchListDebounce.current)
                        watchListDebounce.current = setTimeout(() => {
                          api.saveSession({ ...activeSession, watchList: newWatchList })
                        }, 800)
                      }}
                      rows={2}
                      placeholder="AAPL, NVDA, TSLA"
                      className={`w-full rounded-2xl border p-3 text-sm outline-none ${t.input}`}
                    />
                  </div>
                  {activeSession.notes && (
                    <div>
                      <p className={`text-xs uppercase tracking-widest ${t.muted} mb-1`}>Notes</p>
                      <p className={`text-sm ${t.body}`}>{activeSession.notes}</p>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-3">
                    <button type="button" onClick={handleGenerateFromAI} disabled={marketLoading} className="rounded-2xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 transition disabled:opacity-50">Regenerate From AI</button>
                    <button type="button" onClick={handleCopyPrompt} disabled={marketLoading} className="rounded-2xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 transition disabled:opacity-50">Copy Prompt</button>
                    <button type="button" onClick={() => clearSession(selectedPhase)} className="rounded-2xl bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-rose-500 transition">Clear Session</button>
                  </div>
                  {planStatus && <p className={`text-sm ${t.scanStatus}`}>{planStatus}</p>}
                </div>
              )}
            </section>
          )
        })()}

        {/* ── Activity Log ── */}
        {(() => {
          const todayLog = (data.activityLog || []).filter((e) => e.date === selectedDate).slice().reverse()
          if (todayLog.length === 0) return null
          return (
            <section className={`${t.card} p-5`}>
              <div className="flex items-center justify-between gap-4">
                <h2 className={`text-base font-semibold ${t.heading}`}>Activity Log</h2>
                <span className={`text-xs ${t.faint}`}>{todayLog.length} event{todayLog.length !== 1 ? 's' : ''} today</span>
              </div>
              <div className="mt-4 space-y-2 max-h-64 overflow-y-auto">
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
      </div>

      {/* ── Debug footer ── */}
      <div className={`mt-2 mb-6 mx-auto max-w-7xl px-4`}>
        <div className={`rounded-2xl border ${t.divider} ${dk ? 'bg-slate-900/60' : 'bg-gray-50'} px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-1`}>
          <span className={`text-xs font-semibold ${dk ? 'text-emerald-400' : 'text-emerald-600'}`}>⬡ DynamoDB</span>
          <span className={`text-xs ${t.faint}`}>{data.trades.length} trades · {data.dailySessions.length} sessions · {(data.executedSignals || []).length} signals · {(data.activityLog || []).length} activity</span>
          <span className={`text-xs ${dk ? 'text-amber-400' : 'text-amber-600'}`}>⚠ Demo thresholds — gap 0.5% · RSI 60/40 · power-hour 0.2%</span>
          <span className={`text-xs ${t.faint} ml-auto`}>v{VERSION}</span>
        </div>
      </div>
    </div>
  )
}
