const STORAGE_KEY = 'momoney-investor-research'

const initialState = {
  dailyPlans: [],
  trades: [],
  marketData: {},
  settings: {
    marketApiKey: '',
  },
}

export function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return initialState
    return JSON.parse(raw)
  } catch (error) {
    console.error('Failed to load research data', error)
    return initialState
  }
}

export function saveData(payload) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch (error) {
    console.error('Failed to save research data', error)
  }
}

export function createId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}
