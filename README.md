# Daily Pulse: Automated Telemetry Architecture

Standard habit trackers rely on heavy GUI interaction and passive data entry, introducing unacceptable operational friction. Daily Pulse is a custom infrastructure layer designed to automate time telemetry, track deep work blocks, and parse natural language inputs via serverless edge functions.

### System Architecture
* **Frontend:** Lightweight Vanilla JS + Tailwind HTML (PWA configured)
* **Backend:** Node.js Serverless Functions (Vercel)
* **Database:** Supabase (PostgreSQL)
* **AI Routing:** Gemini 3.X Flash API (Dynamic API Version and gives natural language parsing and data structuring)
* **Ingestion:** Telegram Bot API (Asynchronous webhook triggers)

### Core Mechanics
* **Frictionless Ingestion:** Bypasses web UI entirely. Natural language commands (e.g., "Tuition ended at 8:15 pm") sent via Telegram are parsed by the Gemini API, converted into structured JSON, and piped directly into the PostgreSQL database.
* **12-Hour AM/PM Late Picker:** Reconciles historical data entries without corrupting the timeline.
* **Serverless Cron Audits:** Automated midnight Vercel cron jobs pull daily logs, identifying missed operational blocks and pushing status reports via Telegram.
* **Algorithmic Weekly Analysis:** Sunday cron jobs aggregate 7 days of telemetry, cross-reference against historical multi-week baselines, and execute Gemini-driven bottleneck analysis.
