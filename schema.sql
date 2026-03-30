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
