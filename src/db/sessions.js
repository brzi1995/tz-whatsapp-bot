const pool = require('./index');

// Maximum messages kept per session to prevent unbounded growth
const MAX_MESSAGES = 40;

/**
 * Look up a tenant by its Twilio WhatsApp number (e.g. "whatsapp:+38512345678").
 * Returns the tenant row or null if not found.
 */
async function getTenant(phoneNumber) {
  const [rows] = await pool.query(
    'SELECT * FROM tenants WHERE phone_number = ?',
    [phoneNumber]
  );
  return rows[0] ?? null;
}

/**
 * Fetch the conversation history for a user within a tenant.
 * Returns an array of {role, content} objects.
 */
async function getMessages(tenantId, userPhone) {
  const [rows] = await pool.query(
    'SELECT messages FROM sessions WHERE tenant_id = ? AND user_phone = ?',
    [tenantId, userPhone]
  );
  if (!rows[0]) return [];
  return JSON.parse(rows[0].messages);
}

/**
 * Persist the conversation history, inserting or updating the session row.
 * Trims to MAX_MESSAGES to keep the context window manageable.
 */
async function saveMessages(tenantId, userPhone, messages) {
  const trimmed = messages.slice(-MAX_MESSAGES);
  await pool.query(
    `INSERT INTO sessions (tenant_id, user_phone, messages)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE messages = VALUES(messages), updated_at = NOW()`,
    [tenantId, userPhone, JSON.stringify(trimmed)]
  );
}

module.exports = { getTenant, getMessages, saveMessages };
