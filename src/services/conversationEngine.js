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
  events:      /\b(event|events|veranstaltung|veranstaltungen|evento|eventi|événement|événements|evenemang|arrangement|dogadjaj|dogadjaji|dogadaj|dogadanja|dogadanja|akce|události)\b/i,
  restaurants: /\b(restaurant|restoran|ristorante|food|dinner|lunch|eat|essen|mangiare|manger|konobi|konoba|hrana|večera|ručak|gastr|café|tavern)\b/i,
};

// Follow-up patterns — only active when we were already on that topic
const WEATHER_FOLLOWUP = /\b(tomorrow|sutra|morgen|demain|domani|today|danas|heute|oggi|forecast|prognoza|in\s+\d+\s+days?|za\s+\d+\s+dana|next\s+\d+\s+days?|sljedec|iduc)\b/i;
const EVENT_FOLLOWUP   = /\b(today|tonight|tomorrow|this\s+week|this\s+weekend|sutra|danas|večeras|veceras|tjedan|ovih\s+dana|ovaj\s+tjedan)\b/i;

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
      return ["tomorrow's forecast", '5-day forecast', 'is it a good day for the beach'];
    case 'events':
      return ["what's happening tonight", 'events this weekend', 'restaurants nearby'];
    case 'restaurants':
      return ['seafood', 'pizza / Italian', 'local Dalmatian cuisine', 'restaurants by the sea'];
    default:
      return [];
  }
}

function formatSuggestions(topic) {
  const items = getSuggestions(topic);
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
  const meaningful = tokens.filter(w => w.length > 2 && !NOISE.has(w));

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
  const { lang, brelaUrl, getFaqMatch } = deps;

  // 1. Try FAQ first for the full message (FAQ has priority)
  const faqHit = await getFaqMatch(userMsg).catch(() => null);
  if (faqHit?.matchType === 'strong' && faqHit.answer) {
    session.pendingSlot = null;
    session.lastQuestion = null;
    session.lastTopic = 'parking';
    const reply = faqHit.answer;
    return reply + formatSuggestions('parking');
  }

  // 2. Extract location from message
  const location = extractParkingLocation(userMsg);

  if (!location) {
    // Missing slot — ask for location once
    const PARKING_QUESTION = {
      hr: 'Gdje trebate parkirati?\n• centar\n• uz plažu\n• kod smještaja',
      en: 'Where do you need to park?\n• city center\n• near the beach\n• near accommodation',
      de: 'Wo möchten Sie parken?\n• Zentrum\n• Strand\n• Unterkunft',
      it: 'Dove vuole parcheggiare?\n• centro\n• spiaggia\n• alloggio',
      fr: 'Où souhaitez-vous garer ?\n• centre\n• plage\n• hébergement',
      sv: 'Var vill du parkera?\n• centrum\n• stranden\n• boende',
      no: 'Hvor vil du parkere?\n• sentrum\n• stranden\n• overnattingen',
      cs: 'Kde chcete parkovat?\n• centrum\n• pláž\n• ubytování',
    };
    const question = PARKING_QUESTION[lang] || PARKING_QUESTION.en;

    // Anti-loop: if we already asked this exact question, break and give general info
    if (session.lastQuestion === question) {
      session.pendingSlot = null;
      session.lastQuestion = null;
      session.lastTopic = 'parking';
      return PARKING_GENERAL[lang] || PARKING_GENERAL.en;
    }

    session.lastTopic = 'parking';
    return askSlot(session, { topic: 'parking', field: 'location', question });
  }

  // 3. We have a location — clear slot and answer
  session.pendingSlot = null;
  session.lastQuestion = null;
  session.lastTopic = 'parking';

  // Known location category → structured answer
  const knownAnswers = PARKING_ANSWERS[location];
  if (knownAnswers) {
    const base = knownAnswers[lang] || knownAnswers.en;
    return base + formatSuggestions('parking');
  }

  // Unknown specific location (e.g. "Vruja", "restaurant Feral") — honest, no loop
  const NO_EXACT_DATA = {
    hr: `Nemam točan parking za "${location}".\nJavni parking u Brelima:\n• centar (Trg A. Stepinca)\n• Punta Rata, Soline, Podrače\n\nViše: ${brelaUrl}`,
    en: `I don't have specific parking info for "${location}".\nPublic parking in Brela:\n• center (Trg A. Stepinca)\n• Punta Rata, Soline, Podrače\n\nMore: ${brelaUrl}`,
    de: `Keine genauen Daten für "${location}".\nÖffentliche Parkplätze in Brela:\n• Zentrum (Trg A. Stepinca)\n• Punta Rata, Soline, Podrače\n\nMehr: ${brelaUrl}`,
    it: `Non ho dati specifici per "${location}".\nParcheggi pubblici a Brela:\n• centro (Trg A. Stepinca)\n• Punta Rata, Soline, Podrače\n\nAltro: ${brelaUrl}`,
    fr: `Pas d'info précise pour « ${location} ».\nParkings à Brela :\n• centre (Trg A. Stepinca)\n• Punta Rata, Soline, Podrače\n\nPlus : ${brelaUrl}`,
    sv: `Ingen specifik info om "${location}".\nParkering i Brela:\n• centrum (Trg A. Stepinca)\n• Punta Rata, Soline, Podrače\n\nMer: ${brelaUrl}`,
    no: `Ingen spesifikk info om "${location}".\nParkering i Brela:\n• sentrum (Trg A. Stepinca)\n• Punta Rata, Soline, Podrače\n\nMer: ${brelaUrl}`,
    cs: `Nemám přesné informace pro "${location}".\nVerejná parkoviště v Brele:\n• centrum (Trg A. Stepinca)\n• Punta Rata, Soline, Podrače\n\nVíce: ${brelaUrl}`,
  };
  const reply = NO_EXACT_DATA[lang] || NO_EXACT_DATA.en;
  return reply + formatSuggestions('parking');
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
    return days > 5 ? 'long' : { type: 'forecast', days };
  }

  // plain number + days
  const numMatch = n.match(/\b(\d{1,2})\s+(?:days?|dana|tage|giorni|jours)\b/);
  if (numMatch) {
    const days = parseInt(numMatch[1], 10);
    return days > 5 ? 'long' : { type: 'forecast', days };
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
  if (subIntent === 'long') return LONG_RANGE[lang] || LONG_RANGE.en;

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
      return ans + formatSuggestions('weather');
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
    return ans + formatSuggestions('weather');

  } catch (err) {
    console.error('[engine/weather]', err.message);
    return UNAVAIL[lang] || UNAVAIL.en;
  }
}

