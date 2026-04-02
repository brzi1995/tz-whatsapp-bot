const pool = require('./index');

// Maximum messages kept per conversation to prevent unbounded growth
const MAX_MESSAGES = 40;

function normalizeConversationPayload(raw) {
  if (Array.isArray(raw)) {
    return { messages: raw, state: {} };
  }
  if (raw && typeof raw === 'object') {
    return {
      messages: Array.isArray(raw.messages) ? raw.messages : [],
      state: raw.state && typeof raw.state === 'object' && !Array.isArray(raw.state) ? raw.state : {},
    };
  }
  return { messages: [], state: {} };
}

/**
 * Look up a tenant by its Twilio WhatsApp number (e.g. "whatsapp:+38512345678").
 * Returns the tenant row or null if not found.
 */
async function getTenant(phoneNumber) {
  console.log('[db] getTenant called with:', phoneNumber);
  try {
    const [rows] = await pool.query(
      'SELECT * FROM tenants WHERE phone_number = ?',
      [phoneNumber]
    );
    if (!rows[0]) {
      console.warn('[db] no tenant found for phone_number:', phoneNumber);
      return null;
    }
    console.log('[db] tenant found:', rows[0].name, '| id:', rows[0].id);
    return rows[0];
  } catch (err) {
    console.error('[db] getTenant error:', err.message);
    throw err;
  }
}

/**
 * Load conversation history for a user within a tenant.
 * Returns an array of {role, content} objects, or [] if none exists.
 */
async function getConversation(tenantId, userPhone) {
  console.log(`[db] getMessages called | tenant_id=${tenantId} user_phone=${userPhone}`);
  try {
    const [rows] = await pool.query(
      'SELECT messages FROM conversations WHERE tenant_id = ? AND user_phone = ?',
      [tenantId, userPhone]
    );
    if (!rows[0]) {
      console.log('[db] no conversation history found — starting fresh');
      return { messages: [], state: {} };
    }
    let parsed;
    try {
      parsed = typeof rows[0].messages === 'string'
        ? JSON.parse(rows[0].messages)
        : rows[0].messages;
    } catch (parseErr) {
      console.error('[db] failed to parse messages JSON — starting fresh:', parseErr.message);
      return { messages: [], state: {} };
    }
    const conversation = normalizeConversationPayload(parsed);
    console.log(`[db] loaded ${conversation.messages.length} messages from history`);
    return conversation;
  } catch (err) {
    console.error('[db] getMessages error:', err.message);
    throw err;
  }
}

async function getMessages(tenantId, userPhone) {
  const conversation = await getConversation(tenantId, userPhone);
  return conversation.messages;
}

/**
 * Persist the conversation history for a user.
 * Inserts a new row or updates the existing one (upsert).
 * Trims to MAX_MESSAGES to keep token usage bounded.
 */
async function saveConversation(tenantId, userPhone, conversation) {
  const trimmed = Array.isArray(conversation?.messages)
    ? conversation.messages.slice(-MAX_MESSAGES)
    : [];
  const state = conversation?.state && typeof conversation.state === 'object' && !Array.isArray(conversation.state)
    ? conversation.state
    : {};
  console.log(`[db] saveMessages called | tenant_id=${tenantId} user_phone=${userPhone} messages=${trimmed.length}`);
  try {
    const [result] = await pool.query(
      `INSERT INTO conversations (tenant_id, user_phone, messages)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE messages = VALUES(messages), updated_at = NOW()`,
      [tenantId, userPhone, JSON.stringify({ messages: trimmed, state })]
    );
    console.log(`[db] saveMessages OK | affectedRows=${result.affectedRows}`);
  } catch (err) {
    console.error('[db] saveMessages error:', err.message);
    throw err;
  }
}

async function saveMessages(tenantId, userPhone, messages) {
  const conversation = await getConversation(tenantId, userPhone).catch(() => ({ state: {} }));
  return saveConversation(tenantId, userPhone, { messages, state: conversation.state || {} });
}

module.exports = { getTenant, getConversation, saveConversation, getMessages, saveMessages };
