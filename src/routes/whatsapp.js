const express = require('express');
const router = express.Router();
const { getTenant, getMessages, saveMessages } = require('../db/sessions');
const { parseMessage } = require('../services/openai');
const { logMessage, getFaqMatch, getUpcomingEvents, getEventsByPeriod, checkAndIncrementUsage, upsertWhatsappUser, getWhatsappUser, setOptIn, detectLang } = require('../db/bot');

/**
 * Returns true when the message is plausibly tourism/destination-related.
 * Runs BEFORE any DB or AI work — pure in-memory check.
 * Blocks spam, math expressions, and completely off-topic messages.
 */
function isRelevantQuestion(message) {
  const lower = message.toLowerCase().trim();

  // Opt-in confirmations always pass (they answer a bot-initiated yes/no)
  if (lower === 'da' || lower === 'ne') return true;

  // Block math expressions (e.g. "2+2", "100/4", "x=5")
  if (/\d\s*[+\-*/=]\s*\d/.test(lower)) return false;

  // Block gibberish: longer than 4 chars with no vowels at all
  const lettersOnly = lower.replace(/[^a-zčćšžđ]/g, '');
  if (lettersOnly.length > 4 && !/[aeiouaeiou]/.test(lettersOnly)) return false;

  // Tourism keywords, question words, greetings — any match is enough
  const RELEVANT_KEYWORDS = [
    // Destination
    'brela', 'brelu', 'brelima',
    // Beach / sea
    'beach', 'plaža', 'plaži', 'plažu', 'more', 'sea', 'swim', 'kupanje',
    // Food / drink
    'restoran', 'restaurant', 'food', 'jelo', 'hrana', 'kava', 'coffee', 'bar', 'cafe',
    // Getting around
    'parking', 'prijevoz', 'bus', 'taxi', 'rent', 'najam', 'bicikl', 'bike',
    // Accommodation
    'hotel', 'apartman', 'smještaj', 'accommodation',
    // Activities / events
    'aktivnost', 'activities', 'event', 'događaj', 'izlet', 'excursion', 'tour',
    // Practical
    'atm', 'bankomat', 'wifi', 'ljekarna', 'pharmacy', 'doktor', 'doctor',
    // Weather
    'weather', 'vrijeme', 'prognoza', 'forecast', 'temperatura', 'temperature',
    // Question words (multilingual)
    'gdje', 'what', 'where', 'how', 'when', 'kada', 'koliko', 'ima',
    'wie', 'wo', 'wann', 'dove', 'quando', 'où', 'quand', 'comment',
    // Greetings (so bot can introduce itself)
    'hello', 'hi', 'hey', 'bok', 'hej', 'zdravo', 'hallo', 'ciao', 'bonjour',
    'dobar', 'dobro', 'salut',
  ];

  return RELEVANT_KEYWORDS.some(kw => lower.includes(kw));
}

const NOT_RELEVANT_MSG = {
  hr: 'Nisam siguran da sam razumio pitanje. Možeš pitati o plažama, parkingu, restoranima ili aktivnostima u Brelima 😊',
  en: "I'm not sure I understood. You can ask about beaches, parking, restaurants, or activities in Brela 😊",
  de: 'Ich bin nicht sicher, ob ich die Frage verstanden habe. Sie können nach Stränden, Parken, Restaurants oder Aktivitäten in Brela fragen 😊',
  it: 'Non sono sicuro di aver capito. Puoi chiedere di spiagge, parcheggi, ristoranti o attività a Brela 😊',
  fr: "Je ne suis pas sûr d'avoir compris. Vous pouvez demander des informations sur les plages, le parking, les restaurants ou les activités à Brela 😊",
  sv: 'Jag är inte säker på att jag förstod frågan. Du kan fråga om stränder, parkering, restauranger eller aktiviteter i Brela 😊',
  no: 'Jeg er ikke sikker på at jeg forstod spørsmålet. Du kan spørre om strender, parkering, restauranter eller aktiviteter i Brela 😊',
  cs: 'Nejsem si jistý, že jsem otázce rozuměl. Můžete se ptát na pláže, parkování, restaurace nebo aktivity v Brele 😊',
};
function notRelevantReply(lang) {
  return NOT_RELEVANT_MSG[lang] || NOT_RELEVANT_MSG.hr;
}