// ─── EVENTS HANDLER ───────────────────────────────────────────────────────────

const EVENT_PERIOD_PATTERNS = {
  today:    /\b(today|tonight|danas|večeras|veceras|heute|oggi|aujourd'?hui)\b/i,
  tomorrow: /\b(tomorrow|sutra|morgen|domani|demain)\b/i,
  week:     /\b(this\s+week|this\s+weekend|ovaj\s+tjedan|ovih\s+dana|diese\s+woche|questa\s+settimana|cette\s+semaine)\b/i,
};

function detectEventPeriodLocal(message) {
  for (const [period, re] of Object.entries(EVENT_PERIOD_PATTERNS)) {
    if (re.test(message)) return period;
  }
  return null;
}

function formatEvents(events, period, lang) {
  const HDR = {
    hr: { today: 'Danas u Brelima:', tomorrow: 'Sutra u Brelima:', week: 'Ovaj tjedan u Brelima:', general: 'Nadolazeći događaji u Brelima:' },
    en: { today: 'Today in Brela:',  tomorrow: 'Tomorrow in Brela:', week: 'This week in Brela:', general: 'Upcoming events in Brela:' },
    de: { today: 'Heute in Brela:',  tomorrow: 'Morgen in Brela:',   week: 'Diese Woche in Brela:', general: 'Kommende Veranstaltungen in Brela:' },
    it: { today: 'Oggi a Brela:',    tomorrow: 'Domani a Brela:',    week: 'Questa settimana a Brela:', general: 'Prossimi eventi a Brela:' },
    fr: { today: "Aujourd'hui à Brela :", tomorrow: 'Demain à Brela :', week: 'Cette semaine à Brela :', general: 'Événements à venir à Brela :' },
    sv: { today: 'Idag i Brela:',    tomorrow: 'Imorgon i Brela:',   week: 'Denna vecka i Brela:', general: 'Kommande evenemang i Brela:' },
    no: { today: 'I dag i Brela:',   tomorrow: 'I morgen i Brela:',  week: 'Denne uken i Brela:', general: 'Kommende arrangementer i Brela:' },
    cs: { today: 'Dnes v Brele:',    tomorrow: 'Zítra v Brele:',     week: 'Tento týden v Brele:', general: 'Nadcházející akce v Brele:' },
  };
  const labels = HDR[lang] || HDR.en;
  const header = labels[period || 'general'];
  const lines  = events.map((ev, i) => {
    const d    = ev.date instanceof Date ? ev.date : new Date(ev.date);
    const date = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
    let line   = `\n${i + 1}. ${ev.title} (${date})`;
    if (ev.description)   line += `\n   ${ev.description}`;
    if (ev.location_link) line += `\n   📍 ${ev.location_link}`;
    return line;
  });
  return header + lines.join('');
}

async function handleEvents(userMsg, session, deps) {
  const { lang, tenantId, getEventsByPeriod, getUpcomingEvents, brelaUrl } = deps;

  session.pendingSlot = null;
  session.lastQuestion = null;
  session.lastTopic = 'events';

  const NO_EVENTS = {
    hr: `Trenutno nema najavljenih događaja u Brelima.\nZa više informacija: ${brelaUrl}`,
    en: `No upcoming events in Brela at the moment.\nFor more information: ${brelaUrl}`,
    de: `Derzeit keine Veranstaltungen in Brela.\nMehr Infos: ${brelaUrl}`,
    it: `Nessun evento in programma al momento a Brela.\nPer maggiori informazioni: ${brelaUrl}`,
    fr: `Pas d'événements à Brela pour l'instant.\nPlus d'informations : ${brelaUrl}`,
    sv: `Inga aktuella evenemang i Brela.\nMer info: ${brelaUrl}`,
    no: `Ingen aktuelle arrangementer i Brela.\nMer info: ${brelaUrl}`,
    cs: `Momentálně žádné akce v Brele.\nVíce informací: ${brelaUrl}`,
  };

  // Upcoming-as-fallback intro (when period-specific query finds nothing)
  const PERIOD_EMPTY_UPCOMING = {
    hr: { today: 'Danas nema događaja, ali uskoro:', tomorrow: 'Sutra nema događaja, ali uskoro:', week: 'Ovaj tjedan nema događaja, ali uskoro:' },
    en: { today: 'No events today, but coming up:',  tomorrow: 'No events tomorrow, but coming up:', week: 'No events this week, but coming up:' },
    de: { today: 'Heute keine Events, aber bald:',   tomorrow: 'Morgen keine Events, aber bald:',    week: 'Diese Woche keine Events, aber bald:' },
    it: { today: 'Oggi nessun evento, ma presto:',   tomorrow: 'Domani nessun evento, ma presto:',   week: 'Questa settimana nessun evento, ma presto:' },
    fr: { today: "Pas d'événements aujourd'hui, mais bientôt :", tomorrow: "Pas d'événements demain, mais bientôt :", week: "Pas d'événements cette semaine, mais bientôt :" },
    sv: { today: 'Inga evenemang idag, men snart:',  tomorrow: 'Inga evenemang imorgon, men snart:',  week: 'Inga evenemang denna vecka, men snart:' },
    no: { today: 'Ingen arrangementer i dag, men snart:', tomorrow: 'Ingen arrangementer i morgen, men snart:', week: 'Ingen arrangementer denne uken, men snart:' },
    cs: { today: 'Dnes žádné akce, ale brzy:',       tomorrow: 'Zítra žádné akce, ale brzy:',        week: 'Tento týden žádné akce, ale brzy:' },
  };

  try {
    const period = detectEventPeriodLocal(userMsg);

    if (period) {
      const events = await getEventsByPeriod(tenantId, period);
      if (events.length) return formatEvents(events, period, lang) + formatSuggestions('events');

      // Period empty → show upcoming as fallback
      const upcoming = await getUpcomingEvents(tenantId);
      if (upcoming.length) {
        const intros = PERIOD_EMPTY_UPCOMING[lang] || PERIOD_EMPTY_UPCOMING.en;
        return (intros[period] || intros.today) + '\n' + formatEvents(upcoming, null, lang) + formatSuggestions('events');
      }
      return NO_EVENTS[lang] || NO_EVENTS.en;
    }

    // General "what events?" query
    const events = await getUpcomingEvents(tenantId);
    if (!events.length) return NO_EVENTS[lang] || NO_EVENTS.en;
    return formatEvents(events, null, lang) + formatSuggestions('events');

  } catch (err) {
    console.error('[engine/events]', err.message);
    return NO_EVENTS[lang] || NO_EVENTS.en;
  }
}

// ─── RESTAURANTS HANDLER ──────────────────────────────────────────────────────

async function handleRestaurants(userMsg, session, deps) {
  const { lang, restaurantUrl } = deps;

  session.pendingSlot = null;
  session.lastQuestion = null;
  session.lastTopic = 'restaurants';

  const MSG = {
    hr: `Za restorane i konobe u Brelima:\n${restaurantUrl}\n\nMogu suziti pretragu po:\n• ribe / seafood\n• pizza\n• domaća kuhinja\n• restorani uz more`,
    en: `For restaurants in Brela:\n${restaurantUrl}\n\nI can help narrow it down by:\n• seafood\n• pizza / Italian\n• local Dalmatian cuisine\n• restaurants by the sea`,
    de: `Restaurants in Brela:\n${restaurantUrl}\n\nIch helfe nach:\n• Meeresfrüchte\n• Pizza / Italienisch\n• Lokale Küche\n• Am Meer`,
    it: `Ristoranti a Brela:\n${restaurantUrl}\n\nPosso filtrare per:\n• frutti di mare\n• pizza / cucina italiana\n• cucina locale\n• sul mare`,
    fr: `Restaurants à Brela :\n${restaurantUrl}\n\nJe peux filtrer par :\n• fruits de mer\n• pizza / cuisine italienne\n• cuisine locale\n• en bord de mer`,
    sv: `Restauranger i Brela:\n${restaurantUrl}\n\nJag kan hjälpa med:\n• skaldjur\n• pizza / italienskt\n• lokal mat\n• vid havet`,
    no: `Restauranter i Brela:\n${restaurantUrl}\n\nJeg kan hjelpe med:\n• sjømat\n• pizza / italiensk\n• lokal mat\n• ved havet`,
    cs: `Restaurace v Brele:\n${restaurantUrl}\n\nMohu pomoci s:\n• mořské plody\n• pizza / italská kuchyně\n• místní kuchyně\n• u moře`,
  };
  const ans = MSG[lang] || MSG.en;
  return ans + formatSuggestions('restaurants');
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
  if (session.lastTopic !== 'weather') return false;
  return /\b(tomorrow|today|sutra|danas|morgen|demain|domani|in\s+\d+\s+days?|za\s+\d+\s+dana|next\s+\d+\s+days?)\b/i.test(message);
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

  let activeTopic;

  // ── Priority 1: pendingSlot ───────────────────────────────────────────────
  // pendingSlot always wins. No intent detection, no fallback.
  if (session.pendingSlot) {
    return TOPIC_HANDLERS[session.pendingSlot.topic].handle(msg, session, deps);

  // ── Priority 2: trivial acknowledgements ─────────────────────────────────
  // "ok", "thanks", "hvala", 👍 — send a friendly closer, preserve session.
  } else if (!session.pendingSlot && /^(ok|okay|thanks|thank you|hvala|👍|thx|cheers|gracias|merci|danke|grazie|tack|takk|dekuji)$/i.test(msg)) {
    if (session.lastTopic === 'parking')     return 'Glad I could help with parking 😊 Need anything else in Brela?';
    if (session.lastTopic === 'restaurants') return 'Enjoy your meal 😊 Let me know if you need more recommendations!';
    return 'Glad I could help 😊 If you need anything else in Brela, just let me know!';

  // ── Priority 4: weather follow-up ────────────────────────────────────────
  // Time-reference messages after a weather reply continue weather.
  // detectIntent() is NOT called here either.
  } else if (isWeatherFollowUp(msg, session)) {
    activeTopic = 'weather';

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
