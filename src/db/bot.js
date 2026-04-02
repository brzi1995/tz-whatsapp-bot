const pool = require('./index');

/**
 * Normalize phone to plain +385... format.
 * Handles all incoming formats:
 *   "whatsapp:+385955225691" → "+385955225691"
 *   "+385 955 225 691"       → "+385955225691"
 *   "385955225691"           → "+385955225691"
 *   "%2B385955225691"        → "+385955225691"
 */
function normalizePhone(phone) {
  if (!phone) return phone;
  return decodeURIComponent(String(phone))
    .replace('whatsapp:', '')
    .replace(/\s+/g, '')
    .trim()
    .replace(/^385/, '+385'); // add + prefix when missing
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

const FAQ_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'at', 'be', 'by', 'for', 'from', 'how', 'i', 'in', 'is', 'it',
  'me', 'my', 'of', 'on', 'or', 'please', 'the', 'there', 'this', 'to', 'what', 'where',
  'with', 'you', 'your', 'can', 'do', 'does', 'have', 'has', 'near', 'info', 'information',
  'u', 'na', 'za', 'od', 'do', 'je', 'su', 'se', 'te', 'da', 'ili', 'koji', 'koja', 'koje',
  'sto', 'sta', 'što', 'gdje', 'kako', 'ima', 'li', 'mi', 'me', 'tu', 'ovo', 'ono', 'molim',
  'jel', 'gibt', 'es', 'der', 'die', 'das', 'und', 'ein', 'eine', 'ist', 'sind', 'ich',
  'ci', 'sono', 'il', 'lo', 'la', 'gli', 'le', 'un', 'una', 'per', 'con', 'del', 'della',
  'di', 'che', 'ou', 'et', 'de', 'des', 'est', 'sont', 'y', 'a', 'dans', 'sur', 'au',
]);

function normalizeFaqText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeFaqText(text) {
  return normalizeFaqText(text)
    .split(' ')
    .filter(Boolean)
    .filter(token => token.length > 1 && !FAQ_STOPWORDS.has(token));
}

function matchFaqToken(userToken, faqToken) {
  if (userToken === faqToken) return 1;
  if (userToken.length < 5 || faqToken.length < 5) return 0;
  if (userToken.startsWith(faqToken) || faqToken.startsWith(userToken)) return 0.9;
  if (userToken.includes(faqToken) || faqToken.includes(userToken)) return 0.7;
  return 0;
}

/**
 * Try to match a user message against FAQ entries for the tenant.
 * Returns { answer, score } for the best match (score = 0–1, matched keywords / total),
 * or null when nothing matches at all.
 * @param {number} tenantId
 * @param {string} userMessage
 * @returns {Promise<{answer:string, score:number}|null>}
 */
