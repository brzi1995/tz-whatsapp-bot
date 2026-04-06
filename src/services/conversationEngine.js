'use strict';

/**
 * Conversation Engine — Slot-Based Routing
 *
 * Replaces the conflicting forcedIntent / expectedAnswer / awaiting / lastTopic
 * patchwork with a single clean decision tree.
 *
 * Session shape stored in conversation.state:
 *   pendingSlot  { topic, field, question } | null  — what bot is waiting for
 *   lastTopic    string | null                       — last resolved topic (follow-ups)
 *   lastQuestion string | null                       — anti-loop guard
 *
 * All three fields are mutated in place by handleMessage().
 * The caller is responsible for persisting them after each turn.
 */

// ─── INTENT DETECTION ────────────────────────────────────────────────────────

const TOPIC_PATTERNS = {
  parking:     /\b(parking|park\b|parkir|parkage|stationnement|parcheggio|parken|parkovat|parkiranje)\b/i,
  weather:     /\b(weather|forecast|rain|sunny|sun\b|wind|temperature|cloud|hot|cold|humid|wetter|regen|sonne|temperatur|vorhersage|vrijeme|prognoza|kiša|sunce|vjetar|temperatura|oblaci|météo|meteo|tempo|pioggia|previsione|sole|pogoda)\b/i,
  events:      /\b(event|events|happening|what'?s happening|what'?s on|veranstaltung|veranstaltungen|evento|eventi|événement|événements|evenemang|arrangement|dogadjaj|dogadjaji|dogadaj|dogadanja|dogadanja|akce|události)\b/i,
  restaurants: /\b(restaurant|restoran|ristorante|food|dinner|lunch|eat|essen|mangiare|manger|konobi|konoba|hrana|večera|ručak|gastr|café|tavern|seafood|pizza|italian|dalmatian|cuisine|local|bar|bars|drink|drinks)\b/i,
};

// Follow-up patterns — only active when we were already on that topic
const WEATHER_FOLLOWUP = /\b(tomorrow|sutra|morgen|demain|domani|today|danas|heute|oggi|forecast|prognoza|in\s+\d+\s+days?|za\s+\d+\s+dana|next\s+\d+\s+days?|sljedec|iduc)\b/i;
const EVENT_FOLLOWUP   = /\b(today|tonight|tomorrow|this\s+week|this\s+weekend|weekend|music|live\s+music|family|family-friendly|sutra|danas|večeras|veceras|tjedan|ovih\s+dana|ovaj\s+tjedan)\b/i;

/**
 * Detect the topic and confidence of a message.
 *
 * confidence === 'high'  → clear new topic keyword → always switch, clear pendingSlot
 * confidence === 'low'   → ambiguous → treat as answer to pendingSlot if one exists
 */
function detectIntent(message, session = {}) {
  const msg = String(message || '');

  // 1. Explicit topic keywords — always high confidence
  for (const [topic, pattern] of Object.entries(TOPIC_PATTERNS)) {
    if (pattern.test(msg)) return { topic, confidence: 'high' };
  }

  // 2. Topic-sensitive follow-ups (only when conversation context matches)
  if (session.lastTopic === 'weather' && WEATHER_FOLLOWUP.test(msg)) {
    return { topic: 'weather', confidence: 'high' };
  }
  if (session.lastTopic === 'events' && EVENT_FOLLOWUP.test(msg)) {
    return { topic: 'events', confidence: 'high' };
  }

  // 3. No clear topic found
  return { topic: 'unknown', confidence: 'low' };
}

// ─── SLOT HELPER ──────────────────────────────────────────────────────────────

/**
 * Set a pending slot on the session and return the question to ask.
 * Session is mutated — caller must persist it.
 */
function askSlot(session, slot) {
  session.pendingSlot  = slot;
  session.lastQuestion = slot.question;
  return slot.question;
}

// ─── SHARED UTILITY ───────────────────────────────────────────────────────────

