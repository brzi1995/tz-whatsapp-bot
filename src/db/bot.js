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

// ---------------------------------------------------------------------------
// Language & event-intent detection (keyword-based, no AI call)
// ---------------------------------------------------------------------------

const EVENT_PERIOD_KEYWORDS = {
  today:    { hr: ['danas'], en: ['today'], de: ['heute'], it: ['oggi'], fr: ["aujourd'hui"] },
  tomorrow: { hr: ['sutra'], en: ['tomorrow'], de: ['morgen'], it: ['domani'], fr: ['demain'] },
  week:     { hr: ['tjedan'], en: ['week'], de: ['woche'], it: ['settimana'], fr: ['semaine'] },
};

const LANG_HINTS = {
  hr: ['danas', 'sutra', 'tjedan', 'događaj', 'što', 'ima', 'hvala', 'bok'],
  en: ['today', 'tomorrow', 'week', 'event', 'what', 'hello', 'thanks', 'please'],
  de: ['heute', 'morgen', 'woche', 'veranstaltung', 'bitte', 'danke', 'hallo'],
  it: ['oggi', 'domani', 'settimana', 'evento', 'grazie', 'ciao', 'cosa'],
  fr: ["aujourd'hui", 'demain', 'semaine', 'événement', 'merci', 'bonjour'],
};

// Words that indicate a weather query — prevent time words from triggering event path
const WEATHER_WORDS = new Set([
  'weather', 'forecast', 'rain', 'sun', 'wind', 'cloud', 'hot', 'cold', 'temperature',
  'vrijeme', 'prognoza', 'kiša', 'sunce', 'vjetar', 'temperatura',
  'wetter', 'regen', 'sonne', 'temperatur',
  'tempo', 'pioggia', 'sole', 'previsione',
  'météo', 'pluie', 'soleil',
]);

const EVENT_RESPONSES = {
  hr: { header: 'Evo što se događa:\n\n', empty: 'Trenutno nema događaja.' },
  en: { header: 'Here are some events:\n\n', empty: 'No events found.' },
  de: { header: 'Hier sind einige Veranstaltungen:\n\n', empty: 'Keine Veranstaltungen gefunden.' },
  it: { header: 'Ecco alcuni eventi:\n\n', empty: 'Nessun evento trovato.' },
  fr: { header: 'Voici quelques événements:\n\n', empty: 'Aucun événement trouvé.' },
};

/**
 * Detect user language from message keywords.
 * Falls back to 'hr' if nothing matches.
 * @param {string} message
 * @returns {string} ISO 639-1 code
 */
function detectLang(message) {
  const lower = message.toLowerCase();
  let best = { lang: 'hr', score: 0 };
  for (const [lang, keywords] of Object.entries(LANG_HINTS)) {
    const score = keywords.filter(kw => lower.includes(kw)).length;
    if (score > best.score) best = { lang, score };
  }
  return best.lang;
}

/**
 * Detect event time period from message keywords.
 * Returns null if the message looks like a weather query.
 * @param {string} message
 * @returns {'today'|'tomorrow'|'week'|null}
 */
function detectEventPeriod(message) {
  const lower = message.toLowerCase();
  // Don't steal weather queries that happen to contain a time word
  if (lower.split(/\s+/).some(w => WEATHER_WORDS.has(w))) return null;
  for (const [period, langs] of Object.entries(EVENT_PERIOD_KEYWORDS)) {
    for (const keywords of Object.values(langs)) {
      if (keywords.some(kw => lower.includes(kw))) return period;
    }
  }
  return null;
}

/**
 * Fetch events for a period and return a formatted, language-aware reply string.
 * No AI call — pure DB + template.
 * @param {number} tenantId
 * @param {'today'|'tomorrow'|'week'} period
 * @param {string} lang
 * @returns {Promise<string>}
 */
async function getEventsFormatted(tenantId, period, lang) {
  const events = await getEventsByPeriod(tenantId, period);
  const phrases = EVENT_RESPONSES[lang] || EVENT_RESPONSES.en;
  if (!events.length) return phrases.empty;
  const lines = events.map(ev => {
    const d = ev.date instanceof Date ? ev.date : new Date(ev.date);
    const dateStr = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
    return `• ${ev.title} (${dateStr})`;
  });
  return phrases.header + lines.join('\n');
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

module.exports = { logMessage, getFaqMatch, getUpcomingEvents, getEventsByPeriod, checkAndIncrementUsage, setHumanTakeover, detectLang, detectEventPeriod, getEventsFormatted };
