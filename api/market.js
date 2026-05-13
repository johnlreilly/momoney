import { fetchQuote, fetchDailySeries, fetchIntradaySeries, fetchTopMovers } from '../src/marketData.js'

const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY
const ALLOWED_ORIGIN = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:5173'

const rateLimitMap = new Map()
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 30

function isRateLimited(ip) {
  const now = Date.now()
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS }
  if (now > entry.resetAt) {
    entry.count = 0
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS
  }
  entry.count += 1
  rateLimitMap.set(ip, entry)
  return entry.count > RATE_LIMIT_MAX
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.status(200).end()
    return
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown'
  if (isRateLimited(ip)) {
    res.status(429).json({ error: 'Too many requests. Please wait a moment.' })
    return
  }

  if (!ALPHA_VANTAGE_API_KEY) {
    res.status(500).json({ error: 'Server missing Alpha Vantage API key' })
    return
  }

  const { type, symbol, interval } = req.query

  try {
    let result
    if (type === 'movers') {
      result = await fetchTopMovers(ALPHA_VANTAGE_API_KEY)
      res.status(200).json(result)
      return
    }

    const normalizedSymbol = (symbol || '').toString().trim().toUpperCase().replace(/[^A-Z0-9.]/g, '')
    if (!normalizedSymbol) {
      res.status(400).json({ error: 'Symbol is required' })
      return
    }
    if (normalizedSymbol.length > 10) {
      res.status(400).json({ error: 'Invalid symbol' })
      return
    }

    if (type === 'quote') {
      result = await fetchQuote(normalizedSymbol, ALPHA_VANTAGE_API_KEY)
    } else if (type === 'daily') {
      result = await fetchDailySeries(normalizedSymbol, ALPHA_VANTAGE_API_KEY)
    } else if (type === 'intraday') {
      const normalizedInterval = (interval || '5min').toString().trim() || '5min'
      result = await fetchIntradaySeries(normalizedSymbol, normalizedInterval, ALPHA_VANTAGE_API_KEY)
    } else {
      res.status(400).json({ error: 'Invalid market request type' })
      return
    }
    res.status(200).json(result)
  } catch (error) {
    console.error('Market proxy error:', error)
    res.status(500).json({ error: error.message || 'Market proxy request failed' })
  }
}