/** Normalise text for matching: lowercase, strip diacritics + punctuation. */
function norm(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Suggestions helper
function getSuggestions(topic) {
  switch (topic) {
    case 'parking':
      return ['parking near beaches', 'nearby restaurants', 'weather today'];
    case 'weather':
      return ["tomorrow's forecast", '5-day forecast', '10-day forecast'];
    case 'events':
      return ["what's happening tonight", 'events this weekend', 'restaurants nearby'];
    case 'restaurants':
      return ['seafood', 'pizza / Italian'];
    default:
      return [];
  }
}

function formatSuggestions(topic, excludeContains = []) {
  const items = getSuggestions(topic).filter((item) =>
    !excludeContains.some((ex) => item.toLowerCase().includes(ex.toLowerCase()))
  );
  if (!items.length) return '';
  return '\n\nIf you want, I can also help with:\n• ' + items.join('\n• ');
}

const FORECAST_URL = 'https://weather.com/hr-HR/vrijeme/10dana/l/Brela+Splitsko+dalmatinska+%C5%BEupanija';

// ─── PARKING HANDLER ──────────────────────────────────────────────────────────

/**
 * Extract a parking location category from a message.
 * Returns 'center' | 'beach' | 'accommodation' | <raw string> | null
 * null means the message gave no location at all.
 */
function extractParkingLocation(message) {
  const n = norm(message);

  // Direct contains checks first (no regex miss)
  const centerWords = ['center', 'centar', 'city center', 'downtown', 'u centru', 'u centar'];
  const beachWords  = ['beach', 'near beach', 'plaža', 'plaza', 'uz plažu', 'near the beach'];
  const accWords    = ['accommodation', 'near accommodation', 'hotel', 'apartman', 'apartment', 'room', 'near hotel'];
  for (const w of centerWords) { if (n.includes(norm(w))) return 'center'; }
  for (const w of beachWords)  { if (n.includes(norm(w)))  return 'beach'; }
  for (const w of accWords)    { if (n.includes(norm(w)))  return 'accommodation'; }

  const tokens = n.split(/\s+/).filter(Boolean);

  // Numbered menu selections
  if (n === '1' || tokens[0] === '1') return 'center';
  if (n === '2' || tokens[0] === '2') return 'beach';
  if (n === '3' || tokens[0] === '3') return 'accommodation';

  // Category keywords
  if (/\b(cent(ar|er|re)|trg|downtown|city\s+cent)\b/.test(n)) return 'center';
  if (/\b(beach|plaz|plaža|strand|spiaggia|punta\s*rata|soline|podrac)\b/.test(n)) return 'beach';
  if (/\b(hotel|apart(ment|man)|smjestaj|smještaj|accommodation|unterkunft|alloggio|room|soba|stay)\b/.test(n)) return 'accommodation';

  // Filter out noise words to find a raw location name
  const NOISE = new Set(['parking', 'park', 'where', 'need', 'want', 'find', 'near',
    'close', 'to', 'the', 'for', 'please', 'can', 'you', 'tell', 'me', 'i',
    'a', 'an', 'in', 'at', 'by', 'is', 'are', 'there', 'any', 'do', 'have']);
  const meaningful = tokens.filter(w => w.length > 1 && !NOISE.has(w));

  if (meaningful.length === 0) return null;   // nothing useful → ask
  return meaningful.join(' ');               // specific but unknown location
}

const PARKING_GENERAL = {
  hr: 'Javni parking u Brelima:\n• centar (Trg A. Stepinca)\n• Punta Rata\n• Soline\n• Podrače\n\nU sezoni se brzo popuni — dolazite ranije.',
  en: 'Public parking in Brela:\n• center (Trg A. Stepinca)\n• Punta Rata\n• Soline\n• Podrače\n\nGets full fast in season — arrive early.',
  de: 'Öffentliche Parkplätze in Brela:\n• Zentrum (Trg A. Stepinca)\n• Punta Rata\n• Soline\n• Podrače\n\nIn der Saison schnell voll — früh anreisen.',
  it: 'Parcheggi pubblici a Brela:\n• centro (Trg A. Stepinca)\n• Punta Rata\n• Soline\n• Podrače\n\nSi riempie presto in stagione.',
  fr: 'Parkings publics à Brela :\n• centre (Trg A. Stepinca)\n• Punta Rata\n• Soline\n• Podrače\n\nSe remplit vite en saison.',
  sv: 'Offentlig parkering i Brela:\n• centrum (Trg A. Stepinca)\n• Punta Rata\n• Soline\n• Podrače',
  no: 'Offentlig parkering i Brela:\n• sentrum (Trg A. Stepinca)\n• Punta Rata\n• Soline\n• Podrače',
  cs: 'Veřejná parkoviště v Brele:\n• centrum (Trg A. Stepinca)\n• Punta Rata\n• Soline\n• Podrače',
};

const PARKING_ANSWERS = {
  center: {
    hr: 'Parking u centru je na Trgu A. Stepinca i uz rivu. U sezoni se brzo popuni — bolje doći ranije. 🅿️',
    en: 'Center parking is at Trg A. Stepinca and along the waterfront. Gets full fast in season — arrive early. 🅿️',
    de: 'Stadtparkplatz: Trg A. Stepinca und Uferpromenade. In der Saison schnell voll — früh anreisen. 🅿️',
    it: 'Parcheggio centro: Trg A. Stepinca e lungomare. Si riempie presto in stagione. 🅿️',
    fr: 'Parking centre : Trg A. Stepinca et promenade. Se remplit vite en saison. 🅿️',
    sv: 'Parkering i centrum: Trg A. Stepinca och strandpromenaden. Fylls snabbt under säsongen. 🅿️',
    no: 'Parkering i sentrum: Trg A. Stepinca og strandpromenaden. Fylles raskt i sesongen. 🅿️',
    cs: 'Parkování v centru: Trg A. Stepinca a nábřeží. V sezóně se rychle zaplní — přijeďte dříve. 🅿️',
  },
  beach: {
    hr: 'Parking uz plaže je direktno kod Punta Rate, Soline i Podrača. Plaća se u sezoni. U špici dolazite ranije. 🅿️',
    en: 'Beach parking is right at Punta Rata, Soline, and Podrače. Paid in high season. Arrive early at peak times. 🅿️',
    de: 'Strandparkplätze: direkt bei Punta Rata, Soline und Podrače. Kostenpflichtig in der Saison. Früh kommen. 🅿️',
    it: 'Parcheggio spiaggia: Punta Rata, Soline e Podrače. A pagamento in alta stagione. 🅿️',
    fr: 'Parking plage : Punta Rata, Soline et Podrače. Payant en haute saison. 🅿️',
    sv: 'Strandparkering vid Punta Rata, Soline och Podrače. Avgiftsbelagt under högsäsong. 🅿️',
    no: 'Strandparkering ved Punta Rata, Soline og Podrače. Avgiftsbelagt i høysesong. 🅿️',
    cs: 'Parkování u pláží: Punta Rata, Soline a Podrače. V hlavní sezóně se platí. 🅿️',
  },
  accommodation: {
    hr: 'Većina privatnih smještaja u Brelima ima parking. Za javni: centar (Trg A. Stepinca) ili uz plaže Punta Rata, Soline, Podrače. 🅿️',
    en: 'Most private stays in Brela include parking. For public: center (Trg A. Stepinca) or beaches Punta Rata, Soline, Podrače. 🅿️',
    de: 'Die meisten Privatunterkünfte in Brela haben Parkplatz. Öffentlich: Zentrum (Trg A. Stepinca) oder Punta Rata, Soline, Podrače. 🅿️',
    it: 'La maggior parte degli alloggi a Brela ha parcheggio. Pubblico: centro (Trg A. Stepinca) o Punta Rata, Soline, Podrače. 🅿️',
    fr: 'La plupart des hébergements à Brela ont un parking. Public : centre (Trg A. Stepinca) ou Punta Rata, Soline, Podrače. 🅿️',
    sv: 'De flesta boenden i Brela har parkering. Offentlig: centrum (Trg A. Stepinca) eller Punta Rata, Soline, Podrače. 🅿️',
    no: 'De fleste overnattingssteder i Brela har parkering. Offentlig: sentrum (Trg A. Stepinca) eller Punta Rata, Soline, Podrače. 🅿️',
    cs: 'Většina ubytování v Brele má parkování. Veřejné: centrum (Trg A. Stepinca) nebo Punta Rata, Soline, Podrače. 🅿️',
  },
};

async function handleParking(userMsg, session, deps) {
  const { lang } = deps;

  // Single-step answer only — no slots, no follow-ups.
  session.pendingSlot = null;
  session.lastQuestion = null;
  session.lastTopic = 'parking';

  const SIMPLE = {
    hr: 'Parking u Breli je najčešće dostupan u centru i uz glavne plaže. Tijekom ljeta mjesta se brzo popune, pa je najbolje doći ranije u danu. Ako želite, mogu pomoći i s plažama, restoranima, vremenom ili događanjima.',
    en: 'Parking in Brela is mainly available in the town center and near the main beach areas. During summer, spots can fill up quickly, so it is best to arrive earlier in the day. If you want, I can also help with beaches, restaurants, weather, or events.',
  };

  return SIMPLE[lang] || SIMPLE.en;
}

// ─── WEATHER HANDLER ──────────────────────────────────────────────────────────

/** Parse what time period the user wants. Returns 'current'|'tomorrow'|{type:'forecast',days}|'long'. */
function getWeatherSubIntent(message) {
  const n = norm(message);

  if (/\b(tomorrow|sutra|morgen|demain|domani)\b/.test(n)) return 'tomorrow';

  // "in 5 days" / "za 5 dana" / "next 5 days"
  const dayMatch = n.match(/\b(?:in|za|next)\s+(\d{1,2})\s*(?:days?|dana|tage|giorni|jours)?\b/);
  if (dayMatch) {
    const days = parseInt(dayMatch[1], 10);
    if (days >= 10) return 'long';
    return days > 5 ? { type: 'forecast', days: 5 } : { type: 'forecast', days };
  }

  // plain number + days
  const numMatch = n.match(/\b(\d{1,2})\s+(?:days?|dana|tage|giorni|jours)\b/);
  if (numMatch) {
    const days = parseInt(numMatch[1], 10);
    if (days >= 10) return 'long';
    return days > 5 ? { type: 'forecast', days: 5 } : { type: 'forecast', days };
  }

  if (/\b(week|tjedan|woche|settimana|semaine)\b/.test(n)) return { type: 'forecast', days: 5 };
  return 'current';
}

function fmtDate(dateInput) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
}

