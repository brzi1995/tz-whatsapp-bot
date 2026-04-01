const express = require('express');
const router = express.Router();
const { getTenant, getMessages, saveMessages } = require('../db/sessions');
const { parseMessage } = require('../services/openai');
const { logMessage, getFaqMatch, getUpcomingEvents, getEventsByPeriod, checkAndIncrementUsage, upsertWhatsappUser, getWhatsappUser, setOptIn } = require('../db/bot');

// Pure acknowledgements that need no reply — greetings are intentionally excluded
// so Belly can introduce herself (bok, hi, hej, etc. are handled by AI)
const TRIVIAL = new Set([
  'ok', 'okay', 'k', 'yes', 'no', 'yep', 'nope', 'thanks', 'thx', 'ty', 'np',
  'da', 'ne', 'hvala',
  'nein', 'danke',
  'si', 'grazie',
  'non', 'merci',
]);

const FALLBACK_MSG = {
  hr: 'Rado ćemo vam pomoći 😊 Naš tim će vam uskoro odgovoriti.',
  en: "We'll be happy to help 😊 Our team will respond shortly.",
  de: 'Wir helfen Ihnen gerne 😊 Unser Team meldet sich in Kürze.',
  it: 'Saremo lieti di aiutarvi 😊 Il nostro team risponderà a breve.',
  fr: 'Nous serons heureux de vous aider 😊 Notre équipe vous répondra bientôt.',
  sv: 'Vi hjälper gärna 😊 Vårt team återkommer snart.',
  no: 'Vi hjelper gjerne 😊 Teamet vårt svarer snart.',
  cs: 'Rádi vám pomůžeme 😊 Náš tým se vám brzy ozve.',
};
function fallbackReply(lang) {
  return FALLBACK_MSG[lang] || FALLBACK_MSG.en;
}

// --- Smart human handoff ---


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
const EVENTS_HEADER = {
  hr: '📅 Nadolazeći događaji:',
  en: '📅 Upcoming events:',
  de: '📅 Bevorstehende Veranstaltungen:',
  it: '📅 Prossimi eventi:',
  fr: '📅 Événements à venir:',
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

    // 3.5. Fetch current user state (takeover flag, opt-in state)
    let currentUser = null;
    try {
      currentUser = await getWhatsappUser(tenant.id, userPhone);
    } catch (userErr) {
      console.error("[webhook] getWhatsappUser failed:", userErr.message);
    }

    if (currentUser === null) {
      console.warn("[webhook] currentUser is null — user not found or DB error for:", userPhone);
    }

    // 4. PER-USER TAKEOVER CHECK — hard stop before ANY AI or response logic
    console.log("TAKEOVER STATUS:", currentUser?.human_takeover);

    if (Number(currentUser?.human_takeover) === 1) {
      console.log("BOT BLOCKED - HUMAN TAKEOVER ACTIVE");
      return res.send(emptyTwiml());
    }

    // 5. GENERATE RESPONSE — second takeover guard (defence in depth before AI call)
    console.log("TAKEOVER STATUS:", currentUser?.human_takeover);
    if (Number(currentUser?.human_takeover) === 1) {
      console.log("BOT BLOCKED - HUMAN TAKEOVER ACTIVE");
      return res.send(emptyTwiml());
    }

    const model = tenant.openai_model;
    console.log(`[webhook] AI CALLED — "${trimmedMsg}"`);
    const { lang, intent, response: aiResponse } = await parseMessage(trimmedMsg, tenant.system_prompt, model);
    console.log(`[webhook] intent=${intent} lang=${lang} response="${(aiResponse || '').slice(0, 80)}"`);

    // 7. Opt-in response (da/ne) — use already-fetched currentUser, no extra DB call
    if (lowerMsg === 'da' || lowerMsg === 'ne') {
      if (currentUser && currentUser.asked_opt_in) {
        const optIn = lowerMsg === 'da' ? 1 : 0;
        try {
          await setOptIn(tenant.id, userPhone, optIn);
          await logMessage(tenant.id, userPhone, trimmedMsg, 'ai', lang);
        } catch (optErr) {
          console.error('[webhook] opt-in error:', optErr.message);
        }
        const reply = optIn ? OPT_IN_CONFIRM.hr : OPT_OUT_CONFIRM.hr;
        console.log('[webhook] FINAL RESPONSE SENT — opt-in');
        return res.send(twiml(reply));
      }
    }

    // 8. Trivial acknowledgements — AI was called but no reply needed
    // Length < 2 catches stray single chars; greetings (bok, hi, hej…) are NOT in TRIVIAL
    if (trimmedMsg.length < 2 || TRIVIAL.has(lowerMsg)) {
      console.log(`[webhook] FINAL RESPONSE SENT — trivial (empty)`);
      return res.send(emptyTwiml());
    }

    // 9. FAQ — DB answer if match, AI response if no match (falls through)
    if (intent === 'faq') {
      const faqAnswer = await getFaqMatch(tenant.id, trimmedMsg);
      if (faqAnswer) {
        await logMessage(tenant.id, userPhone, trimmedMsg, 'faq', lang);
        console.log('[webhook] FINAL RESPONSE SENT — FAQ');
        return res.send(twiml(faqAnswer));
      }
    }

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
      const events = await getUpcomingEvents(tenant.id);
      if (!events.length) {
        console.log('[webhook] FINAL RESPONSE SENT — events (empty)');
        return res.send(twiml(NO_EVENTS[lang] || NO_EVENTS.en));
      }
      const header = EVENTS_HEADER[lang] || EVENTS_HEADER.en;
      const lines = events.map(ev => {
        const dateStr = new Date(ev.date).toISOString().slice(0, 10);
        let line = `• ${ev.title} (${dateStr})`;
        if (ev.description) line += ` — ${ev.description}`;
        if (ev.location_link) line += `\n  📍 ${ev.location_link}`;
        return line;
      }).join('\n');
      console.log(`[webhook] FINAL RESPONSE SENT — events (${events.length} found)`);
      return res.send(twiml(`${header}\n\n${lines}`));
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

    await logMessage(tenant.id, userPhone, trimmedMsg, 'ai', lang);
    console.log(`[webhook] FINAL RESPONSE SENT — AI ("${reply.slice(0, 60)}")`);
    res.send(twiml(reply));

  } catch (err) {
    console.error('[webhook] error:', err.message);
    console.error(err.stack);
    const isQuota = err.status === 429 || err.code === 'insufficient_quota';
    console.log('[webhook] FINAL RESPONSE SENT — error fallback');
    res.send(twiml(isQuota
      ? 'Service temporarily unavailable. Please try again later.'
      : 'An error occurred. Please try again.'
    ));
  }
});

module.exports = router;