async function getFaqMatch(tenantId, userMessage) {
  try {
    const [rows] = await pool.query(
      'SELECT question, answer, link_title, link_url, link_image FROM faq WHERE tenant_id = ?',
      [tenantId]
    );
    if (!rows.length) return null;

    const normalised = normalizeFaqText(userMessage);
    const userTokens = tokenizeFaqText(userMessage);
    let best = null;

    for (const row of rows) {
      const questionNorm = normalizeFaqText(row.question);
      const keywords = tokenizeFaqText(row.question);
      if (!keywords.length) continue;

      let matchedWeight = 0;
      let exactLongMatch = false;
      let matchedKeywords = 0;

      for (const kw of keywords) {
        const bestMatch = userTokens.reduce((score, token) => Math.max(score, matchFaqToken(token, kw)), 0);
        if (bestMatch > 0) {
          matchedWeight += bestMatch;
          matchedKeywords += 1;
          if (bestMatch === 1 && kw.length >= 5) exactLongMatch = true;
        }
      }

      const coverage = matchedWeight / keywords.length;
      const phraseBonus = (questionNorm && (normalised.includes(questionNorm) || questionNorm.includes(normalised))) ? 0.35 : 0;
      const score = coverage + phraseBonus + (exactLongMatch ? 0.15 : 0);
      const isStrongMatch = score >= 0.45 || (exactLongMatch && keywords.length <= 4 && matchedKeywords >= 1);

      if (isStrongMatch && (!best || score > best.score)) {
        best = {
          answer:      row.answer,
          score,
          link_title:  row.link_title  || null,
          link_url:    row.link_url    || null,
          link_image:  row.link_image  || null,
        };
        console.log(`[bot] FAQ scored match on "${row.question}" — score: ${score.toFixed(2)}`);
      }
    }
    return best;
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
  console.log("RAW PHONE:", phone);
  console.log("NORMALIZED PHONE:", clean);

  // Read current takeover state BEFORE any write so we can detect accidental resets
  const [beforeRows] = await pool.query(
    'SELECT human_takeover FROM users_chat WHERE tenant_id = ? AND phone = ?',
    [tenantId, clean]
  );
  const beforeUser = (beforeRows && beforeRows[0]) || null;
  console.log("BEFORE UPDATE:", beforeUser?.human_takeover);

  // Update existing row — only touches phone + last_message_at, never human_takeover
  const [result] = await pool.query(
    `UPDATE users_chat SET phone = ?, last_message_at = NOW()
     WHERE tenant_id = ? AND phone = ?`,
    [clean, tenantId, clean]
  );

  console.log("USER UPDATE:", clean, "affectedRows:", result.affectedRows);

  if (result.affectedRows === 0) {
    // No existing row — insert fresh (new user, human_takeover inherits DB DEFAULT 0)
    await pool.query(
      `INSERT INTO users_chat (tenant_id, phone, last_message_at) VALUES (?, ?, NOW())`,
      [tenantId, clean]
    );
    console.log("USER INSERT (new):", clean);
  }

  // Read takeover state AFTER write to confirm it was not changed
  const [afterRows] = await pool.query(
    'SELECT human_takeover FROM users_chat WHERE tenant_id = ? AND phone = ?',
    [tenantId, clean]
  );
  const afterUser = (afterRows && afterRows[0]) || null;
  console.log("AFTER UPDATE:", afterUser?.human_takeover);

  if (beforeUser && Number(beforeUser.human_takeover) !== Number(afterUser?.human_takeover)) {
    console.error("TAKEOVER RESET DETECTED for", clean, "— was", beforeUser.human_takeover, "now", afterUser?.human_takeover);
  }
}

/**
 * Return { opt_in, asked_opt_in, human_takeover } for the user, or null if not found.
 */
async function getWhatsappUser(tenantId, phone) {
  const clean = normalizePhone(phone);
  console.log("RAW PHONE:", phone);
  console.log("NORMALIZED PHONE:", clean);
  const [rows] = await pool.query(
    'SELECT * FROM users_chat WHERE tenant_id = ? AND phone = ?',
    [tenantId, clean]
  );
  const user = (rows && rows[0]) || null;
  console.log("LOOKUP USER:", clean, user);
  if (user === null) {
    console.error("USER NOT FOUND in users_chat for phone:", clean, "tenant:", tenantId);
  }
  return user;
}

/**
 * Set opt_in = value (1 or 0) for the user.
 */
async function setOptIn(tenantId, phone, value) {
  const clean = normalizePhone(phone);
  console.log("RAW PHONE:", phone);
  console.log("NORMALIZED PHONE:", clean);
  await pool.query(
    'UPDATE users_chat SET opt_in = ? WHERE tenant_id = ? AND phone = ?',
    [value, tenantId, clean]
  );
}

/**
 * Set per-user human_takeover flag (1 = operator takes over, 0 = bot resumes).
 * Affects ONLY this user — all other users on the tenant continue using the bot.
 */
async function setUserTakeover(tenantId, phone, value) {
  const clean = normalizePhone(phone);
  console.log("RAW PHONE:", phone);
  console.log("NORMALIZED PHONE:", clean);
  await pool.query(
    'UPDATE users_chat SET human_takeover = ? WHERE tenant_id = ? AND phone = ?',
    [value, tenantId, clean]
  );
  console.log(`[bot] per-user takeover set to ${value} for ${clean} on tenant ${tenantId}`);
}

async function setAwaitingConfirmation(tenantId, phone, value) {
  const clean = normalizePhone(phone);
  await pool.query(
    'UPDATE users_chat SET awaiting_human_confirmation = ? WHERE tenant_id = ? AND phone = ?',
    [value, tenantId, clean]
  );
}

/**
 * Set asked_opt_in flag (1 = waiting for da/ne, 0 = not waiting).
 */
async function setAskedOptIn(tenantId, phone, value) {
  const clean = normalizePhone(phone);
  await pool.query(
    'UPDATE users_chat SET asked_opt_in = ? WHERE tenant_id = ? AND phone = ?',
    [value, tenantId, clean]
  );
}

/**
 * Store the detected language on the user record.
 */
async function setUserLang(tenantId, phone, lang) {
  const clean = normalizePhone(phone);
  try {
    await pool.query(
      'UPDATE users_chat SET language = ? WHERE tenant_id = ? AND phone = ?',
      [lang, tenantId, clean]
    );
  } catch (err) {
    // Column may not exist yet — migration runs on startup, ignore silently
    console.warn('[bot] setUserLang error (column may be missing):', err.message);
  }
}

async function getLastUserLang(tenantId, phone) {
  const clean = normalizePhone(phone);
  const [rows] = await pool.query(
    "SELECT lang FROM messages WHERE tenant_id = ? AND REPLACE(user_phone, 'whatsapp:', '') = ? ORDER BY created_at DESC LIMIT 1",
    [tenantId, clean]
  );
  return (rows && rows[0] && rows[0].lang) || 'en';
}

module.exports = { normalizePhone, logMessage, getFaqMatch, getUpcomingEvents, getEventsByPeriod, checkAndIncrementUsage, detectLang, detectEventPeriod, getEventsFormatted, upsertWhatsappUser, getWhatsappUser, setOptIn, setUserTakeover, setAwaitingConfirmation, setAskedOptIn, setUserLang, getLastUserLang };
