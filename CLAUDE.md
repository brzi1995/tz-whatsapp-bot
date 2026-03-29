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
