# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev:vercel   # local dev with API routes (required — plain vite dev breaks /api calls)
npm run build        # production build to dist/
npm run lint         # eslint check
```

There are no tests. Always run `npm run build` before committing to catch JSX/compile errors — Vercel silently serves the old build if the new one fails.

**Bump the version in `package.json` on every push.** The version is displayed in the header (`v{VERSION}`) and is the only reliable way to confirm a new deploy is live in the browser.

## Architecture

Single-page React app (no router) deployed on Vercel. All state lives in `localStorage` via `src/storage.js`. There is no backend database.

### Key files

| File | Role |
|------|------|
| `src/App.jsx` | Entire frontend — all state, logic, and UI in one file (~1500 lines) |
| `src/storage.js` | `loadData` / `saveData` (localStorage), `createId` |
| `src/marketData.js` | Alpha Vantage API client — quote, daily, intraday, top movers |
| `api/market.js` | Vercel serverless function — proxies Alpha Vantage (keeps API key server-side) |
| `api/ai.js` | Vercel serverless function — proxies Gemini or OpenAI |

### Data model (localStorage key: `momoney-investor-research`)

```js
{
  dailySessions:   [{ id, date, phase, response, watchList, notes, createdAt }],
  dailyPlans:      [{ id, date, response, watchList, riskProfile, notes, createdAt }],  // legacy
  trades:          [{ id, date, symbol, action, quantity, entryPrice, exitPrice, riskRating, notes, createdAt }],
  marketData:      { [symbol]: { quote, intraday, dailySeries } },
  executedSignals: [{ id, ... }],
  activityLog:     [{ id, date, type, message, detail, timestamp }],
  settings:        { languageModelProvider: 'gemini' | 'openai' },
}
```

`dailySessions` is the primary plan store — up to one session per trading phase per day. `selectedDate` + `selectedPhase` state drives which session is shown. `dailyPlans` is kept for backward compatibility and CSV export only.

### Trading phases

`PHASE_SCHEDULE` in App.jsx defines 5 phases keyed by local clock hour (not ET — a known limitation):
- `pre-market` · `opening-drive` · `midday-fade` · `power-hour` · `after-hours`

`updateTradingPhase()` returns the current phase. `buildSignals()` gates each signal type behind its phase, so signals only fire during the relevant window.

### AI workflow

The "manual Gemini" flow:
1. `buildEnrichedPrompt()` — fetches live movers from `/api/market?type=movers`, injects them into `DEFAULT_PROMPT`, returns a string
2. User copies to clipboard → pastes into Gemini → pastes response back into plan field
3. `parseAiPlanResponse()` extracts `plan`, `watchList`, `notes` from Gemini's response (handles markdown, bullets, varied section headers)
4. `submitPlan()` saves the parsed plan; if `watchList` is empty it also tries `parseAiPlanResponse` on the response text as fallback

Auto-extract fallback: a `useEffect` watching `dailyPlan?.id` calls `/api/ai` to pick symbols from live movers when a plan is saved with no watch list and `selectedDate === today`.

### Scanner / live signals

`refreshAndScan()` fetches intraday + quote for each watch list symbol in parallel, then calls `buildSignals()`. Runs immediately when a plan is saved for today, then every 5 minutes. Gauge metrics (`watchMetrics` state) are computed from the same fetch — RSI for midday-fade, day gain % as universal fallback.

### Theme system

A `t` object (computed before `return` in the App component) maps semantic names (`t.heading`, `t.card`, `t.btnScan`, etc.) to Tailwind classes for the active theme. `isDark` / `dk` is derived from `theme` state (persisted to localStorage). Edit the `t` object to change colors — do not scatter raw Tailwind color classes in JSX.

### API proxies

Both `/api/ai.js` and `/api/market.js` are Vercel serverless functions. They enforce a per-IP rate limit and read API keys from environment variables (`GEMINI_API_KEY`, `ALPHA_VANTAGE_API_KEY`, `OPENAI_API_KEY`). For local dev, set these in `.env.local` and run `npm run dev:vercel`.
