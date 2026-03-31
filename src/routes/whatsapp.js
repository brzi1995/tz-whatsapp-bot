const express = require('express');
const router = express.Router();
const { getTenant, getMessages, saveMessages } = require('../db/sessions');
const { parseMessage } = require('../services/openai');
const { logMessage, getFaqMatch, getUpcomingEvents, getEventsByPeriod, checkAndIncrementUsage, setHumanTakeover } = require('../db/bot');
const { sendHandoverEmail } = require('../services/email');

// Messages that need no AI response — short acknowledgements across all supported languages
const TRIVIAL = new Set([
  'ok', 'okay', 'k', 'yes', 'no', 'yep', 'nope', 'thanks', 'thx', 'ty', 'np',
  'da', 'ne', 'hvala', 'bok',
  'ja', 'nein', 'danke', 'super',
  'si', 'grazie',
  'oui', 'non', 'merci',
]);

const FALLBACK_MSG = {
  hr: 'Rado ćemo vam pomoći 😊 Naš tim će vam uskoro odgovoriti.',
  default: "We'll be happy to help 😊 Our team will respond shortly.",
};
function fallbackReply(lang) {
  return FALLBACK_MSG[lang] || FALLBACK_MSG.default;
}

// Language-aware labels and empty-state messages for time-specific event queries
const EVENT_LABELS = {
  hr: {
    today:    '📅 Događaji za danas:',
    tomorrow: '📅 Događaji za sutra:',
    week:     '📅 Događaji ovaj tjedan:',
    empty: {
      today:    'Danas nema planiranih događaja. Svratite u TZ ured za više informacija! 😊',
      tomorrow: 'Sutra nema planiranih događaja. Svratite u TZ ured za više informacija! 😊',
      week:     'Ovaj tjedan nema planiranih događaja. Svratite u TZ ured za više informacija! 😊',
    },
  },
  en: {
    today:    '📅 Events today:',
    tomorrow: '📅 Events tomorrow:',
    week:     '📅 Events this week:',
    empty: {
      today:    'No events planned for today. Drop by the tourist office for more info! 😊',
      tomorrow: 'No events planned for tomorrow. Drop by the tourist office for more info! 😊',
      week:     'No events planned this week. Drop by the tourist office for more info! 😊',
    },
  },
  de: {
    today:    '📅 Veranstaltungen heute:',
    tomorrow: '📅 Veranstaltungen morgen:',
    week:     '📅 Veranstaltungen diese Woche:',
    empty: {
      today:    'Heute sind keine Veranstaltungen geplant. Besuchen Sie das Tourismusbüro! 😊',
      tomorrow: 'Morgen sind keine Veranstaltungen geplant. Besuchen Sie das Tourismusbüro! 😊',
      week:     'Diese Woche sind keine Veranstaltungen. Besuchen Sie das Tourismusbüro! 😊',
    },
  },
  it: {
    today:    '📅 Eventi oggi:',
    tomorrow: '📅 Eventi domani:',
    week:     '📅 Eventi questa settimana:',
    empty: {
      today:    "Nessun evento previsto per oggi. Passa dall'ufficio turistico! 😊",
      tomorrow: "Nessun evento previsto per domani. Passa dall'ufficio turistico! 😊",
      week:     "Nessun evento questa settimana. Passa dall'ufficio turistico! 😊",
    },
  },
  fr: {
    today:    "📅 Événements aujourd'hui:",
    tomorrow: '📅 Événements demain:',
    week:     '📅 Événements cette semaine:',
    empty: {
      today:    "Aucun événement prévu aujourd'hui. Passez à l'office de tourisme! 😊",
      tomorrow: "Aucun événement prévu demain. Passez à l'office de tourisme! 😊",
      week:     "Aucun événement cette semaine. Passez à l'office de tourisme! 😊",
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
  hr: 'Trenutno nema nadolazećih događaja. Svratite u TZ ured za više informacija! 😊',
  en: 'No upcoming events at this time. Drop by the tourist office for more info! 😊',
  de: 'Aktuell keine Veranstaltungen. Besuchen Sie das Tourismusbüro! 😊',
  it: "Nessun evento in programma. Passa dall'ufficio turistico! 😊",
  fr: "Aucun événement à venir. Passez à l'office de tourisme! 😊",
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
  console.log('[webhook] incoming body:', JSON.stringify(req.body));
  res.type('text/xml');

  try {
    // 1. Extract fields
    const { From: userPhone, To: tenantPhone, Body: userMsg } = req.body || {};
    console.log(`[webhook] From=${userPhone} To=${tenantPhone} Body="${userMsg}"`);

    // 2. Validate fields
    if (!userMsg?.trim() || !userPhone || !tenantPhone) {
      console.warn('[webhook] missing required fields');
      return res.send(emptyTwiml());
    }

    // 3. Resolve tenant
    const tenant = await getTenant(tenantPhone);
    if (!tenant) {
      console.warn(`[webhook] no tenant for number: ${tenantPhone}`);
      return res.send(emptyTwiml());
    }
    console.log(`[webhook] tenant: ${tenant.name} | prompt length: ${tenant.system_prompt?.length ?? 0}`);

    const trimmedMsg = userMsg.trim();
    const model = tenant.openai_model;

    // 3.5. Short / trivial messages — no AI call, no response needed
    if (trimmedMsg.length < 4 || TRIVIAL.has(trimmedMsg.toLowerCase())) {
      console.log(`[webhook] trivial message ignored: "${trimmedMsg}"`);
      return res.send(emptyTwiml());
    }

    // 4. Single AI call — detects lang + intent AND generates the reply for non-event/weather cases
    const { lang, intent, response: aiResponse } = await parseMessage(trimmedMsg, tenant.system_prompt, model);
    console.log(`[webhook] intent=${intent} lang=${lang}`);

    // 5. Human takeover — agent is handling this conversation manually
    if (tenant.human_takeover) {
      console.log(`[webhook] human_takeover active for tenant ${tenant.id} — silencing bot`);
      await logMessage(tenant.id, userPhone, trimmedMsg, 'ai', lang);
      return res.send(emptyTwiml());
    }

    // 6. FAQ — return DB answer directly; no match falls through to aiResponse
    if (intent === 'faq') {
      const faqAnswer = await getFaqMatch(tenant.id, trimmedMsg);
      if (faqAnswer) {
        await logMessage(tenant.id, userPhone, trimmedMsg, 'faq', lang);
        console.log(`[webhook] FAQ match found`);
        return res.send(twiml(faqAnswer));
      }
      // No FAQ match — fall through to aiResponse
    }

    // 7. Weather — real data from OpenWeather API, language-aware templates (no extra AI call)
    if (intent === 'weather_current' || intent === 'weather_tomorrow' || intent === 'weather_multi') {
      await logMessage(tenant.id, userPhone, trimmedMsg, 'weather', lang);

      const apiKey = process.env.OPENWEATHER_API_KEY;
      console.log(`[webhook] OPENWEATHER_API_KEY loaded: ${apiKey ? 'yes (' + apiKey.slice(0, 4) + '...)' : 'NO — key missing'}`);

      const city = tenant.city || 'Brela';
      // Pass lang to OpenWeather so descriptions come back in the user's language
      const owLang = ['hr','en','de','it','fr'].includes(lang) ? lang : 'en';

      if (!apiKey) {
        return res.send(twiml(WEATHER_UNAVAILABLE[lang] || WEATHER_UNAVAILABLE.en));
      }

      try {
        if (intent === 'weather_multi') {
          const daysMatch = trimmedMsg.match(/\d+/);
          const requestedDays = daysMatch ? Math.min(parseInt(daysMatch[0], 10), 5) : 3;

          if (daysMatch && parseInt(daysMatch[0], 10) > 5) {
            return res.send(twiml(FORECAST_LONG_RANGE[lang] || FORECAST_LONG_RANGE.en));
          }

          const url = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric&lang=${owLang}`;
          console.log(`[webhook] fetching ${requestedDays}-day forecast for: ${city}`);
          const forecastRes = await fetch(url);
          const data = await forecastRes.json();

          if (!forecastRes.ok) {
            console.warn(`[webhook] forecast error ${forecastRes.status}:`, data.message);
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
            return res.send(twiml(FORECAST_UNAVAILABLE[lang] || FORECAST_UNAVAILABLE.en));
          }

          const label = { hr: 'Prognoza', en: 'Forecast', de: 'Vorhersage', it: 'Previsioni', fr: 'Prévisions' }[lang] || 'Forecast';
          return res.send(twiml(`🌤️ ${city} — ${label}:\n${days.join('\n')}`));

        } else if (intent === 'weather_tomorrow') {
          const url = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric&lang=${owLang}`;
          console.log(`[webhook] fetching tomorrow forecast for: ${city}`);
          const forecastRes = await fetch(url);
          const data = await forecastRes.json();

          if (!forecastRes.ok) {
            console.warn(`[webhook] forecast error ${forecastRes.status}:`, data.message);
            return res.send(twiml(FORECAST_UNAVAILABLE[lang] || FORECAST_UNAVAILABLE.en));
          }

          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          const tomorrowDate = tomorrow.toISOString().slice(0, 10);
          const entry = data.list.find(e => e.dt_txt.startsWith(tomorrowDate) && e.dt_txt.includes('12:00'))
                     || data.list.find(e => e.dt_txt.startsWith(tomorrowDate));

          if (!entry) {
            return res.send(twiml(FORECAST_UNAVAILABLE[lang] || FORECAST_UNAVAILABLE.en));
          }

          const temp = Math.round(entry.main.temp);
          const desc = entry.weather[0]?.description || '';
          console.log(`[webhook] tomorrow forecast OK: ${temp}°C, ${desc}`);
          const label = { hr: 'Sutra', en: 'Tomorrow', de: 'Morgen', it: 'Domani', fr: 'Demain' }[lang] || 'Tomorrow';
          return res.send(twiml(`🌤️ ${city} — ${label}: ${temp}°C, ${desc}`));

        } else {
          // weather_current
          const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric&lang=${owLang}`;
          console.log(`[webhook] fetching current weather for: ${city}`);
          const weatherRes = await fetch(url);
          const data = await weatherRes.json();

          if (!weatherRes.ok) {
            console.warn(`[webhook] weather error ${weatherRes.status}:`, data.message);
            return res.send(twiml(WEATHER_UNAVAILABLE[lang] || WEATHER_UNAVAILABLE.en));
          }

          const temp = Math.round(data.main.temp);
          const desc = data.weather[0]?.description || '';
          console.log(`[webhook] weather OK: ${temp}°C, ${desc}`);
          const label = { hr: 'Trenutno', en: 'Now', de: 'Jetzt', it: 'Ora', fr: 'Maintenant' }[lang] || 'Now';
          return res.send(twiml(`🌤️ ${city} — ${label}: ${temp}°C, ${desc}`));
        }

      } catch (weatherErr) {
        console.error('[webhook] weather fetch exception:', weatherErr.message);
        return res.send(twiml(WEATHER_UNAVAILABLE[lang] || WEATHER_UNAVAILABLE.en));
      }
    }

    // 8. Events — time-specific (no AI call) or general (AI-formatted)
    if (intent === 'events_today' || intent === 'events_tomorrow' || intent === 'events_week') {
      await logMessage(tenant.id, userPhone, trimmedMsg, 'events', lang);
      const period = intent === 'events_today' ? 'today' : intent === 'events_tomorrow' ? 'tomorrow' : 'week';
      const events = await getEventsByPeriod(tenant.id, period);
      console.log(`[webhook] events_${period}: ${events.length} found`);
      return res.send(twiml(formatEventsList(events, period, lang)));
    }

    if (intent === 'events') {
      await logMessage(tenant.id, userPhone, trimmedMsg, 'events', lang);

      const events = await getUpcomingEvents(tenant.id);
      if (!events.length) {
        return res.send(twiml(NO_EVENTS[lang] || NO_EVENTS.en));
      }

      const lines = events.map(ev => {
        const dateStr = new Date(ev.date).toISOString().slice(0, 10);
        let line = `• ${ev.title} (${dateStr})`;
        if (ev.description) line += ` — ${ev.description}`;
        if (ev.location_link) line += `\n  📍 ${ev.location_link}`;
        return line;
      }).join('\n');

      console.log(`[webhook] events found: ${events.length}`);
      const header = EVENTS_HEADER[lang] || EVENTS_HEADER.en;
      return res.send(twiml(`${header}\n\n${lines}`));
    }

    // 9. 'other' intent — human handover (no AI call wasted)
    if (intent === 'other') {
      console.log(`[webhook] intent=other — triggering human handover for tenant ${tenant.id}`);
      await logMessage(tenant.id, userPhone, trimmedMsg, 'fallback', lang);
      await setHumanTakeover(tenant.id);
      await sendHandoverEmail(userPhone, trimmedMsg);
      return res.send(twiml(fallbackReply(lang)));
    }

    // 10. AI usage rate limit (applies to FAQ-with-no-match reaching this point)
    const usage = await checkAndIncrementUsage(tenant.id, userPhone);
    if (!usage.allowed) {
      console.log(`[webhook] AI rate limit reached for ${userPhone} on tenant ${tenant.id}`);
      await logMessage(tenant.id, userPhone, trimmedMsg, 'fallback', lang);
      await setHumanTakeover(tenant.id);
      await sendHandoverEmail(userPhone, trimmedMsg);
      return res.send(twiml(fallbackReply(lang)));
    }

    // 11. Use the AI response already generated in step 4 — no second call needed
    const reply = aiResponse || fallbackReply(lang);
    console.log(`[webhook] AI reply: "${reply}"`);

    await logMessage(tenant.id, userPhone, trimmedMsg, 'ai', lang);

    res.send(twiml(reply));
    console.log(`[webhook] TwiML sent to ${userPhone}`);
  } catch (err) {
    console.error('[webhook] error:', err.message);
    console.error(err.stack);
    const isQuota = err.status === 429 || err.code === 'insufficient_quota';
    res.send(twiml(isQuota
      ? 'Service temporarily unavailable. Please try again later.'
      : 'An error occurred. Please try again.'
    ));
  }
});

module.exports = router;