// Pure acknowledgements that need no reply
const TRIVIAL = new Set([
  'ok', 'okay', 'k', 'yes', 'no', 'yep', 'nope', 'thanks', 'thx', 'ty', 'np',
  'da', 'ne', 'hvala',
  'nein', 'danke',
  'si', 'grazie',
  'non', 'merci',
]);

// Greetings — handled with a fixed intro reply, no AI call needed
const GREETING_WORDS = [
  'hello', 'hi', 'hey', 'bok', 'hej', 'zdravo', 'hallo', 'ciao',
  'bonjour', 'salut', 'dobar dan', 'guten tag', 'buongiorno', 'buenas',
];
function isGreeting(msg) {
  const lower = msg.toLowerCase().trim();
  return GREETING_WORDS.some(w => lower === w || lower.startsWith(w + ' ') || lower.startsWith(w + '!') || lower.startsWith(w + ','));
}
const GREETING_MSG = {
  hr: 'Bok! 👋 Ja sam turistički asistent. Mogu ti pomoći s informacijama o plažama, parkingu, restoranima i aktivnostima. Kako mogu pomoći?',
  en: "Hello! 👋 I'm your tourist assistant. I can help you with beaches, parking, restaurants, and activities. How can I help?",
  de: 'Hallo! 👋 Ich bin Ihr Touristenassistent. Ich kann Ihnen bei Stränden, Parken, Restaurants und Aktivitäten helfen. Wie kann ich helfen?',
  it: 'Ciao! 👋 Sono il vostro assistente turistico. Posso aiutarvi con spiagge, parcheggi, ristoranti e attività. Come posso aiutare?',
  fr: 'Bonjour! 👋 Je suis votre assistant touristique. Je peux vous aider avec les plages, le stationnement, les restaurants et les activités. Comment puis-je aider?',
  sv: 'Hej! 👋 Jag är din turistassistent. Jag kan hjälpa dig med stränder, parkering, restauranger och aktiviteter. Hur kan jag hjälpa?',
  no: 'Hei! 👋 Jeg er din turistassistent. Jeg kan hjelpe deg med strender, parkering, restauranter og aktiviteter. Hvordan kan jeg hjelpe?',
  cs: 'Ahoj! 👋 Jsem váš turistický asistent. Mohu vám pomoci s plážemi, parkováním, restauracemi a aktivitami. Jak mohu pomoci?',
};
function greetingReply(lang) {
  return GREETING_MSG[lang] || GREETING_MSG.hr;
}

const FALLBACK_MSG = {
  hr: 'Nisam siguran da sam razumio. Pokušaj pitati na drugi način 😊',
  en: "I'm not sure I understood. Try asking differently 😊",
  de: 'Ich bin nicht sicher, ob ich verstanden habe. Versuche es anders zu fragen 😊',
  it: 'Non sono sicuro di aver capito. Prova a chiedere in modo diverso 😊',
  fr: "Je ne suis pas sûr d'avoir compris. Essaie de reformuler ta question 😊",
  sv: 'Jag är inte säker på att jag förstod. Försök fråga på ett annat sätt 😊',
  no: 'Jeg er ikke sikker på at jeg forstod. Prøv å spørre på en annen måte 😊',
  cs: 'Nejsem si jistý, že jsem rozuměl. Zkuste se zeptat jinak 😊',
};
function fallbackReply(lang) {
  return FALLBACK_MSG[lang] || FALLBACK_MSG.hr;
}

const OPT_IN_CONFIRM = {
  hr: 'Super! Obavijestit ćemo te o događajima 🎉',
  en: 'Great! We\'ll notify you about events 🎉',
  de: 'Super! Wir werden Sie über Veranstaltungen informieren 🎉',
  it: 'Ottimo! Ti informeremo sugli eventi 🎉',
  fr: 'Super! Nous vous informerons des événements 🎉',
  sv: 'Bra! Vi meddelar dig om evenemang 🎉',
  no: 'Flott! Vi varsler deg om arrangementer 🎉',
  cs: 'Skvěle! Budeme vás informovat o akcích 🎉',
};
const OPT_OUT_CONFIRM = {
  hr: 'U redu, nećeš dobivati obavijesti. Uvijek možeš pitati za pomoć! 😊',
  en: 'Alright, you won\'t receive notifications. You can always ask for help! 😊',
  de: 'In Ordnung, keine Benachrichtigungen. Du kannst jederzeit um Hilfe bitten! 😊',
  it: 'Va bene, nessuna notifica. Puoi sempre chiedere aiuto! 😊',
  fr: 'D\'accord, pas de notifications. Vous pouvez toujours demander de l\'aide! 😊',
  sv: 'Okej, inga aviseringar. Du kan alltid be om hjälp! 😊',
  no: 'Greit, ingen varsler. Du kan alltid be om hjelp! 😊',
  cs: 'Dobře, žádná oznámení. Vždy můžete požádat o pomoc! 😊',
};

