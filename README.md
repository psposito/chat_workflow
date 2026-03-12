# whatsapp-bot

WhatsApp bot with OpenAI GPT-4o-mini, task reminders, and weekly SEO digest — built with Node.js + TypeScript, Express, SQLite (better-sqlite3), Twilio, and node-cron.

---

## Features

| Command | Response |
|---|---|
| `ajuda` / `help` | List of available commands |
| `que horas` / `data` / `hora` | Current date and time (Brasília) |
| `seo` / `novidades` / `radar` | Weekly SEO news digest |
| `minhas tarefas` / `listar tarefas` | Pending tasks list |
| `lembrete: reunião amanhã às 14h` | Save a task with AI extraction |
| Any other message | Free chat with memory (last 10 messages) |

**Scheduled jobs (America/Sao_Paulo):**
- **08:00 daily** — WhatsApp reminder for tasks due today
- **09:00 every Monday** — SEO digest sent to `NOTIFY_PHONES`

---

## Local development

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your keys (see Environment Variables section below)

# 3. Start dev server with hot-reload
npm run dev
```

Server starts at `http://localhost:3000`.

To receive Twilio webhooks locally, expose port 3000 with [ngrok](https://ngrok.com/):

```bash
ngrok http 3000
```

Copy the HTTPS URL (e.g. `https://abc123.ngrok.io`) and set it as the webhook in Twilio.

---

## Build & production

```bash
npm run build   # compiles TypeScript → dist/
npm start       # runs dist/index.js
```

---

## Deploy on Railway

### 1. Create project

1. Go to [railway.app](https://railway.app) and click **New Project**
2. Select **Deploy from GitHub repo** and connect your repository
3. Railway will detect the `Dockerfile` automatically via `railway.toml`

### 2. Add persistent volume

1. In your Railway service, open the **Volumes** tab
2. Click **Add Volume** and set the mount path to `/data`
3. This persists the SQLite database (`/data/bot.db`) across deploys

### 3. Set environment variables

In the Railway service's **Variables** tab, add:

| Variable | Value | Description |
|---|---|---|
| `OPENAI_API_KEY` | `sk-...` | OpenAI API key |
| `TWILIO_ACCOUNT_SID` | `ACxxxxxxxx...` | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | `xxxxxxxx...` | Twilio Auth Token |
| `TWILIO_WHATSAPP_FROM` | `whatsapp:+14155238886` | Twilio sandbox or approved number |
| `PORT` | `3000` | HTTP port (Railway sets this automatically) |
| `DB_PATH` | `/data/bot.db` | SQLite file path inside the volume |
| `NOTIFY_PHONES` | `+5511999999999,+5511888888888` | Comma-separated phones for SEO digest |

### 4. Get the public URL

After deploying, Railway assigns a URL like `https://whatsapp-bot-production.up.railway.app`.

---

## Configure Twilio webhook

### Sandbox (testing)

1. Go to [Twilio Console → Messaging → Try it out → Send a WhatsApp message](https://console.twilio.com/us1/develop/sms/try-it-out/whatsapp-learn)
2. Join the sandbox by sending the join code from your WhatsApp
3. In **Sandbox Settings**, set:
   - **When a message comes in:** `https://<your-railway-url>/webhook`
   - Method: `HTTP POST`
4. Click **Save**

### Production (approved number)

1. Go to **Messaging → Senders → WhatsApp senders** and request a number
2. Once approved, go to the number's configuration and set:
   - **A message comes in → Webhook:** `https://<your-railway-url>/webhook`
   - Method: `HTTP POST`

---

## Project structure

```
src/
├── index.ts                  # Entry point
├── server.ts                 # Express app + bootstrap
├── router.ts                 # Message routing logic
├── twilio.ts                 # sendWhatsApp() helper
├── db/
│   └── database.ts           # SQLite schema + query functions
├── modules/
│   ├── chat.ts               # GPT-4o-mini chat with memory
│   ├── tasks.ts              # Task extraction + listing
│   ├── seoDigest.ts          # SEO digest generation
│   └── seoRadar.ts           # Multi-source SEO news collector
└── schedulers/
    └── jobs.ts               # node-cron scheduled jobs
```

---

## Environment variables reference

```env
OPENAI_API_KEY=sk-...
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
PORT=3000
DB_PATH=/data/bot.db
NOTIFY_PHONES=+5511999999999,+5511888888888
```
