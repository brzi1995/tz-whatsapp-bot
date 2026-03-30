const pool = require('./index');

// Lightweight language detection for analytics — no AI call needed.
function detectLang(text) {
  if (/[čćžšđČĆŽŠĐ]/.test(text)) return 'hr';
  const tokens = new Set(text.toLowerCase().split(/\W+/));
  const hit = words => words.some(w => tokens.has(w));
  if (hit(['the','is','are','what','how','where','when','hello','hi','weather','event','please'])) return 'en';
  if (hit(['ist','sind','wie','was','wo','wann','hallo','bitte','wetter','können'])) return 'de';
  if (hit(['come','dove','quando','ciao','grazie','prego','tempo','sono','cosa'])) return 'it';
  if (hit(['est','sont','comment','où','quand','bonjour','merci','météo'])) return 'fr';
  return 'hr';
}

/**
 * Log an inbound user message to the messages table.
 * @param {number} tenantId
 * @param {string} userPhone
 * @param {string} message
 * @param {'faq'|'weather'|'events'|'ai'} intent
 */
async function logMessage(tenantId, userPhone, message, intent) {
  const lang = detectLang(message);
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

module.exports = { logMessage, getFaqMatch, getUpcomingEvents, checkAndIncrementUsage };
