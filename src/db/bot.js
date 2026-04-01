const pool = require('./index');

/**
 * Normalize phone to plain +385... format — strips whatsapp: prefix,
 * decodes %2B encoding, and trims whitespace.
 * All users-table queries must go through this.
 */
function normalizePhone(phone) {
  return decodeURIComponent(String(phone || ''))
    .replace('whatsapp:', '')
    .replace(/\s+/g, '')
    .trim();
}

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
    // Featured events take priority (max 3); fall back to all upcoming
    const [featured] = await pool.query(
      'SELECT title, description, date, location_link FROM events WHERE tenant_id = ? AND date >= CURDATE() AND featured = 1 ORDER BY date ASC LIMIT 3',
      [tenantId]
    );
    if (featured.length) return featured;
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
    // Featured events take priority for the given period (max 3)
    const [featured] = await pool.query(
      `SELECT title, description, date, location_link
       FROM events
       WHERE tenant_id = ? AND featured = 1 AND ${condition}
       ORDER BY date ASC LIMIT 3`,
      [tenantId]
    );
    if (featured.length) return featured;
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
  hr: { header: 'Evo što se događa:\n\n', empty: 'Za sada nema prijavljenih događaja, ali je destinacija puna sadržaja! 🌟\n\n• Prošetajte starom gradskom jezgrom\n• Posjetite lokalne plaže i uvale\n• Isprobajte lokalne restorane i konobe' },
  en: { header: 'Here are some events:\n\n', empty: 'No events scheduled right now, but there\'s plenty to explore! 🌟\n\n• Stroll through the historic old town\n• Discover local beaches and coves\n• Try the local restaurants and taverns' },
  de: { header: 'Hier sind einige Veranstaltungen:\n\n', empty: 'Derzeit keine Veranstaltungen geplant, aber es gibt viel zu entdecken! 🌟\n\n• Schlendern Sie durch die historische Altstadt\n• Entdecken Sie lokale Strände und Buchten\n• Probieren Sie die lokalen Restaurants und Tavernen' },
  it: { header: 'Ecco alcuni eventi:\n\n', empty: 'Nessun evento in programma al momento, ma c\'è tanto da esplorare! 🌟\n\n• Passeggia per il centro storico\n• Scopri le spiagge e le calette locali\n• Prova i ristoranti e le taverne locali' },
  fr: { header: 'Voici quelques événements:\n\n', empty: 'Pas d\'événements prévus pour l\'instant, mais il y a beaucoup à explorer ! 🌟\n\n• Promenez-vous dans la vieille ville historique\n• Découvrez les plages et criques locales\n• Goûtez aux restaurants et tavernes locaux' },
  sv: { header: 'Här är några evenemang:\n\n', empty: 'Inga evenemang planerade just nu, men det finns mycket att utforska! 🌟\n\n• Promenera genom den historiska gamla stan\n• Upptäck lokala stränder och vikar\n• Prova de lokala restaurangerna och krogarnas mat' },
  no: { header: 'Her er noen arrangementer:\n\n', empty: 'Ingen arrangementer planlagt akkurat nå, men det er mye å utforske! 🌟\n\n• Ta en tur gjennom den historiske gamlebyen\n• Oppdag lokale strender og viker\n• Prøv de lokale restaurantene og tavernene' },
  cs: { header: 'Zde jsou některé události:\n\n', empty: 'Momentálně nejsou naplánované žádné události, ale je tu spoustu k prozkoumání! 🌟\n\n• Projděte se historickým starým městem\n• Objevte místní pláže a zátoky\n• Vyzkoušejte místní restaurace a krčmy' },
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

// ---------------------------------------------------------------------------
// WhatsApp users — opt-in tracking
// ---------------------------------------------------------------------------

/**
 * Insert a new user or update last_message_at on every inbound message.
 */
async function upsertWhatsappUser(tenantId, phone) {
  const clean = normalizePhone(phone);
  console.log("RAW PHONE:", phone, "LOOKUP PHONE:", clean);

  // Update existing row by normalized phone — handles both stored formats
  // (whatsapp:+385... and +385...) without touching human_takeover
  console.log("MATCHING PHONE:", clean);
  const [result] = await pool.query(
    `UPDATE users SET phone = ?, last_message_at = NOW()
     WHERE tenant_id = ? AND phone = ?`,
    [clean, tenantId, clean]
  );

  console.log("USER UPDATE:", clean, "affectedRows:", result.affectedRows);

  if (result.affectedRows === 0) {
    // No existing row — insert fresh (new user, human_takeover defaults to 0)
    await pool.query(
      `INSERT INTO users (tenant_id, phone, last_message_at) VALUES (?, ?, NOW())`,
      [tenantId, clean]
    );
    console.log("USER INSERT (new):", clean);
  }
}

/**
 * Return { opt_in, asked_opt_in, human_takeover } for the user, or null if not found.
 */
async function getWhatsappUser(tenantId, phone) {
  const clean = normalizePhone(phone);
  console.log("RAW PHONE:", phone, "LOOKUP PHONE:", clean);
  const [rows] = await pool.query(
    'SELECT opt_in, asked_opt_in, human_takeover, awaiting_human_confirmation FROM users WHERE tenant_id = ? AND phone = ?',
    [tenantId, clean]
  );
  return (rows && rows[0]) || null;
}

/**
 * Set opt_in = value (1 or 0) for the user.
 */
async function setOptIn(tenantId, phone, value) {
  const clean = normalizePhone(phone);
  await pool.query(
    'UPDATE users SET opt_in = ? WHERE tenant_id = ? AND phone = ?',
    [value, tenantId, clean]
  );
}

/**
 * Set per-user human_takeover flag (1 = operator takes over, 0 = bot resumes).
 * Affects ONLY this user — all other users on the tenant continue using the bot.
 */
async function setUserTakeover(tenantId, phone, value) {
  const clean = normalizePhone(phone);
  await pool.query(
    'UPDATE users SET human_takeover = ? WHERE tenant_id = ? AND phone = ?',
    [value, tenantId, clean]
  );
  console.log(`[bot] per-user takeover set to ${value} for ${clean} on tenant ${tenantId}`);
}

async function setAwaitingConfirmation(tenantId, phone, value) {
  const clean = normalizePhone(phone);
  await pool.query(
    'UPDATE users SET awaiting_human_confirmation = ? WHERE tenant_id = ? AND phone = ?',
    [value, tenantId, clean]
  );
}

async function getLastUserLang(tenantId, phone) {
  const clean = normalizePhone(phone);
  const [rows] = await pool.query(
    "SELECT lang FROM messages WHERE tenant_id = ? AND REPLACE(user_phone, 'whatsapp:', '') = ? ORDER BY created_at DESC LIMIT 1",
    [tenantId, clean]
  );
  return (rows && rows[0] && rows[0].lang) || 'en';
}

module.exports = { normalizePhone, logMessage, getFaqMatch, getUpcomingEvents, getEventsByPeriod, checkAndIncrementUsage, detectLang, detectEventPeriod, getEventsFormatted, upsertWhatsappUser, getWhatsappUser, setOptIn, setUserTakeover, setAwaitingConfirmation, getLastUserLang };