// Language-aware labels and empty-state messages for time-specific event queries
const EVENT_LABELS = {
  hr: {
    today:    '📅 Događaji za danas:',
    tomorrow: '📅 Događaji za sutra:',
    week:     '📅 Događaji ovaj tjedan:',
    empty: {
      today:    'Danas nema organiziranih događaja, ali evo par ideja:\n• Prošetajte starim gradom\n• Posjetite jednu od plaža\n• Isprobajte lokalne restorane 😊',
      tomorrow: 'Sutra nema organiziranih događaja, ali evo par ideja:\n• Prošetajte starim gradom\n• Posjetite jednu od plaža\n• Isprobajte lokalne restorane 😊',
      week:     'Ovaj tjedan nema organiziranih događaja, ali evo par ideja:\n• Prošetajte starim gradom\n• Posjetite jednu od plaža\n• Isprobajte lokalne restorane 😊',
    },
  },
  en: {
    today:    '📅 Events today:',
    tomorrow: '📅 Events tomorrow:',
    week:     '📅 Events this week:',
    empty: {
      today:    'No official events today, but here are some ideas:\n• Explore the old town and historic sites\n• Relax at one of the beautiful beaches\n• Discover local restaurants and cuisine 😊',
      tomorrow: 'No official events tomorrow, but here are some ideas:\n• Explore the old town and historic sites\n• Relax at one of the beautiful beaches\n• Discover local restaurants and cuisine 😊',
      week:     'No official events this week, but here are some ideas:\n• Explore the old town and historic sites\n• Relax at one of the beautiful beaches\n• Discover local restaurants and cuisine 😊',
    },
  },
  de: {
    today:    '📅 Veranstaltungen heute:',
    tomorrow: '📅 Veranstaltungen morgen:',
    week:     '📅 Veranstaltungen diese Woche:',
    empty: {
      today:    'Heute keine Veranstaltungen, aber hier ein paar Ideen:\n• Erkunden Sie die Altstadt und historische Stätten\n• Entspannen Sie an einem der schönen Strände\n• Entdecken Sie lokale Restaurants und die Küche 😊',
      tomorrow: 'Morgen keine Veranstaltungen, aber hier ein paar Ideen:\n• Erkunden Sie die Altstadt und historische Stätten\n• Entspannen Sie an einem der schönen Strände\n• Entdecken Sie lokale Restaurants und die Küche 😊',
      week:     'Diese Woche keine Veranstaltungen, aber hier ein paar Ideen:\n• Erkunden Sie die Altstadt und historische Stätten\n• Entspannen Sie an einem der schönen Strände\n• Entdecken Sie lokale Restaurants und die Küche 😊',
    },
  },
  it: {
    today:    '📅 Eventi oggi:',
    tomorrow: '📅 Eventi domani:',
    week:     '📅 Eventi questa settimana:',
    empty: {
      today:    'Oggi nessun evento in programma, ma ecco alcune idee:\n• Esplora il centro storico e i luoghi d\'interesse\n• Rilassati su una delle splendide spiagge\n• Scopri i ristoranti locali e la cucina tipica 😊',
      tomorrow: 'Domani nessun evento in programma, ma ecco alcune idee:\n• Esplora il centro storico e i luoghi d\'interesse\n• Rilassati su una delle splendide spiagge\n• Scopri i ristoranti locali e la cucina tipica 😊',
      week:     'Questa settimana nessun evento, ma ecco alcune idee:\n• Esplora il centro storico e i luoghi d\'interesse\n• Rilassati su una delle splendide spiagge\n• Scopri i ristoranti locali e la cucina tipica 😊',
    },
  },
  fr: {
    today:    "📅 Événements aujourd'hui:",
    tomorrow: '📅 Événements demain:',
    week:     '📅 Événements cette semaine:',
    empty: {
      today:    "Aucun événement officiel aujourd'hui, mais voici quelques idées:\n• Explorez la vieille ville et les sites historiques\n• Détendez-vous sur l'une des belles plages\n• Découvrez les restaurants locaux et la cuisine 😊",
      tomorrow: "Aucun événement officiel demain, mais voici quelques idées:\n• Explorez la vieille ville et les sites historiques\n• Détendez-vous sur l'une des belles plages\n• Découvrez les restaurants locaux et la cuisine 😊",
      week:     "Aucun événement officiel cette semaine, mais voici quelques idées:\n• Explorez la vieille ville et les sites historiques\n• Détendez-vous sur l'une des belles plages\n• Découvrez les restaurants locaux et la cuisine 😊",
    },
  },
  sv: {
    today:    '📅 Evenemang idag:',
    tomorrow: '📅 Evenemang imorgon:',
    week:     '📅 Evenemang denna vecka:',
    empty: {
      today:    'Inga evenemang idag, men här är några idéer:\n• Utforska gamla stan och historiska platser\n• Koppla av på en av de vackra stränderna\n• Upptäck lokala restauranger och köket 😊',
      tomorrow: 'Inga evenemang imorgon, men här är några idéer:\n• Utforska gamla stan och historiska platser\n• Koppla av på en av de vackra stränderna\n• Upptäck lokala restauranger och köket 😊',
      week:     'Inga evenemang denna vecka, men här är några idéer:\n• Utforska gamla stan och historiska platser\n• Koppla av på en av de vackra stränderna\n• Upptäck lokala restauranger och köket 😊',
    },
  },
  no: {
    today:    '📅 Arrangementer i dag:',
    tomorrow: '📅 Arrangementer i morgen:',
    week:     '📅 Arrangementer denne uken:',
    empty: {
      today:    'Ingen arrangementer i dag, men her er noen forslag:\n• Utforsk gamlebyen og historiske steder\n• Slapp av på en av de vakre strendene\n• Oppdag lokale restauranter og kjøkkenet 😊',
      tomorrow: 'Ingen arrangementer i morgen, men her er noen forslag:\n• Utforsk gamlebyen og historiske steder\n• Slapp av på en av de vakre strendene\n• Oppdag lokale restauranter og kjøkkenet 😊',
      week:     'Ingen arrangementer denne uken, men her er noen forslag:\n• Utforsk gamlebyen og historiske steder\n• Slapp av på en av de vakre strendene\n• Oppdag lokale restauranter og kjøkkenet 😊',
    },
  },
  cs: {
    today:    '📅 Akce dnes:',
    tomorrow: '📅 Akce zítra:',
    week:     '📅 Akce tento týden:',
    empty: {
      today:    'Dnes žádné akce, ale zde je pár tipů:\n• Prozkoumejte staré město a historická místa\n• Odpočiňte si na jedné z krásných pláží\n• Objevte místní restaurace a kuchyni 😊',
      tomorrow: 'Zítra žádné akce, ale zde je pár tipů:\n• Prozkoumejte staré město a historická místa\n• Odpočiňte si na jedné z krásných pláží\n• Objevte místní restaurace a kuchyni 😊',
      week:     'Tento týden žádné akce, ale zde je pár tipů:\n• Prozkoumejte staré město a historická místa\n• Odpočiňte si na jedné z krásných pláží\n• Objevte místní restaurace a kuchyni 😊',
    },
  },
};

