const pool = require('./index');

/**
 * Log an inbound user message to the messages table.
 * lang is detected upstream by parseMessage() and passed in.
 * @param {number} tenantId
 * @param {string} userPhone
 * @param {string} message
 * @param {'faq'|'weather'|'events'|'ai'} intent
 * @param {string} lang  ISO 639-1 code, e.g. 'hr', 'en', 'de'
 */
async function logMessage(tenantId, userPhone, message, intent, lang = 'hr') {
  try {
    await pool.query(
      'INSERT INTO messages (tenant_id, user_phone, message, intent, lang) VALUES (?, ?, ?, ?, ?)',
      [tenantId, userPhone, message, intent, lang]
    );
  } catch (err) {
    // Logging failure must never crash the bot — record and continue
    console.error('[bot] logMessage error:', err.message);
  }
}

/**
 * Try to match a user message against FAQ entries for the tenant.
 * Splits each faq.question into individual words and checks whether any word
 * appears in the user message (case-insensitive). Returns the answer for the
 * first matching row, or null when nothing matches.
 * @param {number} tenantId
 * @param {string} userMessage
 * @returns {Promise<string|null>}
 */
async function getFaqMatch(tenantId, userMessage) {
  try {
    const [rows] = await pool.query(
      'SELECT question, answer FROM faq WHERE tenant_id = ?',
      [tenantId]
    );
    if (!rows.length) return null;

    const normalised = userMessage.toLowerCase();

    for (const row of rows) {
      const keywords = row.question.toLowerCase().split(/\s+/).filter(Boolean);
      const matched = keywords.some(word => normalised.includes(word));
      if (matched) {
        console.log(`[bot] FAQ match on question: "${row.question}"`);
        return row.answer;
      }
    }
    return null;
  } catch (err) {
    console.error('[bot] getFaqMatch error:', err.message);
    return null;
  }
}

/**
 * Return up to 5 upcoming events for the tenant (today or later, chronological).
 * @param {number} tenantId
 * @returns {Promise<Array>}
 */
async function getUpcomingEvents(tenantId) {
  try {
    const [rows] = await pool.query(
      'SELECT title, description, date, location_link FROM events WHERE tenant_id = ? AND date >= CURDATE() ORDER BY date ASC LIMIT 5',
      [tenantId]
    );
    return rows;
  } catch (err) {
    console.error('[bot] getUpcomingEvents error:', err.message);
    return [];
  }
}

/**
 * Rate-limit AI calls to 5 per user per day.
 * Upserts the usage row and returns whether the call is allowed.
 * @param {number} tenantId
 * @param {string} userPhone
 * @returns {Promise<{ allowed: boolean }>}
 */
async function checkAndIncrementUsage(tenantId, userPhone) {
  try {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    const [rows] = await pool.query(
      'SELECT ai_count, last_reset_date FROM usage WHERE tenant_id = ? AND user_phone = ?',
      [tenantId, userPhone]
    );

    if (!rows.length || rows[0].last_reset_date.toISOString().slice(0, 10) !== today) {
      // No record yet or the record is from a previous day — reset to 1
      await pool.query(
        `INSERT INTO usage (tenant_id, user_phone, ai_count, last_reset_date)
         VALUES (?, ?, 1, ?)
         ON DUPLICATE KEY UPDATE ai_count = 1, last_reset_date = ?`,
        [tenantId, userPhone, today, today]
      );
      return { allowed: true };
    }

    if (rows[0].ai_count >= 5) {
      return { allowed: false };
    }

    await pool.query(
      'UPDATE usage SET ai_count = ai_count + 1 WHERE tenant_id = ? AND user_phone = ?',
      [tenantId, userPhone]
    );
    return { allowed: true };
  } catch (err) {
    console.error('[bot] checkAndIncrementUsage error:', err.message);
    // On DB error let the request through rather than silently blocking users
    return { allowed: true };
  }
}

/**
 * Return events for a specific time period (today / tomorrow / week).
 * Period SQL conditions are hardcoded — no user input in the query.
 * @param {number} tenantId
 * @param {'today'|'tomorrow'|'week'} period
 * @returns {Promise<Array>}
 */
async function getEventsByPeriod(tenantId, period) {
  const conditions = {
    today:    'date = CURDATE()',
    tomorrow: 'date = CURDATE() + INTERVAL 1 DAY',
    week:     'date BETWEEN CURDATE() AND CURDATE() + INTERVAL 7 DAY',
  };
  const condition = conditions[period] || conditions.today;
  try {
    const [rows] = await pool.query(
      `SELECT title, description, date, location_link
       FROM events
       WHERE tenant_id = ? AND ${condition}
       ORDER BY date ASC LIMIT 10`,
      [tenantId]
    );
    return rows;
  } catch (err) {
    console.error('[bot] getEventsByPeriod error:', err.message);
    return [];
  }
}

/**
 * Activate human takeover for a tenant (bot goes silent for that tenant).
 * @param {number} tenantId
 */
async function setHumanTakeover(tenantId) {
  try {
    await pool.query('UPDATE tenants SET human_takeover = 1 WHERE id = ?', [tenantId]);
    console.log(`[bot] human_takeover activated for tenant ${tenantId}`);
  } catch (err) {
    console.error('[bot] setHumanTakeover error:', err.message);
  }
}

module.exports = { logMessage, getFaqMatch, getUpcomingEvents, getEventsByPeriod, checkAndIncrementUsage, setHumanTakeover };
