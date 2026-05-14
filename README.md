# mo' money

Intraday equity trading dashboard. Tracks trading sessions, signals, and trades across all five market phases.

## Tech Stack

### Frontend
| | |
|---|---|
| **React 19** | UI framework — entire app is a single component (`src/App.jsx`) |
| **Vite 8** | Build tool and dev server |
| **Tailwind CSS 4** | Styling via a semantic theme object (`t.card`, `t.heading`, etc.) |

### Backend
| | |
|---|---|
| **Vercel** | Hosting and serverless functions |
| **Vercel Serverless Functions** | Three API routes under `/api/` |

### Database
| | |
|---|---|
| **Turso** | Hosted LibSQL (SQLite-compatible) database |
| **@libsql/client** | Node.js client for Turso |

Six tables: `trades`, `daily_sessions`, `daily_plans`, `executed_signals`, `activity_log`, `settings` — all keyed by `user_id`.

### Auth
| | |
|---|---|
| **Clerk** | Authentication (Google + email magic link) |
| **@clerk/react** | Frontend — `ClerkProvider`, `useAuth`, `SignInButton`, `UserButton` |
| **@clerk/backend** | Server-side — JWT verification in API routes |

### External APIs
| | |
|---|---|
| **Alpha Vantage** | Stock quotes, intraday bars, daily series, top movers |
| **Gemini / OpenAI** | AI-generated trading session plans (user-selectable) |

Both are proxied through Vercel serverless functions to keep API keys server-side.

## Architecture

```
Browser
  └── React SPA (src/App.jsx)
        ├── Clerk auth gate → sign-in screen if not authenticated
        ├── On sign-in: GET /api/data → loads all user data from Turso
        ├── Per mutation: POST /api/data (optimistic UI update + fire-and-forget persist)
        └── marketData cached in localStorage only (transient API cache)

Vercel Serverless Functions
  ├── /api/data.js     — CRUD for all user data (Clerk JWT → Turso)
  ├── /api/market.js   — Alpha Vantage proxy (quotes, intraday, movers)
  └── /api/ai.js       — Gemini / OpenAI proxy
```

## Local Development

```bash
npm install
npm run dev:vercel    # required — plain vite dev breaks /api calls
```

### Required environment variables

| Variable | Where to get it |
|---|---|
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk dashboard |
| `CLERK_SECRET_KEY` | Clerk dashboard |
| `TURSO_DATABASE_URL` | Turso dashboard |
| `TURSO_AUTH_TOKEN` | Turso dashboard |
| `ALPHA_VANTAGE_API_KEY` | alphavantage.co |
| `GEMINI_API_KEY` | Google AI Studio |
| `OPENAI_API_KEY` | Optional — only needed if using OpenAI provider |

## Trading Phases

The app divides the trading day into five phases driven by local clock hour:

| Phase | Window | Purpose |
|---|---|---|
| Pre-Market | Before 9:30 AM | Gap analysis |
| Opening Drive | 9:30 – 11:00 AM | ORB breakout signals |
| Midday Fade | 11:00 AM – 2:00 PM | RSI mean-reversion signals |
| Power Hour | 2:00 – 3:45 PM | Momentum continuation |
| Hard Exit | 3:45 – 4:00 PM | Close all positions |

Each phase has its own saved session (AI plan + watch list) stored separately in the database.