async function handleWeather(userMsg, session, deps) {
  const { lang, openWeatherKey, city = 'Brela' } = deps;

  session.pendingSlot = null;
  session.lastQuestion = null;
  session.lastTopic = 'weather';

  const UNAVAIL = {
    hr: `🌤️ Nemam live podatke trenutno. Detaljna prognoza: ${FORECAST_URL}`,
    en: `🌤️ No live weather data right now. Detailed forecast: ${FORECAST_URL}`,
    de: `🌤️ Keine Live-Daten aktuell. Detailvorhersage: ${FORECAST_URL}`,
    it: `🌤️ Nessun dato live ora. Previsioni dettagliate: ${FORECAST_URL}`,
    fr: `🌤️ Pas de données en direct. Prévisions détaillées : ${FORECAST_URL}`,
    sv: `🌤️ Ingen live data just nu. Detaljerad prognos: ${FORECAST_URL}`,
    no: `🌤️ Ingen live data nå. Detaljert prognose: ${FORECAST_URL}`,
    cs: `🌤️ Žádná živá data. Detailní předpověď: ${FORECAST_URL}`,
  };
  const LONG_RANGE = {
    hr: `För 10-dnevnu prognozu za Brela: ${FORECAST_URL}`,
    en: `For a 10-day forecast for Brela: ${FORECAST_URL}`,
    de: `10-Tage-Vorhersage für Brela: ${FORECAST_URL}`,
    it: `Previsioni 10 giorni per Brela: ${FORECAST_URL}`,
    fr: `Prévisions 10 jours pour Brela : ${FORECAST_URL}`,
    sv: `10-dagsprognos för Brela: ${FORECAST_URL}`,
    no: `10-dagers prognose for Brela: ${FORECAST_URL}`,
    cs: `10denní předpověď pro Brela: ${FORECAST_URL}`,
  };
  const LABELS = {
    current:  { hr: 'Danas u Brelima',  en: 'Brela today',    de: 'Brela heute',  it: 'Brela oggi',   fr: "Brela aujourd'hui", sv: 'Brela idag',    no: 'Brela i dag',    cs: 'Brela dnes' },
    tomorrow: { hr: 'Sutra u Brelima',  en: 'Brela tomorrow', de: 'Brela morgen', it: 'Brela domani', fr: 'Brela demain',       sv: 'Brela imorgon', no: 'Brela i morgen', cs: 'Brela zítra' },
  };

  if (!openWeatherKey) return UNAVAIL[lang] || UNAVAIL.en;

  const subIntent = getWeatherSubIntent(userMsg);
  if (subIntent === 'long') {
    // Only include the 10-day link when explicitly requested
    return LONG_RANGE[lang] || LONG_RANGE.en;
  }

  const owLang = ['hr', 'en', 'de', 'it', 'fr'].includes(lang) ? lang : 'en';
  const q = encodeURIComponent(city);

  try {
    if (subIntent === 'current') {
      const res  = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=${q}&appid=${openWeatherKey}&units=metric&lang=${owLang}`);
      if (!res.ok) return UNAVAIL[lang] || UNAVAIL.en;
      const data = await res.json();
      const lbl  = LABELS.current[lang] || LABELS.current.en;
      const ans = `🌤️ ${lbl}: ${Math.round(data.main.temp)}°C, ${data.weather[0]?.description || ''}`;
      return ans + formatSuggestions('weather');
    }

    // Forecast endpoint covers tomorrow + multi-day
    const res  = await fetch(`https://api.openweathermap.org/data/2.5/forecast?q=${q}&appid=${openWeatherKey}&units=metric&lang=${owLang}`);
    if (!res.ok) return UNAVAIL[lang] || UNAVAIL.en;
    const data = await res.json();

    if (subIntent === 'tomorrow') {
      const tStr  = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const entry = data.list.find(e => e.dt_txt.startsWith(tStr) && e.dt_txt.includes('12:00'))
                 || data.list.find(e => e.dt_txt.startsWith(tStr));
      if (!entry) return UNAVAIL[lang] || UNAVAIL.en;
      const lbl = LABELS.tomorrow[lang] || LABELS.tomorrow.en;
      const ans = `🌤️ ${lbl}: ${Math.round(entry.main.temp)}°C, ${entry.weather[0]?.description || ''}`;
      return ans; // no extra suggestions after answering tomorrow directly
    }

    // Multi-day forecast
    const { days } = subIntent;
    const lines = [];
    for (let i = 1; i <= days; i++) {
      const dStr  = new Date(Date.now() + i * 86400000).toISOString().slice(0, 10);
      const entry = data.list.find(e => e.dt_txt.startsWith(dStr) && e.dt_txt.includes('12:00'))
                 || data.list.find(e => e.dt_txt.startsWith(dStr));
      if (entry) lines.push(`${fmtDate(dStr)}: ${Math.round(entry.main.temp)}°C, ${entry.weather[0]?.description || ''}`);
    }
    if (!lines.length) return UNAVAIL[lang] || UNAVAIL.en;

    const FORECAST_HDR = {
      hr: (n) => `Prognoza za ${n} dana u Brelima`,
      en: (n) => `${n}-day forecast for Brela`,
      de: (n) => `${n}-Tage-Vorhersage Brela`,
      it: (n) => `Previsioni ${n} giorni Brela`,
      fr: (n) => `Prévisions ${n} jours Brela`,
      sv: (n) => `${n}-dagarsprognos Brela`,
      no: (n) => `${n}-dagersprognose Brela`,
      cs: (n) => `${n}denní prognóza Brela`,
    };
    const hdrFn = FORECAST_HDR[lang] || FORECAST_HDR.en;
    const ans = `🌤️ ${hdrFn(days)}:\n${lines.join('\n')}`;
    return ans; // don't append further suggestions after 5-day reply

  } catch (err) {
    console.error('[engine/weather]', err.message);
    return UNAVAIL[lang] || UNAVAIL.en;
  }
}

// ─── EVENTS HANDLER ───────────────────────────────────────────────────────────

function parseEventFollowUp(message) {
  const n = norm(message);
  if (/\b(tonight|veceras|večeras|today|danas)\b/.test(n)) return 'tonight';
  if (/\b(weekend|this weekend|ovaj tjedan|ovih dana|this week)\b/.test(n)) return 'weekend';
  if (/\b(live music|music|glazba|koncert)\b/.test(n)) return 'music';
  if (/\b(family|family friendly|obitelj|djeca)\b/.test(n)) return 'family';
  return null;
}

function eventDateValue(ev) {
  const v = ev?.date || ev?.start_at || ev?.start || ev?.datetime || ev?.time || null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? Number.MAX_SAFE_INTEGER : d.getTime();
}

function eventDateLabel(ev) {
  const raw = ev?.date || ev?.start_at || ev?.start || ev?.datetime || ev?.time || '';
  const d = raw instanceof Date ? raw : new Date(raw);
  if (!raw || Number.isNaN(d.getTime())) return 'Date TBD';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  if (hh === '00' && mi === '00') return `${dd}.${mm}.`;
  return `${dd}.${mm}. ${hh}:${mi}`;
}

function eventLocationLabel(ev) {
  return ev?.location || ev?.venue || ev?.place || ev?.location_name || ev?.location_link || 'Brela';
}

function eventDescriptionLabel(ev) {
  const raw = String(ev?.description || ev?.short_description || ev?.excerpt || '').replace(/\s+/g, ' ').trim();
  if (!raw) return 'No extra details available.';
  return raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
}

function filterEvents(events, filterKey) {
  if (!filterKey) return events;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const tomorrowStart = todayStart + 24 * 60 * 60 * 1000;
  const weekendEnd = todayStart + 7 * 24 * 60 * 60 * 1000;

  if (filterKey === 'tonight') {
    return events.filter((ev) => {
      const t = eventDateValue(ev);
      return t >= todayStart && t < tomorrowStart;
    });
  }
  if (filterKey === 'weekend') {
    return events.filter((ev) => {
      const t = eventDateValue(ev);
      return t >= todayStart && t < weekendEnd;
    });
  }
  if (filterKey === 'music') {
    return events.filter((ev) => /\b(music|live|concert|dj|band|glazba|koncert)\b/i.test(`${ev?.title || ''} ${ev?.description || ''}`));
  }
  if (filterKey === 'family') {
    return events.filter((ev) => /\b(family|kids|children|obitelj|djeca)\b/i.test(`${ev?.title || ''} ${ev?.description || ''}`));
  }
  return events;
}

function formatTopEvents(events) {
  const sorted = [...events].sort((a, b) => eventDateValue(a) - eventDateValue(b)).slice(0, 3);
  return sorted
    .map((ev, i) => `${i + 1}. ${ev?.title || 'Event'}\n${eventDateLabel(ev)} • ${eventLocationLabel(ev)}\n${eventDescriptionLabel(ev)}`)
    .join('\n\n');
}

async function handleEvents(userMsg, session, deps) {
  const { tenantId, getUpcomingEvents } = deps;

  session.pendingSlot = null;
  session.lastQuestion = null;
  session.lastTopic = 'events';
  const NO_EVENTS = 'There are no confirmed events at the moment, but you can check the official local calendar at brela.hr.';
  const NARROW = 'I can also narrow it down to:\n- tonight\n- this weekend\n- live music\n- family-friendly';

  try {
    const allEvents = await getUpcomingEvents(tenantId);
    if (!allEvents.length) return NO_EVENTS;

    const followUp = parseEventFollowUp(userMsg);
    const filtered = filterEvents(allEvents, followUp);
    if (!filtered.length) {
      if (followUp) session.lastTopic = null;
      return NO_EVENTS;
    }

    const body = formatTopEvents(filtered);
    if (followUp) {
      session.lastTopic = null;
      return body;
    }
    return `${body}\n\n${NARROW}`;

  } catch (err) {
    console.error('[engine/events]', err.message);
    return NO_EVENTS;
  }
}

// ─── RESTAURANTS HANDLER ──────────────────────────────────────────────────────

async function handleRestaurants(userMsg, session, deps) {
  const { lang, restaurantUrl } = deps;

  session.pendingSlot = null;
  session.lastQuestion = null;
  session.lastTopic = 'restaurants';

  const n = norm(userMsg);

  const PREF = {
    seafood: /\b(seafood|fish|ribe|riba|frutti|mare)\b/,
    pizza: /\b(pizza|italian|italiano)\b/,
    local: /\b(local|dalmatian|domaca|domaća|traditional|tradicional)\b/,
    bars: /\b(bar|bars|drink|drinks|cocktail|cocktails)\b/,
  };

  const MSG = {
    hr: `Ovdje su informacije za restorane i barove u Brelima:\n${restaurantUrl}\n\nMožete birati po stilu hrane:\n• seafood\n• pizza / Italian\n• local Dalmatian cuisine`,
    en: `Here are the restaurant and bar options in Brela:\n${restaurantUrl}\n\nYou can choose by food style:\n• seafood\n• pizza / Italian\n• local Dalmatian cuisine`,
    de: `Hier sind Restaurants und Bars in Brela:\n${restaurantUrl}\n\nAuswahl nach Stil:\n• seafood\n• pizza / Italian\n• local Dalmatian cuisine`,
    it: `Ecco ristoranti e bar a Brela:\n${restaurantUrl}\n\nPuoi scegliere per stile:\n• seafood\n• pizza / Italian\n• local Dalmatian cuisine`,
    fr: `Voici les restaurants et bars à Brela :\n${restaurantUrl}\n\nVous pouvez choisir par style :\n• seafood\n• pizza / Italian\n• local Dalmatian cuisine`,
    sv: `Här är restauranger och barer i Brela:\n${restaurantUrl}\n\nVälj efter matstil:\n• seafood\n• pizza / Italian\n• local Dalmatian cuisine`,
    no: `Her er restauranter og barer i Brela:\n${restaurantUrl}\n\nVelg etter matstil:\n• seafood\n• pizza / Italian\n• local Dalmatian cuisine`,
    cs: `Zde jsou restaurace a bary v Brele:\n${restaurantUrl}\n\nMůžete vybírat podle stylu:\n• seafood\n• pizza / Italian\n• local Dalmatian cuisine`,
  };
  const SPECIFIC = {
    seafood: {
      hr: `Za seafood opcije u Brelima pogledajte:\n${restaurantUrl}`,
      en: `For seafood options in Brela, check:\n${restaurantUrl}`,
    },
    pizza: {
      hr: `Za pizza / Italian opcije u Brelima pogledajte:\n${restaurantUrl}`,
      en: `For pizza / Italian options in Brela, check:\n${restaurantUrl}`,
    },
    local: {
      hr: `Za lokalnu kuhinju u Brelima pogledajte:\n${restaurantUrl}`,
      en: `For local cuisine in Brela, check:\n${restaurantUrl}`,
    },
    bars: {
      hr: `Za barove i piće u Brelima pogledajte:\n${restaurantUrl}`,
      en: `For bars and drinks in Brela, check:\n${restaurantUrl}`,
    },
  };

  if (PREF.seafood.test(n)) return (SPECIFIC.seafood[lang] || SPECIFIC.seafood.en);
  if (PREF.pizza.test(n)) return (SPECIFIC.pizza[lang] || SPECIFIC.pizza.en);
  if (PREF.local.test(n)) return (SPECIFIC.local[lang] || SPECIFIC.local.en);
  if (PREF.bars.test(n)) return (SPECIFIC.bars[lang] || SPECIFIC.bars.en);

  return MSG[lang] || MSG.en;
}

// ─── TOPIC HANDLERS MAP ───────────────────────────────────────────────────────

const TOPIC_HANDLERS = {
  parking:     { handle: handleParking },
  weather:     { handle: handleWeather },
  events:      { handle: handleEvents },
  restaurants: { handle: handleRestaurants },
};

// ─── ROUTING HELPERS ──────────────────────────────────────────────────────────

/**
 * A topic switch is only "clear" when the message is long enough to be an
 * explicit new request — not a slot answer that happens to contain a keyword.
 *
 * Examples that must NOT switch topic when pendingSlot exists:
 *   "center"            (1 word  — slot answer for parking)
 *   "Vruja"             (1 word  — slot answer for parking)
 *   "local"             (1 word  — slot answer for restaurant follow-up)
 *   "ok"                (1 word  — ack)
 *   "and tomorrow"      (2 words — weather follow-up)
 *   "near the restaurant" (3 words but no strong intent verb)
 *
 * Examples that SHOULD switch topic even with a pending slot:
 *   "what is the weather today"   (5 words + weather keyword)
 *   "show me parking options"     (4 words + parking keyword)
 *   "any events this week"        (4 words + events keyword)
 */
function isClearTopicSwitch(message) {
  const words = message.trim().split(/\s+/).filter(Boolean);
  if (words.length < 3) return false; // short messages are always slot answers
  return /\b(weather|forecast|parking|park\b|events?|restaurant|restoran|pogoda|vrijeme|prognoza|događaj|dogadjaj)\b/i.test(message);
}

/**
 * Weather follow-ups: short time-reference messages after a weather answer
 * should continue the weather conversation, not fall through to FAQ/AI.
 */
function isWeatherFollowUp(message, session) {
  const parsed = parseWeatherFollowUp(message);
  if (!parsed) return false;

  // Don't hijack explicit event questions.
  const n = norm(message);
  if (/\b(event|events|dogadj|dogadaj|događaj|eventi|veranstaltung)\b/.test(n)) return false;

  // Support stateless quick replies from weather suggestions.
  return true;
}

function parseWeatherFollowUp(message) {
  const n = norm(message);
  if (!n) return null;

  // tomorrow variants (including common misspellings)
  if (/\b(tomorrow|tommorow|tmrw|tmr|sutra|morgen|demain|domani)\b/.test(n)) {
    return { type: 'tomorrow' };
  }

  // explicit 10-day
  if (/\b(10\s*day|10\s*days|10-day|10day)\b/.test(n)) {
    return { type: 'long' };
  }

  // explicit 5-day
  if (/\b(5\s*day|5\s*days|5-day|5day|forecast\s*5|yes\s*5\s*days)\b/.test(n)) {
    return { type: 'forecast', days: 5 };
  }

  // generic N-days
  const nDays = n.match(/\b(\d{1,2})\s*days?\b/);
  if (nDays) {
    const days = parseInt(nDays[1], 10);
    if (days >= 10) return { type: 'long' };
    return { type: 'forecast', days: Math.max(1, Math.min(days, 5)) };
  }

  // generic "forecast" follow-up -> default to 5-day
  if (/\bforecast\b/.test(n)) {
    return { type: 'forecast', days: 5 };
  }

  return null;
}

function isEventFollowUp(message, session) {
  if (session.lastTopic !== 'events') return false;
  return Boolean(parseEventFollowUp(message));
}

// ─── MAIN ROUTER ──────────────────────────────────────────────────────────────

/**
 * Main entry point. Call once per incoming message.
 *
 * Routing priority (highest → lowest):
 *   1. pendingSlot exists + NOT a clear topic switch → slot answer
 *   2. weather follow-up (time reference after weather reply) → weather
 *   3. high-confidence new topic (or clear topic switch) → switch
 *   4. no context → return null (fall through to FAQ/AI)
 *
 * @param  {string} userMsg   Raw user message
 * @param  {object} session   Mutable session: { pendingSlot, lastTopic, lastQuestion }
 *                            Engine mutates this in place — persist it after the call.
 * @param  {object} deps      Runtime dependencies:
 *   lang             — detected ISO 639-1 language code
 *   tenantId         — for DB queries
 *   openWeatherKey   — OpenWeatherMap API key
 *   city             — city name for weather (e.g. 'Brela')
 *   brelaUrl         — official info URL
 *   restaurantUrl    — restaurant directory URL
 *   getEventsByPeriod(tenantId, period) → Promise<Array>
 *   getUpcomingEvents(tenantId)         → Promise<Array>
 *   getFaqMatch(msg)                    → Promise<Object|null>  (tenantId already bound)
 *
 * @returns {Promise<string|null>}
 *   A reply string → engine handled it, persist session + send reply.
 *   null            → engine couldn't handle it, fall through to FAQ/AI.
 */
async function handleMessage(userMsg, session, deps) {
  const { lang } = deps;
  const msg = String(userMsg || '').trim();
  if (!msg) return null;

  // ── Priority 1: pendingSlot ───────────────────────────────────────────────
  // pendingSlot always wins. No intent detection, no fallback.
  if (session.pendingSlot) {
    const handler = TOPIC_HANDLERS?.[session.pendingSlot.topic];

    if (!handler || typeof handler.handle !== 'function') {
      session.pendingSlot = null;
      return 'Došlo je do greške. Molimo pokušajte ponovno.';
    }

    try {
      const reply = await handler.handle(msg, session, deps);
      if (!reply) {
        session.pendingSlot = null;
        return 'Došlo je do greške. Molimo pokušajte ponovno.';
      }
      return reply;
    } catch (err) {
      console.error('pendingSlot handler error:', err);
      session.pendingSlot = null;
      return 'Došlo je do greške. Molimo pokušajte ponovno.';
    }
  }

  // ── Priority 1: pendingSlot ───────────────────────────────────────────────
  // pendingSlot always wins. No intent detection, no fallback.
  if (session.pendingSlot) {
    const handler = TOPIC_HANDLERS[session.pendingSlot.topic];
    if (!handler || typeof handler.handle !== 'function') {
      session.pendingSlot = null;
    } else {
      return handler.handle(msg, session, deps);
    }
  }

  let activeTopic;

  // ── Priority 2: trivial acknowledgements ─────────────────────────────────
  // "ok", "thanks", "hvala", 👍 — send a friendly closer, preserve session.
  if (/^(ok|okay|thanks|thank you|hvala|👍|thx|cheers|gracias|merci|danke|grazie|tack|takk|dekuji)$/i.test(msg)) {
    if (session.lastTopic === 'parking')     return 'Glad I could help with parking 😊 Need anything else in Brela?';
    if (session.lastTopic === 'restaurants') return 'Enjoy your meal 😊 Let me know if you need more recommendations!';
    return 'Glad I could help 😊 If you need anything else in Brela, just let me know!';
  }

  // ── Priority 3: weather follow-up ────────────────────────────────────────
  // Keep event follow-ups deterministic and bypass generic intent detection.
  if (isEventFollowUp(msg, session)) {
    return TOPIC_HANDLERS.events.handle(msg, session, deps);
  }

  // ── Priority 4: weather follow-up ────────────────────────────────────────
  // Time-reference messages after a weather reply continue weather.
  // detectIntent() is NOT called here either.
  const weatherFollow = isWeatherFollowUp(msg, session) ? parseWeatherFollowUp(msg) : null;
  if (weatherFollow) {
    const synthMsg = (() => {
      if (weatherFollow.type === 'tomorrow') return 'tomorrow';
      if (weatherFollow.type === 'forecast') return `${weatherFollow.days} days`;
      if (weatherFollow.type === 'long') return '10 days';
      return msg;
    })();
    const reply = await TOPIC_HANDLERS.weather.handle(synthMsg, session, deps);
    session.lastTopic = null; // clear to avoid loops
    return reply;

  // ── Priority 5: short follow-up within lastTopic context ─────────────────
  // Short messages (≤ 2 words) with no clear topic keyword are treated as
  // follow-ups to the last resolved topic. "Local", "near beach", "ok",
  // "center" after a restaurant or parking reply all land here.
  } else if (session.lastTopic && TOPIC_HANDLERS[session.lastTopic] && msg.split(/\s+/).length <= 2 && !Object.values(TOPIC_PATTERNS).some(p => p.test(msg))) {
    activeTopic = session.lastTopic;

  // ── Priority 6: normal intent detection (no context at all) ──────────────
  } else {
    const { topic, confidence } = detectIntent(msg, session);
    activeTopic = confidence === 'high' ? topic : null;
  }

  const handler = TOPIC_HANDLERS[activeTopic];
  if (!handler) return null; // Unknown topic → fall through

  const reply = await handler.handle(msg, session, deps);

  // Safety net anti-loop: if handler ended up setting the same question again, break
  if (
    session.pendingSlot &&
    session.pendingSlot.question &&
    session.pendingSlot.question === session.lastQuestion &&
    session.pendingSlot.question === deps._prevLastQuestion
  ) {
    session.pendingSlot = null;
    session.lastQuestion = null;
    const BREAK = {
      hr: 'Nisam razumio. Što točno trebate — parking, vrijeme, događaje ili restorane?',
      en: "I didn't quite get that. What do you need — parking, weather, events, or restaurants?",
      de: 'Nicht verstanden. Was brauchen Sie — Parken, Wetter, Events oder Restaurants?',
      it: 'Non ho capito. Cosa serve — parcheggio, meteo, eventi o ristoranti?',
      fr: 'Je n\'ai pas compris. Que voulez-vous — parking, météo, événements ou restaurants ?',
      sv: 'Förstod inte. Vad behöver du — parkering, väder, evenemang eller restauranger?',
      no: 'Forstod ikke. Hva trenger du — parkering, vær, arrangementer eller restauranter?',
      cs: 'Nerozuměl jsem. Co potřebujete — parkování, počasí, akce nebo restaurace?',
    };
    return BREAK[lang] || BREAK.en;
  }

  return reply;
}

module.exports = { detectIntent, handleMessage, askSlot, TOPIC_HANDLERS };