function formatEventsList(events, period, lang) {
  const labels = EVENT_LABELS[lang] || EVENT_LABELS.en;
  if (!events.length) {
    return labels.empty[period] || labels.empty.today;
  }
  const header = labels[period] || labels.today;
  const lines = events.map((ev, i) => {
    const d = ev.date instanceof Date ? ev.date : new Date(ev.date);
    const dateStr = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
    let line = `\n\n${i + 1}. ${ev.title} (${dateStr})`;
    if (ev.description) line += `\n   ${ev.description}`;
    if (ev.location_link) line += `\n   📍 ${ev.location_link}`;
    return line;
  });
  return header + lines.join('');
}

// Language-aware templates used instead of extra AI calls
const WEATHER_UNAVAILABLE = {
  hr: '🌤️ Podaci o vremenu trenutno nisu dostupni.',
  en: '🌤️ Weather data is temporarily unavailable.',
  de: '🌤️ Wetterdaten sind derzeit nicht verfügbar.',
  it: '🌤️ Dati meteo non disponibili al momento.',
  fr: '🌤️ Données météo temporairement indisponibles.',
};
const FORECAST_UNAVAILABLE = {
  hr: '🌤️ Prognoza trenutno nije dostupna.',
  en: '🌤️ Forecast is temporarily unavailable.',
  de: '🌤️ Wettervorhersage derzeit nicht verfügbar.',
  it: '🌤️ Previsioni non disponibili al momento.',
  fr: '🌤️ Prévisions temporairement indisponibles.',
};
const FORECAST_LONG_RANGE_URL = 'https://weather.com/hr-HR/vrijeme/10dana/l/Brela+Splitsko+dalmatinska+%C5%BEupanija';
const FORECAST_LONG_RANGE = {
  hr: `Za detaljnu 10-dnevnu prognozu:\n${FORECAST_LONG_RANGE_URL}`,
  en: `For a detailed 10-day forecast:\n${FORECAST_LONG_RANGE_URL}`,
  de: `Für die 10-Tage-Vorhersage:\n${FORECAST_LONG_RANGE_URL}`,
  it: `Per le previsioni a 10 giorni:\n${FORECAST_LONG_RANGE_URL}`,
  fr: `Pour les prévisions à 10 jours:\n${FORECAST_LONG_RANGE_URL}`,
};
const NO_EVENTS = {
  hr: 'Trenutno nema nadolazećih događaja, ali evo par ideja:\n• Prošetajte starim gradom\n• Posjetite jednu od plaža\n• Isprobajte lokalne restorane 😊',
  en: 'No upcoming events at the moment, but here are some ideas:\n• Explore the old town and historic sites\n• Relax at one of the beautiful beaches\n• Discover local restaurants and cuisine 😊',
  de: 'Aktuell keine Veranstaltungen, aber hier ein paar Ideen:\n• Erkunden Sie die Altstadt und historische Stätten\n• Entspannen Sie an einem der schönen Strände\n• Entdecken Sie lokale Restaurants und die Küche 😊',
  it: 'Nessun evento in programma, ma ecco alcune idee:\n• Esplora il centro storico e i luoghi d\'interesse\n• Rilassati su una delle splendide spiagge\n• Scopri i ristoranti locali e la cucina tipica 😊',
  fr: "Aucun événement à venir, mais voici quelques idées:\n• Explorez la vieille ville et les sites historiques\n• Détendez-vous sur l'une des belles plages\n• Découvrez les restaurants locaux et la cuisine 😊",
  sv: 'Inga kommande evenemang, men här är några idéer:\n• Utforska gamla stan och historiska platser\n• Koppla av på en av de vackra stränderna\n• Upptäck lokala restauranger och köket 😊',
  no: 'Ingen kommende arrangementer, men her er noen forslag:\n• Utforsk gamlebyen og historiske steder\n• Slapp av på en av de vakre strendene\n• Oppdag lokale restauranter og kjøkkenet 😊',
  cs: 'Žádné nadcházející akce, ale zde je pár tipů:\n• Prozkoumejte staré město a historická místa\n• Odpočiňte si na jedné z krásných pláží\n• Objevte místní restaurace a kuchyni 😊',
};
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function twiml(message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`;
}

/**
 * TwiML response that appends a link card after the main message.
 * If imageUrl is provided, sends a second WhatsApp message containing the image
 * (displayed as a card in the chat) with title + URL as caption.
 * If only linkUrl (no image), appends the link inline to the main message.
 */
function twimlWithFaqLink(text, linkTitle, linkUrl, imageUrl) {
  if (imageUrl && linkUrl) {
    const caption = (linkTitle ? linkTitle + '\n' : '') + linkUrl;
    return `<?xml version="1.0" encoding="UTF-8"?><Response>` +
      `<Message>${escapeXml(text)}</Message>` +
      `<Message><Body>${escapeXml(caption)}</Body><Media>${escapeXml(imageUrl)}</Media></Message>` +
      `</Response>`;
  }
  if (linkUrl) {
    const appended = text + '\n\n' + (linkTitle ? '🔗 ' + linkTitle + '\n' : '') + linkUrl;
    return twiml(appended);
  }
  return twiml(text);
}

function emptyTwiml() {
  return '<?xml version="1.0" encoding="UTF-8\"?><Response></Response>';
}

router.post('/webhook', async (req, res) => {
  console.log('WEBHOOK HIT');
  console.log('[webhook] incoming body:', JSON.stringify(req.body));
  res.type('text/xml');

  try {
    // 1. Extract + validate — the only exits that don't require a reply
    const { From: userPhone, To: tenantPhone, Body: userMsg } = req.body || {};
    console.log(`[webhook] From=${userPhone} To=${tenantPhone} Body="${userMsg}"`);

    if (!userMsg?.trim() || !userPhone || !tenantPhone) {
      console.warn('[webhook] missing required fields');
      return res.send(emptyTwiml());
    }

    const trimmedMsg = userMsg.trim();
    const lowerMsg   = trimmedMsg.toLowerCase();

    // 2. Resolve tenant
    const tenant = await getTenant(tenantPhone);
    if (!tenant) {
      console.warn(`[webhook] no tenant for number: ${tenantPhone}`);
      return res.send(emptyTwiml());
    }
    console.log(`[webhook] tenant: ${tenant.name}`);

    // 3. Upsert user — ensure record exists before any per-user checks
    try { await upsertWhatsappUser(tenant.id, userPhone); } catch (_) {}

    // 3.5. Fetch current user state (opt-in state)
    let currentUser = null;
    try {
      currentUser = await getWhatsappUser(tenant.id, userPhone);
    } catch (userErr) {
      console.error("[webhook] getWhatsappUser failed:", userErr.message);
    }

    // 4. Opt-in consent (da/ne in response to notification offer)
    if ((lowerMsg === 'da' || lowerMsg === 'ne') && currentUser && currentUser.asked_opt_in) {
      const optIn = lowerMsg === 'da' ? 1 : 0;
      const msgLang = detectLang(trimmedMsg);
      try {
        await setOptIn(tenant.id, userPhone, optIn);
        await logMessage(tenant.id, userPhone, trimmedMsg, 'ai', msgLang);
      } catch (optErr) {
        console.error('[webhook] opt-in error:', optErr.message);
      }
      const reply = optIn ? (OPT_IN_CONFIRM[msgLang] || OPT_IN_CONFIRM.hr) : (OPT_OUT_CONFIRM[msgLang] || OPT_OUT_CONFIRM.hr);
      console.log('[webhook] FINAL RESPONSE SENT — opt-in');
      return res.send(twiml(reply));
    }

    // 5. Greeting — fast reply without AI
    if (isGreeting(trimmedMsg)) {
      const msgLang = detectLang(trimmedMsg);
      try { await logMessage(tenant.id, userPhone, trimmedMsg, 'ai', msgLang); } catch (_) {}
      console.log(`[webhook] FINAL RESPONSE SENT — greeting (${msgLang})`);
      return res.send(twiml(greetingReply(msgLang)));
    }

    // 6. Trivial acknowledgements — no reply needed
    if (trimmedMsg.length < 2 || TRIVIAL.has(lowerMsg)) {
      console.log(`[webhook] FINAL RESPONSE SENT — trivial (empty)`);
      return res.send(emptyTwiml());
    }

    // 7. RELEVANCE GATE — blocks spam/nonsense before FAQ, AI, or events logic
    if (!isRelevantQuestion(trimmedMsg)) {
      const gateLang = detectLang(trimmedMsg);
      console.log(`[webhook] BLOCKED — irrelevant message: "${trimmedMsg.slice(0, 60)}"`);
      return res.send(twiml(notRelevantReply(gateLang)));
    }

    const model = tenant.openai_model;

    // Load conversation history — empty array on first interaction
    const history = await getMessages(tenant.id, userPhone).catch(() => []);
    console.log(`[webhook] history length: ${history.length}`);

    // Pre-fetch FAQ + upcoming events in parallel (cheap DB reads)
    const [faqMatch, upcomingEvents] = await Promise.all([
      getFaqMatch(tenant.id, trimmedMsg).catch(() => null),
      getUpcomingEvents(tenant.id).catch(() => []),
    ]);

    // Build context for AI — FAQ answer (any match) and upcoming events
    const faqContext   = faqMatch ? faqMatch.answer : null;
    const eventContext = upcomingEvents.length
      ? upcomingEvents.map(ev => {
          const dateStr = new Date(ev.date).toISOString().slice(0, 10);
          let line = `${ev.title} (${dateStr})`;
          if (ev.description) line += `: ${ev.description}`;
          return line;
        }).join('\n')
      : null;

    console.log("USER MESSAGE:", trimmedMsg);
    const { lang, intent, response: aiResponse } = await parseMessage(
      trimmedMsg, tenant.system_prompt, model, history, { faqContext, eventContext }
    );
    console.log("AI RESPONSE:", aiResponse);
    console.log(`[webhook] intent=${intent} lang=${lang}`);

    // 11. Weather — real-time data from OpenWeather API
    if (intent === 'weather_current' || intent === 'weather_tomorrow' || intent === 'weather_multi') {
      await logMessage(tenant.id, userPhone, trimmedMsg, 'weather', lang);

      const apiKey = process.env.OPENWEATHER_API_KEY;
      const city   = tenant.city || 'Brela';
      const owLang = ['hr','en','de','it','fr'].includes(lang) ? lang : 'en';

      if (!apiKey) {
        console.log('[webhook] FINAL RESPONSE SENT — weather (no API key)');
        return res.send(twiml(WEATHER_UNAVAILABLE[lang] || WEATHER_UNAVAILABLE.en));
      }

      try {
        if (intent === 'weather_multi') {
          const daysMatch = trimmedMsg.match(/\d+/);
          const requestedDays = daysMatch ? Math.min(parseInt(daysMatch[0], 10), 5) : 3;

          if (daysMatch && parseInt(daysMatch[0], 10) > 5) {
            console.log('[webhook] FINAL RESPONSE SENT — weather long-range link');
            return res.send(twiml(FORECAST_LONG_RANGE[lang] || FORECAST_LONG_RANGE.en));
          }

          const url = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric&lang=${owLang}`;
          const forecastRes = await fetch(url);
          const data = await forecastRes.json();

          if (!forecastRes.ok) {
            console.log('[webhook] FINAL RESPONSE SENT — forecast unavailable');
            return res.send(twiml(FORECAST_UNAVAILABLE[lang] || FORECAST_UNAVAILABLE.en));
          }

          const days = [];
          for (let i = 1; i <= requestedDays; i++) {
            const d = new Date();
            d.setDate(d.getDate() + i);
            const dateStr = d.toISOString().slice(0, 10);
            const entry = data.list.find(e => e.dt_txt.startsWith(dateStr) && e.dt_txt.includes('12:00'))
                       || data.list.find(e => e.dt_txt.startsWith(dateStr));
            if (entry) {
              const temp = Math.round(entry.main.temp);
              const desc = entry.weather[0]?.description || '';
              days.push(`${dateStr}: ${temp}°C, ${desc}`);
            }
          }

          if (!days.length) {
            console.log('[webhook] FINAL RESPONSE SENT — forecast unavailable (no data)');
            return res.send(twiml(FORECAST_UNAVAILABLE[lang] || FORECAST_UNAVAILABLE.en));
          }

          const label = { hr: 'Prognoza', en: 'Forecast', de: 'Vorhersage', it: 'Previsioni', fr: 'Prévisions' }[lang] || 'Forecast';
          console.log('[webhook] FINAL RESPONSE SENT — weather multi-day');
          return res.send(twiml(`🌤️ ${city} — ${label}:\n${days.join('\n')}`));

        } else if (intent === 'weather_tomorrow') {
          const url = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric&lang=${owLang}`;
          const forecastRes = await fetch(url);
          const data = await forecastRes.json();

          if (!forecastRes.ok) {
            console.log('[webhook] FINAL RESPONSE SENT — tomorrow forecast unavailable');
            return res.send(twiml(FORECAST_UNAVAILABLE[lang] || FORECAST_UNAVAILABLE.en));
          }

          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          const tomorrowDate = tomorrow.toISOString().slice(0, 10);
          const entry = data.list.find(e => e.dt_txt.startsWith(tomorrowDate) && e.dt_txt.includes('12:00'))
                     || data.list.find(e => e.dt_txt.startsWith(tomorrowDate));

          if (!entry) {
            console.log('[webhook] FINAL RESPONSE SENT — tomorrow forecast unavailable (no entry)');
            return res.send(twiml(FORECAST_UNAVAILABLE[lang] || FORECAST_UNAVAILABLE.en));
          }

          const temp = Math.round(entry.main.temp);
          const desc = entry.weather[0]?.description || '';
          const label = { hr: 'Sutra', en: 'Tomorrow', de: 'Morgen', it: 'Domani', fr: 'Demain' }[lang] || 'Tomorrow';
          console.log('[webhook] FINAL RESPONSE SENT — weather tomorrow');
          return res.send(twiml(`🌤️ ${city} — ${label}: ${temp}°C, ${desc}`));

        } else {
          // weather_current
          const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric&lang=${owLang}`;
          const weatherRes = await fetch(url);
          const data = await weatherRes.json();

          if (!weatherRes.ok) {
            console.log('[webhook] FINAL RESPONSE SENT — current weather unavailable');
            return res.send(twiml(WEATHER_UNAVAILABLE[lang] || WEATHER_UNAVAILABLE.en));
          }

          const temp = Math.round(data.main.temp);
          const desc = data.weather[0]?.description || '';
          const label = { hr: 'Trenutno', en: 'Now', de: 'Jetzt', it: 'Ora', fr: 'Maintenant' }[lang] || 'Now';
          console.log('[webhook] FINAL RESPONSE SENT — weather current');
          return res.send(twiml(`🌤️ ${city} — ${label}: ${temp}°C, ${desc}`));
        }

      } catch (weatherErr) {
        console.error('[webhook] weather fetch exception:', weatherErr.message);
        console.log('[webhook] FINAL RESPONSE SENT — weather exception fallback');
        return res.send(twiml(WEATHER_UNAVAILABLE[lang] || WEATHER_UNAVAILABLE.en));
      }
    }

    // 12. Events — DB-driven
    if (intent === 'events_today' || intent === 'events_tomorrow' || intent === 'events_week') {
      await logMessage(tenant.id, userPhone, trimmedMsg, 'events', lang);
      const period = intent === 'events_today' ? 'today' : intent === 'events_tomorrow' ? 'tomorrow' : 'week';
      const events = await getEventsByPeriod(tenant.id, period);
      console.log(`[webhook] FINAL RESPONSE SENT — events (${period}, ${events.length} found)`);
      return res.send(twiml(formatEventsList(events, period, lang)));
    }

    if (intent === 'events') {
      await logMessage(tenant.id, userPhone, trimmedMsg, 'events', lang);
      // AI crafted a contextual response using the pre-fetched eventContext
      const reply = aiResponse || (NO_EVENTS[lang] || NO_EVENTS.en);
      await saveMessages(tenant.id, userPhone, [
        ...history,
        { role: 'user',      content: trimmedMsg },
        { role: 'assistant', content: reply },
      ]).catch(err => console.error('[webhook] saveMessages failed:', err.message));
      console.log(`[webhook] FINAL RESPONSE SENT — events general (AI contextual)`);
      return res.send(twiml(reply));
    }

    // 13. Rate limit — per user/day, does NOT trigger takeover
    const usage = await checkAndIncrementUsage(tenant.id, userPhone);
    if (!usage.allowed) {
      await logMessage(tenant.id, userPhone, trimmedMsg, 'fallback', lang);
      console.log('[webhook] FINAL RESPONSE SENT — rate limited');
      return res.send(twiml(fallbackReply(lang)));
    }

    // 14. AI response — default for faq-no-match, anything else
    const reply = aiResponse || fallbackReply(lang);

    // Save conversation turn so AI has context on the next message
    await saveMessages(tenant.id, userPhone, [
      ...history,
      { role: 'user',      content: trimmedMsg },
      { role: 'assistant', content: reply },
    ]).catch(err => console.error('[webhook] saveMessages failed:', err.message));

    await logMessage(tenant.id, userPhone, trimmedMsg, intent === 'faq' ? 'faq' : 'ai', lang);

    // Enrich FAQ replies with a link card when the matched FAQ has link data
    const hasFaqLink = intent === 'faq' && faqMatch && (faqMatch.link_url || faqMatch.link_image);
    if (hasFaqLink) {
      console.log(`[webhook] FINAL RESPONSE SENT — FAQ with link card ("${reply.slice(0, 60)}")`);
      res.send(twimlWithFaqLink(reply, faqMatch.link_title, faqMatch.link_url, faqMatch.link_image));
    } else {
      console.log(`[webhook] FINAL RESPONSE SENT — AI ("${reply.slice(0, 60)}")`);
      res.send(twiml(reply));
    }

  } catch (err) {
    console.error('[webhook] error:', err.message);
    console.error(err.stack);
    const isQuota = err.status === 429 || err.code === 'insufficient_quota';
    console.log('[webhook] FINAL RESPONSE SENT — error fallback');
    res.send(twiml(isQuota
      ? 'Usluga je privremeno nedostupna. Molimo pokušajte ponovo.'
      : 'Došlo je do greške. Molimo pokušajte ponovo.'
    ));
  }
});

module.exports = router;
