-- Multi-tenant WhatsApp tourist bot schema
-- Run once on your MySQL database

CREATE TABLE IF NOT EXISTS tenants (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  -- Twilio WhatsApp number assigned to this tenant, e.g. whatsapp:+38512345678
  phone_number  VARCHAR(50)  NOT NULL UNIQUE,
  system_prompt TEXT         NOT NULL,
  openai_model  VARCHAR(50)  NOT NULL DEFAULT 'gpt-4o-mini',
  created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversations (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id   INT          NOT NULL,
  user_phone  VARCHAR(50)  NOT NULL,
  -- Full conversation history as a JSON array of {role, content} objects
  messages    JSON         NOT NULL,
  updated_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_conversation (tenant_id, user_phone),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- Phase 1 extensions

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS human_takeover BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS city VARCHAR(100) DEFAULT 'Brela';

CREATE TABLE IF NOT EXISTS faq (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id  INT NOT NULL,
  question   VARCHAR(500) NOT NULL,
  answer     TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id   INT NOT NULL,
  user_phone  VARCHAR(50) NOT NULL,
  message     TEXT NOT NULL,
  intent      ENUM('faq','weather','events','ai') NOT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS usage (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id       INT NOT NULL,
  user_phone      VARCHAR(50) NOT NULL,
  ai_count        INT NOT NULL DEFAULT 0,
  last_reset_date DATE NOT NULL,
  UNIQUE KEY unique_usage (tenant_id, user_phone),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS users (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  email      VARCHAR(255) NOT NULL UNIQUE,
  password   VARCHAR(255) NOT NULL,
  tenant_id  INT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS events (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id      INT NOT NULL,
  title          VARCHAR(255) NOT NULL,
  description    TEXT NOT NULL,
  date           DATE NOT NULL,
  location_link  VARCHAR(500),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
