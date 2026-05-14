// Frontend API client — all calls are fire-and-forget by default (no await needed)

export function createApi(getToken) {
  async function post(action, payload) {
    const token = await getToken()
    return fetch('/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, payload }),
    })
  }

  return {
    async load() {
      const token = await getToken()
      const res = await fetch('/api/data', { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) throw new Error('Failed to load data from database')
      return res.json()
    },

    saveSession: (session) => post('save-session', session),
    deleteSession: (date, phase) => post('delete-session', { date, phase }),
    addTrade: (trade) => post('add-trade', trade),
    deleteTrade: (id) => post('delete-trade', { id }),
    saveTradesForDate: (date, trades) => post('save-trades-for-date', { date, trades }),
    addSignals: (signals) => post('add-signals', { signals }),
    resetSignals: (date) => post('reset-signals', { date }),
    addActivity: (entries) => post('add-activity', { entries }),
    updateSettings: (settings) => post('update-settings', settings),
    migrate: (data) => post('migrate', data),
  }
}
