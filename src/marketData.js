const ALPHA_VANTAGE_BASE = 'https://www.alphavantage.co/query'

function normalizeQuote(data) {
  const quote = data['Global Quote'] || {}
  return {
    symbol: quote['01. symbol'] || '',
    open: Number(quote['02. open'] || 0),
    high: Number(quote['03. high'] || 0),
    low: Number(quote['04. low'] || 0),
    price: Number(quote['05. price'] || 0),
    volume: Number(quote['06. volume'] || 0),
    previousClose: Number(quote['08. previous close'] || 0),
    change: Number(quote['09. change'] || 0),
    changePercent: quote['10. change percent'] || '0%',
    timestamp: new Date().toISOString(),
  }
}

function normalizeDailySeries(data) {
  const series = data['Time Series (Daily)'] || {}
  return Object.entries(series).map(([date, values]) => ({
    date,
    open: Number(values['1. open'] || 0),
    high: Number(values['2. high'] || 0),
    low: Number(values['3. low'] || 0),
    close: Number(values['4. close'] || 0),
    adjustedClose: Number(values['5. adjusted close'] || 0),
    volume: Number(values['6. volume'] || 0),
  })).sort((a, b) => (a.date < b.date ? 1 : -1))
}

function handleApiErrors(symbol, response) {
  if (!response.ok) {
    throw new Error(`Market data request failed for ${symbol}`)
  }
  return response.json()
}

export async function fetchQuote(symbol, apiKey) {
  const normalizedSymbol = symbol.trim().toUpperCase()
  if (!normalizedSymbol) {
    throw new Error('Symbol is required')
  }
  const url = `${ALPHA_VANTAGE_BASE}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(normalizedSymbol)}&apikey=${encodeURIComponent(apiKey)}`
  const response = await fetch(url)
  const data = await handleApiErrors(symbol, response)
  if (data.Note) {
    throw new Error('Alpha Vantage rate limit exceeded. Try again later or use your own API key.')
  }
  if (data['Error Message']) {
    throw new Error(`No quote found for ${normalizedSymbol}`)
  }
  return normalizeQuote(data)
}

function normalizeIntradaySeries(data, interval) {
  const key = `Time Series (${interval})`
  const series = data[key] || {}
  return Object.entries(series).map(([dateTime, values]) => ({
    dateTime,
    open: Number(values['1. open'] || 0),
    high: Number(values['2. high'] || 0),
    low: Number(values['3. low'] || 0),
    close: Number(values['4. close'] || 0),
    volume: Number(values['5. volume'] || 0),
  })).sort((a, b) => (a.dateTime < b.dateTime ? 1 : -1))
}

export async function fetchDailySeries(symbol, apiKey) {
  const normalizedSymbol = symbol.trim().toUpperCase()
  if (!normalizedSymbol) {
    throw new Error('Symbol is required')
  }
  const url = `${ALPHA_VANTAGE_BASE}?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${encodeURIComponent(normalizedSymbol)}&outputsize=compact&apikey=${encodeURIComponent(apiKey)}`
  const response = await fetch(url)
  const data = await handleApiErrors(symbol, response)
  if (data.Note) {
    throw new Error('Alpha Vantage rate limit exceeded. Try again later or use your own API key.')
  }
  if (data['Error Message']) {
    throw new Error(`No daily series found for ${normalizedSymbol}`)
  }
  return normalizeDailySeries(data)
}

export async function fetchIntradaySeries(symbol, interval = '5min', apiKey) {
  const normalizedSymbol = symbol.trim().toUpperCase()
  if (!normalizedSymbol) {
    throw new Error('Symbol is required')
  }
  const normalizedInterval = interval.trim() || '5min'
  const url = `${ALPHA_VANTAGE_BASE}?function=TIME_SERIES_INTRADAY&symbol=${encodeURIComponent(normalizedSymbol)}&interval=${encodeURIComponent(normalizedInterval)}&outputsize=compact&apikey=${encodeURIComponent(apiKey)}`
  const response = await fetch(url)
  const data = await handleApiErrors(symbol, response)
  if (data.Note) {
    throw new Error('Alpha Vantage rate limit exceeded. Try again later or use your own API key.')
  }
  if (data['Error Message']) {
    throw new Error(`No intraday series found for ${normalizedSymbol}`)
  }
  return normalizeIntradaySeries(data, normalizedInterval)
}
