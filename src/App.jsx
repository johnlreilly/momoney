import { useEffect, useMemo, useState } from 'react'
import { createId, loadData, saveData } from './storage.js'

const STARTING_CASH = 100000
const DEFAULT_PROMPT = `You're an investor in the U.S. stock market. You get trades for free and you have $100,000 to start with. You want to maximize returns each day but you want to exit all positions to cash at the end of the day. What are you doing today?`
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

export default function App() {
  const today = formatDate(new Date())
  const [data, setData] = useState({ dailyPlans: [], trades: [], marketData: {}, settings: { languageModelProvider: 'openai' } })
  const [selectedDate, setSelectedDate] = useState(today)
  const [planDraft, setPlanDraft] = useState({ response: '', watchList: '', riskProfile: 'Medium', notes: '' })
  const [tradeDraft, setTradeDraft] = useState({ symbol: '', action: 'Buy', quantity: '', entryPrice: '', exitPrice: '', riskRating: 'Medium', notes: '' })
  const [marketSymbol, setMarketSymbol] = useState('')
  const [intradayInterval, setIntradayInterval] = useState('5min')
  const [marketStatus, setMarketStatus] = useState('')
  const [planStatus, setPlanStatus] = useState('')
  const [marketLoading, setMarketLoading] = useState(false)

  useEffect(() => {
    const loaded = loadData()
    setData({
      dailyPlans: loaded.dailyPlans || [],
      trades: loaded.trades || [],
      marketData: loaded.marketData || {},
      settings: {
        languageModelProvider: loaded.settings?.languageModelProvider || 'openai',
      },
    })
  }, [])

  useEffect(() => {
    saveData(data)
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

  function parseWatchSymbols(text) {
    return (text || '')
      .split(/[,;|\s]+/)
      .map((token) => token.trim().toUpperCase().replace(/[^A-Z0-9.]/g, ''))
      .filter((token) => token.length > 0 && token.length <= 5)
  }

  function parseAiPlanResponse(text) {
    const normalized = text.replace(/\r/g, '')
    const planMatch = normalized.match(/Plan\s*[:\-]\s*([\s\S]*?)(?=(Watch list|Watchlist|Notes|$))/i)
    const watchMatch = normalized.match(/Watch\s*list\s*[:\-]\s*([\s\S]*?)(?=(Notes|$))/i)
    const notesMatch = normalized.match(/Notes\s*[:\-]\s*([\s\S]*)/i)
    const plan = planMatch ? planMatch[1].trim() : normalized.trim()
    const watchList = watchMatch ? watchMatch[1].trim().replace(/[\r\n]+/g, ' ').replace(/\s*,\s*/g, ', ') : ''
    const notes = notesMatch ? notesMatch[1].trim() : ''
    return { plan, watchList, notes }
  }

  function inferPlanAction(text) {
    const normalized = (text || '').toLowerCase()
    if (/(short|sell|exit|bearish|reduce|fade|trim|lighten|book profit|close position)/.test(normalized)) {
      return 'Sell'
    }
    if (/(buy|long|bullish|accumulate|add|buying|go long|strength|breakout|retest)/.test(normalized)) {
      return 'Buy'
    }
    return 'Buy'
  }

  function inferSymbolAction(symbol, text) {
    const normalized = (text || '').toLowerCase()
    const ticker = symbol.toLowerCase()
    if (new RegExp(`(?:short|sell|exit|bearish|reduce|fade|trim|lighten|book profit|close position).*\\b${ticker}\\b|\\b${ticker}\\b.*(?:short|sell|exit|bearish|reduce|fade|trim|lighten|book profit|close position)`, 'i').test(normalized)) {
      return 'Sell'
    }
    if (new RegExp(`(?:buy|long|bullish|accumulate|add|buying|go long|strength|breakout|retest).*\\b${ticker}\\b|\\b${ticker}\\b.*(?:buy|long|bullish|accumulate|add|buying|go long|strength|breakout|retest)`, 'i').test(normalized)) {
      return 'Buy'
    }
    return inferPlanAction(text)
  }

  async function generateMorningPlanFromAI() {
    const provider = data.settings.languageModelProvider || 'openai'
    setMarketLoading(true)
    setPlanStatus('Generating morning plan from AI...')

    try {
      const prompt = `${DEFAULT_PROMPT}\n\nPlease provide a concise plan and watch list. Format your reply like:\nPlan: ...\nWatch list: ...\nNotes: ...`
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

  function estimateQuantity(price) {
    if (!price || price <= 0) {
      return 10
    }
    if (price > 250) {
      return Math.max(1, Math.min(100, Math.floor(STARTING_CASH / price / 10)))
    }
    return Math.max(1, Math.min(300, Math.floor(1000 / price)))
  }

  function calculateExitPrice(entryPrice, action, intraday) {
    if (!entryPrice) return entryPrice
    const latest = intraday?.[0]?.close ?? entryPrice
    if (action === 'Buy') {
      const target = latest * 1.015
      if (intraday?.length > 1) {
        const high = Math.max(...intraday.map((point) => point.high))
        return Math.max(target, high || target)
      }
      return target
    }
    const target = latest * 0.985
    if (intraday?.length > 1) {
      const low = Math.min(...intraday.map((point) => point.low))
      return Math.min(target, low || target)
    }
    return target
  }

  async function followMorningAdvice() {
    if (!dailyPlan) {
      setPlanStatus('Save a morning plan first.')
      return
    }

    const symbols = parseWatchSymbols(dailyPlan.watchList)
    if (symbols.length === 0) {
      setPlanStatus('Add one or more ticker symbols to the watch list first.')
      return
    }

    setMarketLoading(true)
    setPlanStatus('Interpreting plan and generating hypothetical trades...')
    const trades = []
    const cachedMarketData = { ...data.marketData }

    for (const symbol of symbols) {
      const action = inferSymbolAction(symbol, dailyPlan.response || dailyPlan.watchList)
      try {
        if (!cachedMarketData[symbol]?.quote) {
          const response = await fetch(`/api/market?type=quote&symbol=${encodeURIComponent(symbol)}`)
          if (!response.ok) {
            const errorData = await response.json().catch(() => null)
            throw new Error(errorData?.error || `Could not fetch quote for ${symbol}`)
          }
          const quote = await response.json()
          cachedMarketData[symbol] = {
            ...(cachedMarketData[symbol] || {}),
            quote,
          }
        }
      } catch (error) {
        // skip symbols that cannot be fetched
        continue
      }

      const symbolMarket = cachedMarketData[symbol]
      if (!symbolMarket?.quote) {
        continue
      }

      let intraday = symbolMarket.intraday
      if (!intraday || intraday.length === 0) {
        try {
          const response = await fetch(`/api/market?type=intraday&symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(intradayInterval)}`)
          if (!response.ok) {
            const errorData = await response.json().catch(() => null)
            throw new Error(errorData?.error || `Could not fetch intraday data for ${symbol}`)
          }
          intraday = await response.json()
          cachedMarketData[symbol] = {
            ...symbolMarket,
            intraday,
          }
        } catch (error) {
          intraday = []
        }
      }

      const entryPrice = symbolMarket.quote.price
      const exitPrice = calculateExitPrice(entryPrice, action, intraday)
      trades.push({
        id: createId(),
        date: selectedDate,
        symbol,
        action,
        quantity: estimateQuantity(entryPrice),
        entryPrice,
        exitPrice,
        riskRating: dailyPlan.riskProfile || 'Medium',
        notes: `Auto-generated from plan: ${dailyPlan.response.slice(0, 120)}`,
        createdAt: new Date().toISOString(),
      })
    }

    setData((current) => ({
      ...current,
      marketData: cachedMarketData,
      trades: [...current.trades, ...trades],
    }))
    setMarketStatus('')
    setPlanStatus(`Generated ${trades.length} trades from the morning plan.`)
    setMarketSymbol(symbols[0] || marketSymbol)
    setMarketLoading(false)
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
  const tradeSymbolData = data.marketData[tradeDraft.symbol.trim().toUpperCase()] || null
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
            </div>
            <div className="rounded-3xl bg-slate-800/80 px-4 py-3 text-sm text-slate-300 ring-1 ring-slate-700">
              Current day: <span className="font-semibold text-white">{displayDate(selectedDate)}</span>
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
              </form>
            ) : (
              <div className="mt-6 space-y-5 rounded-3xl border border-slate-800 bg-slate-950/80 p-5">
                <div>
                  <p className="text-sm uppercase tracking-[0.24em] text-slate-400">Morning response</p>
                  <p className="mt-3 whitespace-pre-wrap rounded-3xl bg-slate-900/80 p-4 text-sm text-slate-100">{dailyPlan.response}</p>
                </div>
                <div>
                  <p className="text-sm uppercase tracking-[0.24em] text-slate-400">Watch list / parameters</p>
                  <p className="mt-3 whitespace-pre-wrap rounded-3xl bg-slate-900/80 p-4 text-sm text-slate-100">{dailyPlan.watchList || 'No watch list set.'}</p>
                </div>
                <div className="mt-4 flex flex-wrap gap-3">
                  <button type="button" onClick={followMorningAdvice} disabled={marketLoading} className="inline-flex items-center justify-center rounded-2xl bg-indigo-500 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-indigo-400 disabled:bg-slate-700">
                    Generate trades from plan
                  </button>
                  <button type="button" onClick={generateMorningPlanFromAI} disabled={marketLoading} className="inline-flex items-center justify-center rounded-2xl bg-blue-500 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-blue-400 disabled:bg-slate-700">
                    Regenerate plan from AI
                  </button>
                  <span className="text-sm text-slate-400">Use your OpenAI API key to create or refresh the morning plan automatically.</span>
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

        <section className="rounded-3xl border border-slate-800 bg-slate-900/90 p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-white">Trade journal</h2>
              <p className="mt-2 text-slate-400">Record every hypothetical order and track the realized P/L, risk, and execution details.</p>
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
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="rounded-2xl bg-slate-900/80 p-3">
                        <p className="text-xs uppercase tracking-[0.18em] text-slate-500">High</p>
                        <p className="mt-2 text-lg font-semibold text-white">${Math.max(...currentIntraday.map((point) => point.high)).toFixed(2)}</p>
                      </div>
                      <div className="rounded-2xl bg-slate-900/80 p-3">
                        <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Low</p>
                        <p className="mt-2 text-lg font-semibold text-white">${Math.min(...currentIntraday.map((point) => point.low)).toFixed(2)}</p>
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
                    return (
                      <tr key={trade.id} className="border-t border-slate-800">
                        <td className="px-4 py-3 text-slate-100">{trade.symbol}</td>
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
                  {history.slice(0, 7).map((date) => {
                    const metrics = computeMetrics(date)
                    const barWidth = Math.min(100, Math.max(8, Math.abs(metrics.totalPL) / 20))
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
                  })}
                </div>
              )}
            </div>
          </article>
        </section>
      </div>
    </div>
  )
}
