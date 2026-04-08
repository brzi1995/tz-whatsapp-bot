# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Multi-tenant WhatsApp tourist bot for Croatian tourist boards. Tourists message a WhatsApp number; the bot replies using OpenAI with a personality scoped to that tourist board.

**Stack**: Node.js + Express + MySQL + Twilio WhatsApp API + OpenAI (`gpt-4o-mini`)
**Hosting**: cPanel shared hosting

## Commands

```bash
npm install          # install dependencies
npm run dev          # development with nodemon
npm start            # production
```

## Architecture

### Multi-tenancy

Each tourist board (tenant) gets its own Twilio WhatsApp number. All numbers point to the same webhook URL. The `To` field in the Twilio request identifies the tenant — matched against `tenants.phone_number` in MySQL.

```
Twilio number A  ──┐
Twilio number B  ──┼──▶  POST /whatsapp/webhook  ──▶  look up tenant by `To`  ──▶  OpenAI (tenant system_prompt)
Twilio number C  ──┘
```

### Request flow

1. Twilio POST → `src/routes/whatsapp.js`
2. Validate Twilio signature (`src/services/twilio.js`)
3. Resolve tenant from `To` number (`src/db/sessions.js` → MySQL)
4. Load conversation history from `sessions` table
5. Call OpenAI with tenant's `system_prompt` + history (`src/services/openai.js`)
6. Persist updated history; send reply via Twilio REST API

### Key design decisions

- **200 before async work**: `res.sendStatus(200)` fires immediately so Twilio doesn't retry; processing happens after.
- **Session storage in MySQL**: replaces Python bot's in-memory dict — survives restarts, shared across processes.
- **MAX_MESSAGES = 40**: history trimmed on save to keep tokens/cost bounded.
- **Tenant system prompt in DB**: change a tourist board's personality without a deploy.

## Database Schema

See `schema.sql`. Two tables:

- `tenants` — one row per tourist board: `phone_number` (Twilio format: `whatsapp:+385...`), `system_prompt`, `openai_model`
- `sessions` — one row per (tenant, user) pair; `messages` column is a JSON array of `{role, content}` objects

## Environment Variables

See `.env.example`. Critical ones:

| Variable | Purpose |
|---|---|
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Twilio credentials |
| `WEBHOOK_BASE_URL` | Must match the URL in Twilio console exactly (used for signature validation) |
| `DB_*` | MySQL connection (cPanel DB credentials) |
| `OPENAI_API_KEY` | OpenAI |

## MCP Server

A MySQL MCP server is configured via `.mcp.json`. Update the connection string before use. Requires `uv` (`brew install uv`).

## Twilio Webhook Setup

In the Twilio console, set each WhatsApp number's incoming message webhook to:
```
https://yourdomain.com/whatsapp/webhook
```
Method: HTTP POST. The `WEBHOOK_BASE_URL` env var must match this domain exactly for signature validation to pass.



The bot is a tourism AI assistant for Brela.
It must behave like a helpful local guide for visitors, providing clear, practical, and reliable information.
The bot supports short follow-up conversations, but in a controlled way.

# FOLLOW-UP CONTEXT RULES

The bot supports short follow-up conversations, but in a controlled way.

---

## WHEN FOLLOW-UP IS ALLOWED

Follow-up is allowed ONLY if:

- session.lastTopic exists
- the message is short OR clearly related

Examples of valid follow-up:
- "beaches"
- "restaurants"
- "5 days"
- "tonight"
- "center"

---

## FOLLOW-UP BEHAVIOR

If follow-up is detected:

- stay within the same topic
- do NOT run full intent detection
- do NOT switch topics

---

## FOLLOW-UP EXPIRATION

Context must be short-lived.

Clear session.lastTopic when:
- more than 2 minutes passed
OR
- more than 2 follow-up messages happened
OR
- a clear new topic is detected

---

## NEW TOPIC DETECTION

If the message clearly introduces a new topic:

Examples:
- "weather"
- "events"
- "parking"
- "how to get there"

Then:
- reset session.lastTopic
- process as a new request

---

## MULTI-LANGUAGE SUPPORT

Follow-up must work across languages.

Do NOT rely on exact text.

Use normalized keyword mapping:

Examples:
- beaches / plaže / plage → same intent
- restaurants / restorani → same intent
- events / događanja → same intent

---

## IMPORTANT RULES

- NEVER allow follow-up to override a clear new topic
- NEVER create loops
- NEVER route to wrong topic based on short input

---

## GOAL

Follow-up should feel natural and helpful,
but never cause confusion or incorrect responses.