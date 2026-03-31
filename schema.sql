-- TZ WhatsApp Bot — full schema
-- Safe to run on a fresh database (all IF NOT EXISTS)
-- MySQL 8.0+

-- -------------------------------------------------------------------------
-- Core
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tenants (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(255)  NOT NULL,
  phone_number    VARCHAR(50)   NOT NULL UNIQUE,   -- Twilio format: whatsapp:+385...
  system_prompt   TEXT          NOT NULL,
  openai_model    VARCHAR(50)   NOT NULL DEFAULT 'gpt-4o-mini',
  city            VARCHAR(100)  NOT NULL DEFAULT 'Brela',
  human_takeover  BOOLEAN       NOT NULL DEFAULT false,
  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP
);

-- Conversation history (kept for reference; bot no longer reads history per-message)
CREATE TABLE IF NOT EXISTS conversations (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id   INT         NOT NULL,
  user_phone  VARCHAR(50) NOT NULL,
  messages    JSON        NOT NULL,
  updated_at  TIMESTAMP   DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_conversation (tenant_id, user_phone),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- -------------------------------------------------------------------------
-- Phase 1 — Bot features
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS faq (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id  INT          NOT NULL,
  question   VARCHAR(500) NOT NULL,
  answer     TEXT         NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS events (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id      INT          NOT NULL,
  title          VARCHAR(255) NOT NULL,
  description    TEXT         NOT NULL,
  date           DATE         NOT NULL,
  location_link  VARCHAR(500),
  featured       TINYINT(1)   NOT NULL DEFAULT 0,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- Migration for existing installs (safe to run multiple times):
-- ALTER TABLE events ADD COLUMN IF NOT EXISTS featured TINYINT(1) NOT NULL DEFAULT 0;

-- All inbound messages with intent classification and detected language
CREATE TABLE IF NOT EXISTS messages (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id   INT         NOT NULL,
  user_phone  VARCHAR(50) NOT NULL,
  message     TEXT        NOT NULL,
  intent      ENUM('faq','weather','events','ai','fallback','admin_reply') NOT NULL,
  lang        VARCHAR(10) NOT NULL DEFAULT 'hr',
  created_at  TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- Migration for existing installs (safe to run once):
-- ALTER TABLE messages MODIFY COLUMN intent ENUM('faq','weather','events','ai','fallback','admin_reply') NOT NULL;

-- Per-user daily AI usage cap (max 5 AI calls / user / day)
CREATE TABLE IF NOT EXISTS usage (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id       INT         NOT NULL,
  user_phone      VARCHAR(50) NOT NULL,
  ai_count        INT         NOT NULL DEFAULT 0,
  last_reset_date DATE        NOT NULL,
  UNIQUE KEY unique_usage (tenant_id, user_phone),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- -------------------------------------------------------------------------
-- Phase 3 — WhatsApp opt-in & broadcast
-- -------------------------------------------------------------------------

-- One row per (tenant, tourist phone). Tracks opt-in consent and activity.
CREATE TABLE IF NOT EXISTS whatsapp_users (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id       INT         NOT NULL,
  phone           VARCHAR(50) NOT NULL,
  opt_in          TINYINT(1)  NOT NULL DEFAULT 0,
  asked_opt_in    TINYINT(1)  NOT NULL DEFAULT 0,
  last_message_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_user (tenant_id, phone),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- -------------------------------------------------------------------------
-- Phase 2 — Admin dashboard
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  email      VARCHAR(255) NOT NULL UNIQUE,
  password   VARCHAR(255) NOT NULL,          -- bcrypt hash
  tenant_id  INT          NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
