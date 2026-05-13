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
  const normalized = text.replace(/\r/g, '')
  const planMatch = normalized.match(/Plan\s*[:]\s*([\s\S]*?)(?=(Watch list|Watchlist|Notes|$))/i)
  const watchMatch = normalized.match(/Watch\s*list\s*[:]\s*([\s\S]*?)(?=(Notes|$))/i)
  const notesMatch = normalized.match(/Notes\s*[:]\s*([\s\S]*)/i)
  const plan = planMatch ? planMatch[1].trim() : normalized.trim()
  const watchList = watchMatch ? watchMatch[1].trim().replace(/[\r\n]+/g, ' ').replace(/\s*,\s*/g, ', ') : ''
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
      settings: { languageModelProvider: loaded.settings?.languageModelProvider || 'openai' },
    }
  })
  const [selectedDate, setSelectedDate] = useState(today)
  const [planDraft, setPlanDraft] = useState({ response: '', watchList: '', riskProfile: 'Medium', notes: '' })
  const [tradeDraft, setTradeDraft] = useState({ symbol: '', action: 'Buy', quantity: '', entryPrice: '', exitPrice: '', riskRating: 'Medium', notes: '' })
  const [marketSymbol, setMarketSymbol] = useState('')
  const [intradayInterval, setIntradayInterval] = useState('5min')
  const [marketStatus, setMarketStatus] = useState('')
  const [planStatus, setPlanStatus] = useState('')
  const [marketLoading, setMarketLoading] = useState(false)
  const [liveSignals, setLiveSignals] = useState([])
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
    if (!dailyPlan || dailyPlan.watchList.trim() || selectedDate !== today) return
    const provider = dataRef.current?.settings?.languageModelProvider || 'openai'
    fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        prompt: `Today is ${selectedDate}. Based on the following intraday trading strategy, identify the 3-5 best specific US stock ticker symbols to actively trade today. Pick names that are likely to have high volatility and volume.\n\nStrategy:\n${dailyPlan.response}\n\nReturn ONLY a comma-separated list of ticker symbols, nothing else. Example: NVDA, TSLA, AAPL`,
      }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((result) => {
        const symbols = parseWatchSymbols(result?.text || '')
        if (symbols.length === 0) return
        setData((current) => ({
          ...current,
          dailyPlans: current.dailyPlans.map((p) =>
            p.id === dailyPlan.id ? { ...p, watchList: symbols.join(', ') } : p,
          ),
        }))
        setPlanStatus(`Watch list auto-populated: ${symbols.join(', ')}`)
      })
      .catch(() => setPlanStatus(''))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dailyPlan?.id])

  function submitPlan(event) {
    event.preventDefault()
    const plan = {
      id: createId(),
      date: selectedDate,
      prompt: DEFAULT_PROMPT,
      response: planDraft.response.trim(),
      watchList: planDraft.watchList.trim(),
      riskProfile: planDraft.riskProfile,
      notes: planDraft.notes.trim(),
      createdAt: new Date().toISOString(),
    }
    if (!plan.response) return
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

  function scanForSignals() {
    const symbols = parseWatchSymbols(dailyPlan?.watchList || '')
    const { signals, phase } = buildSignals(symbols, data.marketData)
    setTradingPhase(phase)
    setLiveSignals(signals)
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
    if (symbols.length === 0) return

    const updatedMarketData = { ...marketDataRef.current }
    for (const symbol of symbols) {
      try {
        const response = await fetch(`/api/market?type=intraday&symbol=${encodeURIComponent(symbol)}&interval=5min`)
        if (response.ok) {
          updatedMarketData[symbol] = { ...(updatedMarketData[symbol] || {}), intraday: await response.json() }
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
  }

  // Keep ref current so the interval always calls the latest version without stale closure
  useEffect(() => { refreshAndScanRef.current = refreshAndScan })

  useEffect(() => {
    const isToday = selectedDate === today
    const hour = getCurrentHour()
    const isMarketHours = hour >= 9.5 && hour <= 16
    if (!isToday || !isMarketHours || !dailyPlan) return
    const intervalId = setInterval(() => {
      if (getCurrentHour() >= 9.5 && getCurrentHour() <= 16) refreshAndScanRef.current?.()
    }, 5 * 60 * 1000)
    return () => clearInterval(intervalId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dailyPlan?.id, selectedDate])

  async function generateMorningPlanFromAI() {
    const provider = data.settings.languageModelProvider || 'openai'
    setMarketLoading(true)
    setPlanStatus('Generating morning plan from AI...')

    try {
      const prompt = `${DEFAULT_PROMPT}\n\nToday is ${selectedDate}. Based on current market conditions, provide a specific trading plan with real ticker symbols.\n\nFormat your reply EXACTLY as follows — no other sections:\nPlan: [2-3 sentence strategy for today]\nWatch list: [3-5 specific US stock ticker symbols, comma-separated — e.g. AAPL, NVDA, TSLA]\nNotes: [stop loss levels, position sizing rules, hard exit time]`
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
  const currentSeries = currentMarketData?.dailySeries || []
  const currentIntraday = currentMarketData?.intraday || []
  const todaysMetrics = computeMetrics(selectedDate)

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 px-4 py-6">
      <div className="mx-auto max-w-7xl space-y-8">
        <header className="rounded-3xl border border-slate-800 bg-slate-900/90 p-6 shadow-xl shadow-black/30">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.24em] text-slate-400">Research Exercise</p>
              <h1 className="mt-3 text-3xl font-semibold text-white">Daily intraday investor planner</h1>
              <p className="mt-2 max-w-2xl text-slate-400">
                Log your morning market strategy, capture all hypothetical trades, and measure whether the day followed your plan.
              </p>
              <p className="mt-1 text-xs text-slate-500">Version: {VERSION}</p>
            </div>
            <div className="space-y-2">
              <div className="rounded-3xl bg-slate-800/80 px-4 py-3 text-sm text-slate-300 ring-1 ring-slate-700">
                Current day: <span className="font-semibold text-white">{displayDate(selectedDate)}</span>
              </div>
            </div>
          </div>
        </header>

        <section className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
          <article className="rounded-3xl border border-slate-800 bg-slate-900/90 p-6">
            <h2 className="text-xl font-semibold text-white">Morning plan</h2>
            <p className="mt-2 text-slate-400">Answer the research prompt and describe the decision parameters you will monitor today.</p>
            {!dailyPlan ? (
              <form onSubmit={submitPlan} className="mt-6 space-y-5">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-200">Research prompt</label>
                  <textarea readOnly value={DEFAULT_PROMPT} rows={3} className="w-full rounded-2xl bg-slate-950/80 border border-slate-700 p-3 text-sm text-slate-200 outline-none" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-200">Your plan</label>
                  <textarea value={planDraft.response} onChange={(event) => setPlanDraft((prev) => ({ ...prev, response: event.target.value }))} rows={4} className="w-full rounded-2xl bg-slate-950/80 border border-slate-700 p-3 text-sm text-slate-200 outline-none" placeholder="What are you doing today?" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-200">Key parameters / watch list</label>
                  <textarea value={planDraft.watchList} onChange={(event) => setPlanDraft((prev) => ({ ...prev, watchList: event.target.value }))} rows={3} className="w-full rounded-2xl bg-slate-950/80 border border-slate-700 p-3 text-sm text-slate-200 outline-none" placeholder="Symbols, sectors, signals, macro cues, time windows..." />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block text-sm font-medium text-slate-200">
                    Risk profile
                    <select value={planDraft.riskProfile} onChange={(event) => setPlanDraft((prev) => ({ ...prev, riskProfile: event.target.value }))} className="mt-2 w-full rounded-2xl bg-slate-950/80 border border-slate-700 p-3 text-slate-200 outline-none">
                      <option>Low</option>
                      <option>Medium</option>
                      <option>High</option>
                    </select>
                  </label>
                  <label className="block text-sm font-medium text-slate-200">
                    Notes
                    <input value={planDraft.notes} onChange={(event) => setPlanDraft((prev) => ({ ...prev, notes: event.target.value }))} className="mt-2 w-full rounded-2xl bg-slate-950/80 border border-slate-700 p-3 text-slate-200 outline-none" placeholder="Additional discipline, exit conditions, portfolio sizing" />
                  </label>
                </div>
                <div className="flex flex-wrap gap-3">
                  <button type="submit" className="inline-flex items-center justify-center rounded-2xl bg-emerald-500 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400">
                    Save morning plan
                  </button>
                  <button type="button" onClick={generateMorningPlanFromAI} disabled={marketLoading} className="inline-flex items-center justify-center rounded-2xl bg-blue-500 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-blue-400">
                    Generate plan from AI
                  </button>
                </div>
                {planStatus && <p className="mt-3 text-sm text-slate-300">{planStatus}</p>}
              </form>
            ) : (
              <div className="mt-6 space-y-5 rounded-3xl border border-slate-800 bg-slate-950/80 p-5">
                <div>
                  <p className="text-sm uppercase tracking-[0.24em] text-slate-400">Morning response</p>
                  <p className="mt-3 whitespace-pre-wrap rounded-3xl bg-slate-900/80 p-4 text-sm text-slate-100">{dailyPlan.response}</p>
                </div>
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm uppercase tracking-[0.24em] text-slate-400">Watch list — ticker symbols</p>
                    <span className="text-xs text-slate-500">Edit to add/change symbols for auto-trading</span>
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
                    className="mt-2 w-full rounded-2xl bg-slate-900/80 border border-slate-700 p-3 text-sm text-slate-100 outline-none"
                  />
                  {planStatus && parseWatchSymbols(dailyPlan.watchList).length === 0 && (
                    <p className="mt-2 text-xs text-amber-400">{planStatus}</p>
                  )}
                </div>
                <div className="mt-4 flex flex-wrap gap-3">
                  <button type="button" onClick={generateMorningPlanFromAI} disabled={marketLoading} className="inline-flex items-center justify-center rounded-2xl bg-blue-500 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-blue-400 disabled:bg-slate-700">
                    Regenerate plan from AI
                  </button>
                  <button type="button" onClick={scanForSignals} disabled={marketLoading || !dailyPlan} className="inline-flex items-center justify-center rounded-2xl bg-amber-600 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-amber-500 disabled:bg-slate-700">
                    Scan now
                  </button>
                  <button type="button" onClick={clearDailyPlan} className="inline-flex items-center justify-center rounded-2xl bg-rose-700 px-4 py-3 text-sm font-semibold text-slate-100 transition hover:bg-rose-600">
                    Clear plan
                  </button>
                </div>
                {planInterpretation && <p className="mt-3 text-sm text-slate-300">{planInterpretation}</p>}
                {planStatus && <p className="mt-3 text-sm text-slate-300">{planStatus}</p>}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="rounded-3xl bg-slate-900/80 p-4">
                    <p className="text-sm text-slate-400">Risk profile</p>
                    <p className="mt-2 text-lg font-semibold text-white">{dailyPlan.riskProfile}</p>
                  </div>
                  <div className="rounded-3xl bg-slate-900/80 p-4">
                    <p className="text-sm text-slate-400">Notes</p>
                    <p className="mt-2 text-lg text-slate-200">{dailyPlan.notes || '—'}</p>
                  </div>
                </div>
              </div>
            )}
          </article>

          <aside className="space-y-6 rounded-3xl border border-slate-800 bg-slate-900/90 p-6">
            <div className="rounded-3xl bg-slate-950/80 p-5">
              <p className="text-sm uppercase tracking-[0.24em] text-slate-400">Today’s KPI</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-3xl bg-slate-900/80 p-4">
                  <p className="text-sm text-slate-400">Net P/L</p>
                  <p className={`mt-2 text-2xl font-semibold ${todaysMetrics.totalPL >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>${todaysMetrics.totalPL.toFixed(2)}</p>
                </div>
                <div className="rounded-3xl bg-slate-900/80 p-4">
                  <p className="text-sm text-slate-400">Trades</p>
                  <p className="mt-2 text-2xl font-semibold text-white">{todaysMetrics.trades}</p>
                </div>
                <div className="rounded-3xl bg-slate-900/80 p-4">
                  <p className="text-sm text-slate-400">Avg risk rating</p>
                  <p className="mt-2 text-2xl font-semibold text-white">{todaysMetrics.avgRiskRating}</p>
                </div>
                <div className="rounded-3xl bg-slate-900/80 p-4">
                  <p className="text-sm text-slate-400">Risk / reward</p>
                  <p className="mt-2 text-2xl font-semibold text-white">{todaysMetrics.riskReward}</p>
                </div>
              </div>
            </div>
            <div className="rounded-3xl bg-slate-950/80 p-5">
              <p className="text-sm uppercase tracking-[0.24em] text-slate-400">Date selector</p>
              <input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} className="mt-3 w-full rounded-2xl bg-slate-900/80 border border-slate-700 p-3 text-slate-200 outline-none" />
            </div>
          </aside>
        </section>

        {/* Pending Decisions */}
        <section className="rounded-3xl border border-slate-800 bg-slate-900/90 p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-white">Pending decisions</h2>
              <p className="mt-1 text-sm text-slate-400">Today's trading schedule — the app auto-executes each phase as market hours progress.</p>
            </div>
            <span className="shrink-0 rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-400">
              {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ET
            </span>
          </div>
          <div className="mt-5 space-y-3">
            {pendingDecisions.map((decision) => (
              <div key={decision.phase} className={`rounded-2xl border p-4 transition ${
                decision.status === 'active'
                  ? 'border-amber-600/50 bg-amber-950/20'
                  : decision.status === 'completed'
                  ? 'border-slate-700/40 bg-slate-900/30 opacity-60'
                  : 'border-slate-700/50 bg-slate-900/50'
              }`}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-slate-500 font-mono">{decision.window}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        decision.status === 'active'    ? 'bg-amber-500/20 text-amber-300' :
                        decision.status === 'completed' ? 'bg-slate-600/40 text-slate-400' :
                                                          'bg-slate-700/40 text-slate-400'
                      }`}>
                        {decision.status === 'active' ? 'Active now' : decision.status === 'completed' ? 'Done' : 'Pending'}
                      </span>
                      {decision.events.length > 0 && (
                        <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-300">
                          {decision.events.length} trade{decision.events.length !== 1 ? 's' : ''} executed
                        </span>
                      )}
                    </div>
                    <p className={`mt-1 font-semibold ${decision.status === 'active' ? 'text-white' : 'text-slate-300'}`}>
                      {decision.label}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">{decision.description}</p>
                    {decision.events.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {decision.events.map((e) => (
                          <span key={e.id} className="rounded-lg bg-slate-800 px-2 py-1 text-xs text-slate-300">
                            {e.message}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className={`shrink-0 w-2 h-2 rounded-full mt-2 ${
                    decision.status === 'active'    ? 'bg-amber-400 animate-pulse' :
                    decision.status === 'completed' ? 'bg-emerald-500' :
                                                      'bg-slate-600'
                  }`} />
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Live Trading Interpreter */}
        <section className="rounded-3xl border border-slate-800 bg-slate-900/90 p-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-white">Live trading interpreter</h2>
              <p className="mt-2 text-slate-400">Real-time signal detection based on market phase and technical patterns.</p>
            </div>
            <div className="text-right text-xs text-slate-500 shrink-0">
              {lastAutoScan
                ? <span>Auto-scanned {new Date(lastAutoScan).toLocaleTimeString()}</span>
                : selectedDate === today && dailyPlan && parseWatchSymbols(dailyPlan.watchList).length > 0
                  ? <span className="text-amber-500">Auto-scan active — runs every 5 min during market hours</span>
                  : null}
            </div>
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="rounded-3xl bg-slate-950/80 p-4">
              <p className="text-sm text-slate-400">Current Phase</p>
              <p className="mt-2 text-lg font-semibold capitalize text-white">{tradingPhase.replace(/-/g, ' ')}</p>
              <p className="mt-1 text-xs text-slate-500">{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
            </div>
            <div className="rounded-3xl bg-slate-950/80 p-4">
              <p className="text-sm text-slate-400">Active Signals</p>
              <p className="mt-2 text-lg font-semibold text-amber-400">{liveSignals.length}</p>
              <p className="mt-1 text-xs text-slate-500">detected this scan</p>
            </div>
          </div>

          {liveSignals.length > 0 && (
            <div className="mt-6 space-y-3">
              <p className="text-sm uppercase tracking-[0.24em] text-slate-400">Signal alerts</p>
              {liveSignals.map((signal) => (
                <div key={signal.id} className={`rounded-2xl p-4 border ${
                  signal.type === 'gapper' ? 'border-green-800/50 bg-green-950/30' :
                  signal.type === 'orb-breakout' ? 'border-blue-800/50 bg-blue-950/30' :
                  signal.type === 'mean-reversion' ? 'border-orange-800/50 bg-orange-950/30' :
                  signal.type === 'power-hour' ? 'border-cyan-800/50 bg-cyan-950/30' :
                  'border-red-800/50 bg-red-950/30'
                }`}>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <p className="font-semibold text-white">{signal.message}</p>
                      <p className="mt-1 text-sm text-slate-300">{signal.action}</p>
                      <p className="mt-1 text-xs text-slate-500">{new Date(signal.timestamp).toLocaleTimeString()}</p>
                    </div>
                    <span className={`ml-3 inline-block rounded-full px-3 py-1 text-xs font-medium ${
                      signal.type === 'gapper' ? 'bg-green-500/20 text-green-300' :
                      signal.type === 'orb-breakout' ? 'bg-blue-500/20 text-blue-300' :
                      signal.type === 'mean-reversion' ? 'bg-orange-500/20 text-orange-300' :
                      signal.type === 'power-hour' ? 'bg-cyan-500/20 text-cyan-300' :
                      'bg-red-500/20 text-red-300'
                    }`}>
                      {signal.type.replace('-', ' ')}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {liveSignals.length === 0 && (
            <div className="mt-6 rounded-3xl border border-slate-700/50 bg-slate-800/30 p-6 text-center">
              <p className="text-slate-400">
                {dailyPlan && parseWatchSymbols(dailyPlan.watchList).length > 0
                  ? 'Waiting for signals. Auto-scan runs every 5 min during market hours.'
                  : 'Symbols are being identified — scan will begin automatically.'}
              </p>
            </div>
          )}
        </section>

        {/* Activity Log */}
        {(() => {
          const todayLog = (data.activityLog || []).filter((e) => e.date === selectedDate).slice().reverse()
          if (todayLog.length === 0) return null
          return (
            <section className="rounded-3xl border border-slate-800 bg-slate-900/90 p-6">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-xl font-semibold text-white">Activity log</h2>
                  <p className="mt-1 text-slate-400 text-sm">Auto-executed trades and signals for {displayDate(selectedDate)}.</p>
                </div>
                <span className="text-xs text-slate-500">{todayLog.length} event{todayLog.length !== 1 ? 's' : ''}</span>
              </div>
              <div className="mt-5 space-y-2 max-h-72 overflow-y-auto">
                {todayLog.map((entry) => (
                  <div key={entry.id} className={`flex items-start gap-3 rounded-2xl p-3 ${
                    entry.type === 'hard-exit' ? 'bg-red-950/40 border border-red-800/40' :
                    entry.type === 'orb-breakout' ? 'bg-blue-950/30 border border-blue-800/30' :
                    entry.type === 'gapper' ? 'bg-green-950/30 border border-green-800/30' :
                    entry.type === 'mean-reversion' ? 'bg-orange-950/30 border border-orange-800/30' :
                    entry.type === 'power-hour' ? 'bg-cyan-950/30 border border-cyan-800/30' :
                    'bg-slate-800/40 border border-slate-700/40'
                  }`}>
                    <span className="mt-0.5 shrink-0 text-xs text-slate-500">{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white">{entry.message}</p>
                      {entry.detail && <p className="mt-0.5 text-xs text-slate-400">{entry.detail}</p>}
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                      entry.type === 'hard-exit' ? 'bg-red-500/20 text-red-300' :
                      entry.type === 'orb-breakout' ? 'bg-blue-500/20 text-blue-300' :
                      entry.type === 'gapper' ? 'bg-green-500/20 text-green-300' :
                      entry.type === 'mean-reversion' ? 'bg-orange-500/20 text-orange-300' :
                      entry.type === 'power-hour' ? 'bg-cyan-500/20 text-cyan-300' :
                      'bg-slate-500/20 text-slate-300'
                    }`}>{entry.type?.replace(/-/g, ' ')}</span>
                  </div>
                ))}
              </div>
            </section>
          )
        })()}

        <section className="rounded-3xl border border-slate-800 bg-slate-900/90 p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-white">Trade journal</h2>
              <p className="mt-2 text-slate-400">Auto-executed trades appear here throughout the day. You can also add trades manually below.</p>
            </div>
            <div className="flex flex-col gap-3 sm:items-end">
              <div className="rounded-3xl bg-slate-950/80 px-4 py-3 text-sm text-slate-300 ring-1 ring-slate-700">
                Starting capital: <span className="font-semibold text-white">${STARTING_CASH.toLocaleString()}</span>
              </div>
              <div className="flex flex-wrap gap-3">
                <button type="button" onClick={exportDayCsv} className="inline-flex items-center justify-center rounded-2xl bg-emerald-500 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400">
                  Export day CSV
                </button>
                <button type="button" onClick={exportAllCsv} className="inline-flex items-center justify-center rounded-2xl bg-slate-500 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-slate-400">
                  Export all CSV
                </button>
              </div>
            </div>
          </div>

          <div className="mt-6 grid gap-4 rounded-3xl border border-slate-800 bg-slate-950/80 p-5 sm:grid-cols-[1.1fr_0.9fr]">
            <div className="space-y-4">
              <label className="block text-sm font-medium text-slate-200">
                AI provider
                <select value={data.settings.languageModelProvider || 'openai'} onChange={(event) => setData((current) => ({
                  ...current,
                  settings: {
                    ...current.settings,
                    languageModelProvider: event.target.value,
                  },
                }))} className="mt-2 w-full rounded-2xl bg-slate-900/80 border border-slate-700 p-3 text-slate-200 outline-none">
                  <option value="openai">OpenAI</option>
                  <option value="gemini">Gemini</option>
                </select>
              </label>
              <div className="rounded-3xl bg-slate-950/80 p-4 text-sm text-slate-300">
                <p className="text-slate-400">API secrets are stored on the server.</p>
                <p className="mt-2">Deploy with your environment variables instead of saving keys in the browser.</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm font-medium text-slate-200">
                  Symbol
                  <input value={marketSymbol} onChange={(event) => setMarketSymbol(event.target.value.toUpperCase())} placeholder="AAPL" className="mt-2 w-full rounded-2xl bg-slate-900/80 border border-slate-700 p-3 text-slate-200 outline-none" />
                </label>
                <label className="block text-sm font-medium text-slate-200">
                  Interval
                  <select value={intradayInterval} onChange={(event) => setIntradayInterval(event.target.value)} className="mt-2 w-full rounded-2xl bg-slate-900/80 border border-slate-700 p-3 text-slate-200 outline-none">
                    <option>5min</option>
                    <option>15min</option>
                    <option>30min</option>
                    <option>60min</option>
                  </select>
                </label>
              </div>
              <div className="flex flex-wrap gap-3 pt-6">
                <button type="button" disabled={marketLoading} onClick={fetchMarketQuote} className="inline-flex items-center justify-center rounded-2xl bg-sky-500 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-sky-400 disabled:bg-slate-700">
                  Fetch quote
                </button>
                <button type="button" disabled={marketLoading} onClick={fetchMarketHistory} className="inline-flex items-center justify-center rounded-2xl bg-violet-500 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-violet-400 disabled:bg-slate-700">
                  Load daily history
                </button>
                <button type="button" disabled={marketLoading} onClick={fetchMarketIntraday} className="inline-flex items-center justify-center rounded-2xl bg-fuchsia-500 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-fuchsia-400 disabled:bg-fuchsia-700">
                  Load intraday data
                </button>
              </div>
              <p className="text-sm text-slate-400">{marketStatus || 'Market and AI keys are stored securely on the server.'}</p>
            </div>
            <div className="rounded-3xl bg-slate-900/80 p-4 text-sm text-slate-300">
              {currentQuote ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Latest quote</p>
                      <p className="mt-2 text-lg font-semibold text-white">{currentQuote.symbol}</p>
                    </div>
                    <div className="rounded-2xl bg-slate-950/80 px-3 py-2 text-xs uppercase tracking-[0.18em] text-slate-300">{currentQuote.changePercent}</div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-3xl bg-slate-950/80 p-3">
                      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Price</p>
                      <p className="mt-2 text-lg font-semibold text-white">${currentQuote.price.toFixed(2)}</p>
                    </div>
                    <div className="rounded-3xl bg-slate-950/80 p-3">
                      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Prev close</p>
                      <p className="mt-2 text-lg font-semibold text-white">${currentQuote.previousClose.toFixed(2)}</p>
                    </div>
                  </div>
                  <button type="button" onClick={fillTradePrices} className="mt-3 inline-flex items-center justify-center rounded-2xl bg-emerald-500 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400">
                    Use latest quote for trade prices
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-slate-400">Market quote will appear here after fetch.</p>
                </div>
              )}
              {currentSeries.length > 0 && (
                <div className="mt-4 rounded-3xl bg-slate-950/80 p-3">
                  <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Recent daily closes</p>
                  <div className="mt-3 space-y-2 text-slate-100">
                    {currentSeries.slice(0, 3).map((item) => (
                      <div key={item.date} className="flex items-center justify-between rounded-2xl bg-slate-900/80 px-3 py-2">
                        <span className="text-sm">{item.date}</span>
                        <span className="text-sm font-semibold">${item.close.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {currentIntraday.length > 0 && (
                <div className="mt-4 rounded-3xl bg-slate-950/80 p-3">
                  <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Intraday summary</p>
                  <div className="mt-3 space-y-2 text-slate-100">
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="rounded-2xl bg-slate-900/80 p-3">
                        <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Points</p>
                        <p className="mt-2 text-lg font-semibold text-white">{currentIntraday.length}</p>
                      </div>
                      <div className="rounded-2xl bg-slate-900/80 p-3">
                        <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Latest</p>
                        <p className="mt-2 text-lg font-semibold text-white">${currentIntraday[0].close.toFixed(2)}</p>
                      </div>
                      <div className="rounded-2xl bg-slate-900/80 p-3">
                        <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Latest time</p>
                        <p className="mt-2 text-lg font-semibold text-white">{currentIntraday[0].dateTime}</p>
                      </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-4">
                      <div className="rounded-2xl bg-slate-900/80 p-3">
                        <p className="text-xs uppercase tracking-[0.18em] text-slate-500">High</p>
                        <p className="mt-2 text-lg font-semibold text-white">${Math.max(...currentIntraday.map((point) => point.high)).toFixed(2)}</p>
                      </div>
                      <div className="rounded-2xl bg-slate-900/80 p-3">
                        <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Low</p>
                        <p className="mt-2 text-lg font-semibold text-white">${Math.min(...currentIntraday.map((point) => point.low)).toFixed(2)}</p>
                      </div>
                      <div className="rounded-2xl bg-slate-900/80 p-3">
                        <p className="text-xs uppercase tracking-[0.18em] text-slate-500">VWAP</p>
                        <p className="mt-2 text-lg font-semibold text-cyan-300">${(calculateVWAP(currentIntraday) ?? 0).toFixed(2)}</p>
                      </div>
                      <div className="rounded-2xl bg-slate-900/80 p-3">
                        <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Latest volume</p>
                        <p className="mt-2 text-lg font-semibold text-white">{currentIntraday[0].volume.toLocaleString()}</p>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <form onSubmit={submitTrade} className="mt-6 grid gap-4 rounded-3xl border border-slate-800 bg-slate-950/80 p-5 sm:grid-cols-2 xl:grid-cols-[1fr_0.8fr]">
            <div className="grid gap-4">
              <label className="block text-sm font-medium text-slate-200">
                Symbol
                <input value={tradeDraft.symbol} onChange={(event) => setTradeDraft((prev) => ({ ...prev, symbol: event.target.value }))} placeholder="AAPL, MSFT" className="mt-2 w-full rounded-2xl bg-slate-900/80 border border-slate-700 p-3 text-slate-200 outline-none" />
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm font-medium text-slate-200">
                  Action
                  <select value={tradeDraft.action} onChange={(event) => setTradeDraft((prev) => ({ ...prev, action: event.target.value }))} className="mt-2 w-full rounded-2xl bg-slate-900/80 border border-slate-700 p-3 text-slate-200 outline-none">
                    <option>Buy</option>
                    <option>Sell</option>
                  </select>
                </label>
                <label className="block text-sm font-medium text-slate-200">
                  Quantity
                  <input type="number" value={tradeDraft.quantity} onChange={(event) => setTradeDraft((prev) => ({ ...prev, quantity: event.target.value }))} placeholder="100" className="mt-2 w-full rounded-2xl bg-slate-900/80 border border-slate-700 p-3 text-slate-200 outline-none" />
                </label>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm font-medium text-slate-200">
                  Entry price
                  <input type="number" step="0.01" value={tradeDraft.entryPrice} onChange={(event) => setTradeDraft((prev) => ({ ...prev, entryPrice: event.target.value }))} placeholder="150.00" className="mt-2 w-full rounded-2xl bg-slate-900/80 border border-slate-700 p-3 text-slate-200 outline-none" />
                </label>
                <label className="block text-sm font-medium text-slate-200">
                  Exit price
                  <input type="number" step="0.01" value={tradeDraft.exitPrice} onChange={(event) => setTradeDraft((prev) => ({ ...prev, exitPrice: event.target.value }))} placeholder="152.00" className="mt-2 w-full rounded-2xl bg-slate-900/80 border border-slate-700 p-3 text-slate-200 outline-none" />
                </label>
              </div>
            </div>
            <div className="grid gap-4">
              <label className="block text-sm font-medium text-slate-200">
                Risk rating
                <select value={tradeDraft.riskRating} onChange={(event) => setTradeDraft((prev) => ({ ...prev, riskRating: event.target.value }))} className="mt-2 w-full rounded-2xl bg-slate-900/80 border border-slate-700 p-3 text-slate-200 outline-none">
                  <option>Low</option>
                  <option>Medium</option>
                  <option>High</option>
                </select>
              </label>
              <label className="block text-sm font-medium text-slate-200">
                Trade notes
                <textarea value={tradeDraft.notes} onChange={(event) => setTradeDraft((prev) => ({ ...prev, notes: event.target.value }))} rows={4} className="mt-2 w-full rounded-2xl bg-slate-900/80 border border-slate-700 p-3 text-slate-200 outline-none" placeholder="Why this trade, watchlist signal, exit conditions..." />
              </label>
              <button type="submit" className="mt-auto inline-flex items-center justify-center rounded-2xl bg-sky-500 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-sky-400">
                Add trade
              </button>
            </div>
          </form>

          <div className="mt-6 overflow-x-auto rounded-3xl border border-slate-800 bg-slate-950/80">
            <table className="min-w-full border-collapse text-left text-sm">
              <thead className="bg-slate-900 text-slate-400">
                <tr>
                  <th className="px-4 py-3">Symbol</th>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Qty</th>
                  <th className="px-4 py-3">Entry</th>
                  <th className="px-4 py-3">Exit</th>
                  <th className="px-4 py-3">P/L</th>
                  <th className="px-4 py-3">Risk</th>
                  <th className="px-4 py-3">Notes</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {dailyTrades.length === 0 ? (
                  <tr>
                    <td colSpan="9" className="px-4 py-8 text-center text-slate-400">
                      No trades recorded for this day yet.
                    </td>
                  </tr>
                ) : (
                  dailyTrades.map((trade) => {
                    const pl = computeTradePL(trade)
                    const isAuto = trade.notes?.startsWith('Auto')
                    return (
                      <tr key={trade.id} className={`border-t border-slate-800 ${isAuto ? 'bg-slate-900/40' : ''}`}>
                        <td className="px-4 py-3 text-slate-100">
                          <div className="flex items-center gap-2">
                            {trade.symbol}
                            {isAuto && <span className="rounded-full bg-indigo-500/20 px-2 py-0.5 text-xs font-medium text-indigo-300">auto</span>}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-slate-100">{trade.action}</td>
                        <td className="px-4 py-3 text-slate-100">{trade.quantity}</td>
                        <td className="px-4 py-3 text-slate-100">${trade.entryPrice.toFixed(2)}</td>
                        <td className="px-4 py-3 text-slate-100">${trade.exitPrice.toFixed(2)}</td>
                        <td className={`px-4 py-3 font-semibold ${pl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>${pl.toFixed(2)}</td>
                        <td className="px-4 py-3 text-slate-100">{trade.riskRating}</td>
                        <td className="px-4 py-3 text-slate-300 max-w-[18rem] truncate">{trade.notes || '—'}</td>
                        <td className="px-4 py-3">
                          <button onClick={() => deleteTrade(trade.id)} className="rounded-2xl bg-rose-500 px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-950 transition hover:bg-rose-400">
                            Delete
                          </button>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
          <article className="rounded-3xl border border-slate-800 bg-slate-900/90 p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold text-white">Performance history</h2>
                <p className="mt-2 text-slate-400">Review recent daily outcomes and compare the plan to actual P/L.</p>
              </div>
            </div>

            <div className="mt-6 space-y-4">
              {history.length === 0 ? (
                <p className="text-slate-400">No historical days recorded yet.</p>
              ) : (
                history.map((date) => {
                  const metrics = computeMetrics(date)
                  return (
                    <div key={date} className="rounded-3xl bg-slate-950/80 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm text-slate-400">{displayDate(date)}</p>
                          <p className="mt-1 text-lg font-semibold text-white">Net P/L: ${metrics.totalPL.toFixed(2)}</p>
                        </div>
                        <div className="rounded-3xl bg-slate-900/80 px-3 py-2 text-sm text-slate-300">Trades: {metrics.trades}</div>
                      </div>
                      <div className="mt-4 grid gap-3 sm:grid-cols-3">
                        <div className="rounded-3xl bg-slate-900/80 p-3">
                          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Risk reward</p>
                          <p className="mt-2 text-lg font-semibold text-white">{metrics.riskReward}</p>
                        </div>
                        <div className="rounded-3xl bg-slate-900/80 p-3">
                          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Total risk</p>
                          <p className="mt-2 text-lg font-semibold text-white">{metrics.risk.toFixed(2)}</p>
                        </div>
                        <div className="rounded-3xl bg-slate-900/80 p-3">
                          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Reward</p>
                          <p className="mt-2 text-lg font-semibold text-white">{metrics.reward.toFixed(2)}</p>
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </article>

          <article className="rounded-3xl border border-slate-800 bg-slate-900/90 p-6">
            <h2 className="text-xl font-semibold text-white">P/L graph</h2>
            <p className="mt-2 text-slate-400">Daily profit and loss trend for your latest recorded days.</p>
            <div className="mt-6 space-y-3">
              {history.length === 0 ? (
                <p className="text-slate-400">Add a plan and trades to begin tracking daily performance.</p>
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
                        <div className="flex items-center justify-between gap-3 text-sm text-slate-300">
                          <span>{displayDate(date)}</span>
                          <span className={`${metrics.totalPL >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>${metrics.totalPL.toFixed(2)}</span>
                        </div>
                        <div className="h-3 rounded-full bg-slate-800">
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
      </div>
    </div>
  )
}
