import { fetchQuote, fetchDailySeries, fetchIntradaySeries } from '../src/marketData.js'

const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  if (!ALPHA_VANTAGE_API_KEY) {
    res.status(500).json({ error: 'Server missing Alpha Vantage API key' })
    return
  }

  const { type, symbol, interval } = req.query
  const normalizedSymbol = (symbol || '').toString().trim().toUpperCase()

  if (!normalizedSymbol) {
    res.status(400).json({ error: 'Symbol is required' })
    return
  }

  try {
    let result
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
