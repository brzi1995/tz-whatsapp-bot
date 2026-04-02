const express = require('express');
const router = express.Router();
const { getTenant, getMessages, saveMessages } = require('../db/sessions');
const { detectLanguage, rageMessage } = require('../services/openai');
const { logMessage, getFaqMatch, getUpcomingEvents, getEventsByPeriod, checkAndIncrementUsage, detectEventPeriod, upsertWhatsappUser, getWhatsappUser, setOptIn, setAskedOptIn, setUserLang } = require('../db/bot');

/**
 * Blocks obvious spam only — math expressions and pure gibberish.
 * Everything else is passed to AI so the bot stays helpful.
 */
function isSpam(message) {
  const lower = message.toLowerCase().trim();
  if (/\d\s*[+\-*/=]\s*\d/.test(lower)) return true;
  const lettersOnly = lower.replace(/[^a-zčćšžđ]/g, '');
  if (lettersOnly.length > 4 && !/[aeiou]/.test(lettersOnly)) return true;
  return false;
}

// Pure acknowledgements — no reply needed
const TRIVIAL = new Set([
  'ok', 'okay', 'k', 'yes', 'no', 'yep', 'nope', 'thanks', 'thx', 'ty', 'np',
  'hvala', 'nein', 'danke', 'si', 'grazie', 'non', 'merci',
]);

// Greetings — short messages only (≤3 words), handled without AI
const GREETING_WORDS = [
  'hello', 'hi', 'hey', 'bok', 'hej', 'zdravo', 'hallo', 'ciao',
  'bonjour', 'salut', 'buenas', 'buongiorno', 'dobar dan', 'guten tag',
];
function isGreeting(msg) {
  const lower = msg.toLowerCase().trim().replace(/[!?.,]*$/, '');
  if (lower.split(/\s+/).length > 3) return false; // "hello where is parking" → not greeting
  return GREETING_WORDS.some(w => lower === w || lower.startsWith(w));
}
const GREETING_MSG = {
  hr: 'Pozdrav! Ja sam vaš turistički asistent za Brela 😊\nMogu pomoći s plažama, parkingom, restoranima i događajima.',
  en: "Hello! I'm your tourist assistant for Brela 😊\nI can help with beaches, parking, restaurants, and events.",
  de: 'Hallo! Ich bin Ihr Touristenassistent für Brela 😊\nIch helfe gerne bei Stränden, Parken, Restaurants und Veranstaltungen.',
  it: 'Ciao! Sono il vostro assistente turistico per Brela 😊\nPosso aiutare con spiagge, parcheggi, ristoranti ed eventi.',
  fr: 'Bonjour! Je suis votre assistant touristique pour Brela 😊\nJe peux vous aider avec les plages, le parking, les restaurants et les événements.',
  sv: 'Hej! Jag är din turistassistent för Brela 😊\nJag kan hjälpa dig med stränder, parkering, restauranger och evenemang.',
  no: 'Hei! Jeg er din turistassistent for Brela 😊\nJeg kan hjelpe med strender, parkering, restauranter og arrangementer.',
  cs: 'Ahoj! Jsem váš turistický asistent pro Brela 😊\nMohu pomoci s plážemi, parkováním, restauracemi a akcemi.',
};
function greetingReply(lang) { return GREETING_MSG[lang] || GREETING_MSG.hr; }

// Final fallback — used when AI returns nothing useful and for spam
const FALLBACK_MSG = {
  hr: 'Nisam siguran da sam razumio 🤔\nMožeš pitati o plažama, parkingu, restoranima ili događajima.',
  en: "I'm not sure I understood 🤔\nYou can ask about beaches, parking, restaurants, or events.",
  de: 'Ich bin mir nicht sicher, ob ich das verstanden habe 🤔\nSie können nach Stränden, Parken, Restaurants oder Veranstaltungen fragen.',
  it: 'Non sono sicuro di aver capito 🤔\nPuoi chiedere di spiagge, parcheggi, ristoranti o eventi.',
  fr: "Je ne suis pas sûr d'avoir compris 🤔\nVous pouvez demander des informations sur les plages, le parking, les restaurants ou les événements.",
  sv: 'Jag är inte säker på att jag förstod 🤔\nDu kan fråga om stränder, parkering, restauranger eller evenemang.',
  no: 'Jeg er ikke sikker på at jeg forstod 🤔\nDu kan spørre om strender, parkering, restauranter eller arrangementer.',
  cs: 'Nejsem si jistý, že jsem rozuměl 🤔\nMůžete se ptát na pláže, parkování, restaurace nebo akce.',
};
function fallbackReply(lang) { return FALLBACK_MSG[lang] || FALLBACK_MSG.hr; }

const BRELA_INFO_URL = 'https://brela.hr/';

const OFF_TOPIC_MSG = {
  hr: `Nažalost, trenutno nemam točnu informaciju za to.\nZa više informacija: ${BRELA_INFO_URL}`,
  en: `I don't currently have that exact information.\nFor more information: ${BRELA_INFO_URL}`,
  de: `Dazu habe ich im Moment leider keine genaue Information.\nMehr Infos: ${BRELA_INFO_URL}`,
  it: `Al momento non ho questa informazione precisa.\nPer maggiori informazioni: ${BRELA_INFO_URL}`,
  fr: `Je n'ai pas cette information précise pour le moment.\nPour plus d'informations : ${BRELA_INFO_URL}`,
  sv: `Jag har tyvärr inte exakt den informationen just nu.\nMer information: ${BRELA_INFO_URL}`,
  no: `Jeg har dessverre ikke akkurat den informasjonen akkurat nå.\nMer informasjon: ${BRELA_INFO_URL}`,
  cs: `Tuto přesnou informaci teď bohužel nemám.\nVíce informací: ${BRELA_INFO_URL}`,
};
function offTopicReply(lang) { return OFF_TOPIC_MSG[lang] || OFF_TOPIC_MSG.en; }

// Consent prompt — sent after a few exchanges if user hasn't opted in/out yet
const CONSENT_ASK = {
  hr: 'Želiš li primati obavijesti o događajima u Brelima?\nOdgovori s DA ili NE 😊',
  en: 'Would you like to receive notifications about events in Brela?\nReply with DA or NE 😊',
  de: 'Möchten Sie Benachrichtigungen über Veranstaltungen in Brela erhalten?\nAntworten Sie mit DA oder NE 😊',
  it: 'Vuoi ricevere notifiche sugli eventi a Brela?\nRispondi con DA o NE 😊',
  fr: 'Souhaitez-vous recevoir des notifications sur les événements à Brela?\nRépondez avec DA ou NE 😊',
  sv: 'Vill du ta emot notiser om evenemang i Brela?\nSvara med DA eller NE 😊',
  no: 'Vil du motta varsler om arrangementer i Brela?\nSvar med DA eller NE 😊',
  cs: 'Chcete dostávat oznámení o akcích v Brele?\nOdpovězte DA nebo NE 😊',
};

// Invalid reply while awaiting consent
const CONSENT_INVALID = {
  hr: 'Molim odgovorite s DA ili NE.',
  en: 'Please reply with DA or NE.',
  de: 'Bitte antworten Sie mit DA oder NE.',
  it: 'Per favore rispondi con DA o NE.',
  fr: 'Veuillez répondre avec DA ou NE.',
  sv: 'Svara med DA eller NE.',
  no: 'Svar med DA eller NE.',
  cs: 'Odpovězte prosím DA nebo NE.',
};

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
    today:    'Da, danas imamo događaje u Brelima:',
    tomorrow: 'Da, sutra imamo događaje u Brelima:',
    week:     'Evo događaja u Brelima ovaj tjedan:',
    empty: {
      today:    'Danas nema organiziranih događaja, ali evo par ideja:\n• Prošetajte starim gradom\n• Posjetite jednu od plaža\n• Isprobajte lokalne restorane 😊',
      tomorrow: 'Sutra nema organiziranih događaja, ali evo par ideja:\n• Prošetajte starim gradom\n• Posjetite jednu od plaža\n• Isprobajte lokalne restorane 😊',
      week:     'Ovaj tjedan nema organiziranih događaja, ali evo par ideja:\n• Prošetajte starim gradom\n• Posjetite jednu od plaža\n• Isprobajte lokalne restorane 😊',
    },
  },
  en: {
    today:    'Yes, there are events in Brela today:',
    tomorrow: 'Yes, there are events in Brela tomorrow:',
    week:     'Here are the events in Brela this week:',
    empty: {
      today:    'No official events today, but here are some ideas:\n• Explore the old town and historic sites\n• Relax at one of the beautiful beaches\n• Discover local restaurants and cuisine 😊',
      tomorrow: 'No official events tomorrow, but here are some ideas:\n• Explore the old town and historic sites\n• Relax at one of the beautiful beaches\n• Discover local restaurants and cuisine 😊',
      week:     'No official events this week, but here are some ideas:\n• Explore the old town and historic sites\n• Relax at one of the beautiful beaches\n• Discover local restaurants and cuisine 😊',
    },
  },
  de: {
    today:    'Ja, heute gibt es Veranstaltungen in Brela:',
    tomorrow: 'Ja, morgen gibt es Veranstaltungen in Brela:',
    week:     'Hier sind die Veranstaltungen in Brela diese Woche:',
    empty: {
      today:    'Heute keine Veranstaltungen, aber hier ein paar Ideen:\n• Erkunden Sie die Altstadt und historische Stätten\n• Entspannen Sie an einem der schönen Strände\n• Entdecken Sie lokale Restaurants und die Küche 😊',
      tomorrow: 'Morgen keine Veranstaltungen, aber hier ein paar Ideen:\n• Erkunden Sie die Altstadt und historische Stätten\n• Entspannen Sie an einem der schönen Strände\n• Entdecken Sie lokale Restaurants und die Küche 😊',
      week:     'Diese Woche keine Veranstaltungen, aber hier ein paar Ideen:\n• Erkunden Sie die Altstadt und historische Stätten\n• Entspannen Sie an einem der schönen Strände\n• Entdecken Sie lokale Restaurants und die Küche 😊',
    },
  },
  it: {
    today:    'Sì, oggi ci sono eventi a Brela:',
    tomorrow: 'Sì, domani ci sono eventi a Brela:',
    week:     'Ecco gli eventi a Brela questa settimana:',
    empty: {
      today:    'Oggi nessun evento in programma, ma ecco alcune idee:\n• Esplora il centro storico e i luoghi d\'interesse\n• Rilassati su una delle splendide spiagge\n• Scopri i ristoranti locali e la cucina tipica 😊',
      tomorrow: 'Domani nessun evento in programma, ma ecco alcune idee:\n• Esplora il centro storico e i luoghi d\'interesse\n• Rilassati su una delle splendide spiagge\n• Scopri i ristoranti locali e la cucina tipica 😊',
      week:     'Questa settimana nessun evento, ma ecco alcune idee:\n• Esplora il centro storico e i luoghi d\'interesse\n• Rilassati su una delle splendide spiagge\n• Scopri i ristoranti locali e la cucina tipica 😊',
    },
  },
  fr: {
    today:    "Oui, il y a des événements à Brela aujourd'hui :",
    tomorrow: 'Oui, il y a des événements à Brela demain :',
    week:     'Voici les événements à Brela cette semaine :',
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

const UPCOMING_LABELS = {
  hr: 'Aktualni događaji u Brelima:',
  en: 'Here are the upcoming events in Brela:',
  de: 'Hier sind die kommenden Veranstaltungen in Brela:',
  it: 'Ecco i prossimi eventi a Brela:',
  fr: 'Voici les prochains événements à Brela :',
  sv: '📅 Kommande evenemang:',
  no: '📅 Kommende arrangementer:',
  cs: '📅 Nadcházející akce:',
};

const PERIOD_EMPTY_WITH_UPCOMING = {
  hr: {
    today: 'Danas nema događaja u Brelima, ali uskoro dolazi ovo:',
    tomorrow: 'Sutra nema događaja u Brelima, ali uskoro dolazi ovo:',
    week: 'Ovaj tjedan nema događaja u Brelima, ali uskoro dolazi ovo:',
  },
  en: {
    today: 'There are no events in Brela today, but these are coming up soon:',
    tomorrow: 'There are no events in Brela tomorrow, but these are coming up soon:',
    week: 'There are no events in Brela this week, but these are coming up soon:',
  },
  de: {
    today: 'Heute gibt es in Brela keine Veranstaltungen, aber das steht bald an:',
    tomorrow: 'Morgen gibt es in Brela keine Veranstaltungen, aber das steht bald an:',
    week: 'Diese Woche gibt es in Brela keine Veranstaltungen, aber das steht bald an:',
  },
  it: {
    today: 'Oggi non ci sono eventi a Brela, ma questi arrivano presto:',
    tomorrow: 'Domani non ci sono eventi a Brela, ma questi arrivano presto:',
    week: 'Questa settimana non ci sono eventi a Brela, ma questi arrivano presto:',
  },
  fr: {
    today: "Il n'y a pas d'événements à Brela aujourd'hui, mais voici ce qui arrive bientôt :",
    tomorrow: "Il n'y a pas d'événements à Brela demain, mais voici ce qui arrive bientôt :",
    week: "Il n'y a pas d'événements à Brela cette semaine, mais voici ce qui arrive bientôt :",
  },
  sv: {
    today: 'Det finns inga evenemang idag.',
    tomorrow: 'Det finns inga evenemang imorgon.',
    week: 'Det finns inga evenemang den här veckan.',
  },
  no: {
    today: 'Det er ingen arrangementer i dag.',
    tomorrow: 'Det er ingen arrangementer i morgen.',
    week: 'Det er ingen arrangementer denne uken.',
  },
  cs: {
    today: 'Dnes nejsou žádné akce.',
    tomorrow: 'Zítra nejsou žádné akce.',
    week: 'Tento týden nejsou žádné akce.',
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

function formatUpcomingEventsList(events, lang) {
  const header = UPCOMING_LABELS[lang] || UPCOMING_LABELS.en;
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

function formatPeriodFallbackWithUpcoming(events, period, lang) {
  const introSet = PERIOD_EMPTY_WITH_UPCOMING[lang] || PERIOD_EMPTY_WITH_UPCOMING.en;
  const intro = introSet[period] || introSet.today;
  return `${intro}\n\n${formatUpcomingEventsList(events, lang)}`;
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
const WEATHER_LABELS = {
  hr: {
    current: 'Vrijeme u Brelima danas',
    tomorrow: 'Vrijeme u Brelima sutra',
    forecast: days => `Prognoza za sljedećih ${days} dana u Brelima`,
    currentAndForecast: days => `Vrijeme danas i prognoza za sljedećih ${days} dana u Brelima`,
  },
  en: {
    current: 'Weather in Brela today',
    tomorrow: 'Weather in Brela tomorrow',
    forecast: days => `Forecast for the next ${days} days in Brela`,
    currentAndForecast: days => `Weather today and forecast for the next ${days} days in Brela`,
  },
  de: {
    current: 'Wetter in Brela heute',
    tomorrow: 'Wetter in Brela morgen',
    forecast: days => `Vorhersage für die nächsten ${days} Tage in Brela`,
    currentAndForecast: days => `Wetter heute und Vorhersage für die nächsten ${days} Tage in Brela`,
  },
  it: {
    current: 'Meteo a Brela oggi',
    tomorrow: 'Meteo a Brela domani',
    forecast: days => `Previsioni per i prossimi ${days} giorni a Brela`,
    currentAndForecast: days => `Meteo di oggi e previsioni per i prossimi ${days} giorni a Brela`,
  },
  fr: {
    current: "Météo à Brela aujourd'hui",
    tomorrow: 'Météo à Brela demain',
    forecast: days => `Prévisions pour les ${days} prochains jours à Brela`,
    currentAndForecast: days => `Météo du jour et prévisions pour les ${days} prochains jours à Brela`,
  },
};
const NO_EVENTS = {
  hr: 'Trenutno nema nadolazećih događaja u Brelima.',
  en: 'There are no upcoming events in Brela at the moment.',
  de: 'Derzeit gibt es keine kommenden Veranstaltungen in Brela.',
  it: 'Al momento non ci sono eventi in arrivo a Brela.',
  fr: "Il n'y a pas d'événements à venir à Brela pour le moment.",
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

/** Send two sequential WhatsApp messages in one TwiML response. */
function twimlDouble(first, second) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Message>${escapeXml(first)}</Message>` +
    `<Message>${escapeXml(second)}</Message>` +
    `</Response>`;
}

function emptyTwiml() {
  return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW FLOW HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Format a DB events array into a plain-text context string for AI polishing. */
function formatEventsForContext(events) {
  return events.map(ev => {
    const d = ev.date instanceof Date ? ev.date : new Date(ev.date);
    const dateStr = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
    let line = `• ${ev.title} (${dateStr})`;
    if (ev.description) line += `: ${ev.description}`;
    if (ev.location_link) line += ` 📍 ${ev.location_link}`;
    return line;
  }).join('\n');
}

/** Detect if a message is asking about events (not time-specific period). */
const EVENT_STEMS = [
  'događaj', 'dogadjaj',
  'event', 'events',
  'veranstaltung', 'veranstaltungen',
  'evento', 'eventi',
  'événement', 'événements',
  'evenemang', 'arrangement',
  'akce', 'události',
];
const EVENT_PHRASES = [
  'što se događa', 'sta se dogadja', 'šta se dešava',
  'ima li događ', 'ima li dogadj',
  "what's happening", "what's on", 'whats happening', 'what is happening',
];
function isEventQuery(msg) {
  const lower = msg.toLowerCase();
  return EVENT_STEMS.some(s => lower.includes(s)) ||
         EVENT_PHRASES.some(p => lower.includes(p));
}

/** Check if message is relevant to Brela tourism. */
const BRELA_TOPICS = [
  // Croatian
  'plaž', 'more', 'restoran', 'kavana', 'kafić', 'bar', 'parking', 'aktivnost',
  'izlet', 'smještaj', 'apartman', 'hotel', 'prijevoz', 'bus', 'brod', 'trajekt',
  'hrana', 'kupanj', 'ronjenje', 'bicikl', 'iznajm', 'brela', 'punta rata', 'baška',
  // English
  'beach', 'sea', 'ocean', 'restaur', 'coffee', 'cafe', 'activit', 'excursion',
  'accommodat', 'apartment', 'hotel', 'transport', 'ferry', 'boat', 'swim',
  'dive', 'snorkel', 'kayak', 'bike', 'rent', 'parking',
  // German
  'strand', 'meer', 'ausflug', 'unterkunft', 'veranstaltung',
  // Italian
  'spiaggia', 'mare', 'parcheggio', 'attività', 'escursione', 'alloggio',
  // French
  'plage', 'mer', 'activité', 'hébergement',
  // General
  'croatia', 'hrvatska', 'dalmatia', 'dalmacija', 'adriatic', 'jadran',
  'makarska', 'omiš',
];
function isRelevant(msg) {
  const lower = msg.toLowerCase();
  return BRELA_TOPICS.some(topic => lower.includes(topic));
}

/**
 * Detect follow-up messages: short (≤3 words) or starting with "a " (Croatian
 * continuation particle). These always bypass the relevance filter.
 */
function isFollowUp(msg) {
  const lower = msg.toLowerCase().trim();
  const words = lower.split(/\s+/).filter(Boolean);
  return lower.startsWith('a ') || words.length <= 3;
}

/** Check if message is asking about weather (to route to weather path). */
const WEATHER_QUERY_WORDS = [
  'weather', 'forecast', 'rain', 'sun', 'wind', 'cloud', 'hot', 'cold', 'temperature',
  'vrijeme', 'prognoza', 'kiša', 'sunce', 'vjetar', 'temperatura',
  'wetter', 'regen', 'sonne', 'temperatur',
  'tempo', 'pioggia', 'sole', 'previsione',
  'météo', 'pluie', 'soleil', 'pogoda',
];
function isWeatherQuery(msg) {
  const lower = msg.toLowerCase();
  return WEATHER_QUERY_WORDS.some(w => lower.includes(w));
}

function normalizeLookup(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getLanguageScopedHistory(history, lang) {
  return history
    .filter(msg => detectLanguage(msg.content || '') === lang)
    .slice(-6);
}

function detectWeatherIntent(message) {
  const normalized = normalizeLookup(message);
  const requestedDaysMatch = normalized.match(/\b(\d{1,2})\b/);
  const requestedDays = requestedDaysMatch ? parseInt(requestedDaysMatch[1], 10) : null;

  const asksTomorrow = ['tomorrow', 'sutra', 'morgen', 'domani', 'demain'].some(word => normalized.includes(word));
  const asksCurrent = ['today', 'danas', 'heute', 'oggi', 'aujourdhui', 'current', 'now', 'trenutno', 'sada'].some(word => normalized.includes(word));
  const asksMulti = ['forecast', 'next', 'coming', 'days', 'day', 'dana', 'dan', 'week', 'tjedan', 'tage', 'giorni', 'jours', 'previsioni', 'prognoza'].some(word => normalized.includes(word));

  if (requestedDays && requestedDays > 5) return { type: 'weather_long', days: requestedDays };
  if ((requestedDays && requestedDays > 1) || asksMulti) {
    return { type: asksCurrent ? 'weather_current_and_multi' : 'weather_multi', days: Math.min(requestedDays || 3, 5) };
  }
  if (asksTomorrow) return { type: 'weather_tomorrow', days: 1 };
  return { type: 'weather_current', days: 0 };
}

function formatShortDate(dateInput) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.`;
}

function formatWeatherCurrent(city, temp, desc, lang) {
  const labels = WEATHER_LABELS[lang] || WEATHER_LABELS.en;
  return `🌤️ ${labels.current}: ${temp}°C, ${desc}`;
}

function formatWeatherTomorrow(city, temp, desc, lang) {
  const labels = WEATHER_LABELS[lang] || WEATHER_LABELS.en;
  return `🌤️ ${labels.tomorrow}: ${temp}°C, ${desc}`;
}

function formatWeatherForecast(city, forecastDays, lang, requestedDays, currentLine = null) {
  const labels = WEATHER_LABELS[lang] || WEATHER_LABELS.en;
  const lines = forecastDays.map(entry => `${formatShortDate(entry.date)}: ${entry.temp}°C, ${entry.desc}`);
  const header = currentLine
    ? labels.currentAndForecast(requestedDays)
    : labels.forecast(requestedDays);
  return [currentLine, `🌤️ ${header}:\n${lines.join('\n')}`].filter(Boolean).join('\n\n');
}

router.post('/webhook', async (req, res) => {
  console.log('WEBHOOK HIT');
  console.log('[webhook] incoming body:', JSON.stringify(req.body));
  res.type('text/xml');

  try {
    // ── Extract + validate ───────────────────────────────────────────────────
    const { From: userPhone, To: tenantPhone, Body: userMsg } = req.body || {};
    console.log(`[webhook] From=${userPhone} To=${tenantPhone} Body="${userMsg}"`);

    if (!userMsg?.trim() || !userPhone || !tenantPhone) {
      console.warn('[webhook] missing required fields');
      return res.send(emptyTwiml());
    }

    const trimmedMsg = userMsg.trim();
    const lowerMsg   = trimmedMsg.toLowerCase().trim();

    // ── Resolve tenant ───────────────────────────────────────────────────────
    const tenant = await getTenant(tenantPhone);
    if (!tenant) {
      console.warn(`[webhook] no tenant for number: ${tenantPhone}`);
      return res.send(emptyTwiml());
    }
    console.log(`[webhook] tenant: ${tenant.name}`);

    // ── Upsert user ──────────────────────────────────────────────────────────
    try { await upsertWhatsappUser(tenant.id, userPhone); } catch (_) {}

    // ── Fetch user state ─────────────────────────────────────────────────────
    let currentUser = null;
    try {
      currentUser = await getWhatsappUser(tenant.id, userPhone);
    } catch (userErr) {
      console.error('[webhook] getWhatsappUser failed:', userErr.message);
    }

    // Use stored language as base, override with current message detection
    const lang = currentUser?.language || detectLanguage(trimmedMsg);

    // ── CONSENT GATE — highest priority ──────────────────────────────────────
    if (currentUser && Number(currentUser.asked_opt_in) === 1) {
      if (lowerMsg === 'da') {
        await setOptIn(tenant.id, userPhone, 1);
        await setAskedOptIn(tenant.id, userPhone, 0);
        await logMessage(tenant.id, userPhone, trimmedMsg, 'ai', lang).catch(() => {});
        console.log('[webhook] FINAL RESPONSE SENT — consent: opted in');
        return res.send(twiml(OPT_IN_CONFIRM[lang] || OPT_IN_CONFIRM.hr));
      } else if (lowerMsg === 'ne') {
        await setOptIn(tenant.id, userPhone, 0);
        await setAskedOptIn(tenant.id, userPhone, 0);
        await logMessage(tenant.id, userPhone, trimmedMsg, 'ai', lang).catch(() => {});
        console.log('[webhook] FINAL RESPONSE SENT — consent: opted out');
        return res.send(twiml(OPT_OUT_CONFIRM[lang] || OPT_OUT_CONFIRM.hr));
      } else {
        console.log('[webhook] FINAL RESPONSE SENT — consent: invalid reply');
        return res.send(twiml(CONSENT_INVALID[lang] || CONSENT_INVALID.hr));
      }
    }

    // ── Trivial acknowledgements — no reply needed ───────────────────────────
    if (trimmedMsg.length < 2 || TRIVIAL.has(lowerMsg)) {
      console.log('[webhook] FINAL RESPONSE SENT — trivial (empty)');
      return res.send(emptyTwiml());
    }

    // ── Spam filter ──────────────────────────────────────────────────────────
    if (isSpam(trimmedMsg)) {
      await logMessage(tenant.id, userPhone, trimmedMsg, 'fallback', lang).catch(() => {});
      console.log(`[webhook] BLOCKED — spam: "${trimmedMsg.slice(0, 40)}"`);
      return res.send(twiml(fallbackReply(lang)));
    }

    const model = tenant.openai_model;

    // Load conversation history (needed for greeting check and AI context)
    const history = await getMessages(tenant.id, userPhone).catch(() => []);
    console.log(`[webhook] history length: ${history.length}`);

    // Detect language from current message now that we have history context
    const msgLang = detectLanguage(trimmedMsg);
    await setUserLang(tenant.id, userPhone, msgLang).catch(() => {});
    const activeLang = msgLang || lang;

    // ── STEP 1: GREETING — one-time only, exact match, empty history ─────────
    const EXACT_GREETINGS = new Set(['pozdrav', 'bok', 'hej', 'hello', 'hi']);
    const greetingNorm = lowerMsg.replace(/[!?.,;:]*$/, '');
    if (EXACT_GREETINGS.has(greetingNorm) && history.length === 0) {
      await logMessage(tenant.id, userPhone, trimmedMsg, 'ai', activeLang).catch(() => {});
      console.log('[webhook] FINAL RESPONSE SENT — greeting (first message only)');
      return res.send(twiml(greetingReply(activeLang)));
    }

    // ── WEATHER — keyword-detected, API-first, no AI formatting ─────────────
    if (isWeatherQuery(trimmedMsg)) {
      const weatherIntent = detectWeatherIntent(trimmedMsg);
      const wLang  = activeLang;
      const apiKey = process.env.OPENWEATHER_API_KEY;
      const city   = tenant.city || 'Brela';
      const owLang = ['hr', 'en', 'de', 'it', 'fr'].includes(wLang) ? wLang : 'en';

      await logMessage(tenant.id, userPhone, trimmedMsg, 'weather', wLang).catch(() => {});

      if (!apiKey) {
        console.log('[webhook] FINAL RESPONSE SENT — weather (no API key)');
        return res.send(twiml(WEATHER_UNAVAILABLE[wLang] || WEATHER_UNAVAILABLE.en));
      }

      try {
        if (weatherIntent.type === 'weather_long') {
          console.log('[webhook] FINAL RESPONSE SENT — weather long-range link');
          return res.send(twiml(FORECAST_LONG_RANGE[wLang] || FORECAST_LONG_RANGE.en));
        }

        let currentLine = null;
        let forecastReply = null;

        if (weatherIntent.type === 'weather_current' || weatherIntent.type === 'weather_current_and_multi') {
          const weatherUrl = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric&lang=${owLang}`;
          const weatherRes = await fetch(weatherUrl);
          const currentData = await weatherRes.json();

          if (!weatherRes.ok) return res.send(twiml(WEATHER_UNAVAILABLE[wLang] || WEATHER_UNAVAILABLE.en));

          currentLine = formatWeatherCurrent(
            city,
            Math.round(currentData.main.temp),
            currentData.weather[0]?.description || '',
            wLang
          );

          if (weatherIntent.type === 'weather_current') {
            await saveMessages(tenant.id, userPhone, [
              ...history,
              { role: 'user', content: trimmedMsg },
              { role: 'assistant', content: currentLine },
            ]).catch(err => console.error('[webhook] saveMessages failed:', err.message));
            console.log('[webhook] FINAL RESPONSE SENT — weather (current)');
            return res.send(twiml(currentLine));
          }
        }

        const forecastUrl = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric&lang=${owLang}`;
        const forecastRes = await fetch(forecastUrl);
        const forecastData = await forecastRes.json();

        if (!forecastRes.ok) {
          const unavailable = weatherIntent.type === 'weather_tomorrow'
            ? (FORECAST_UNAVAILABLE[wLang] || FORECAST_UNAVAILABLE.en)
            : (FORECAST_UNAVAILABLE[wLang] || FORECAST_UNAVAILABLE.en);
          return res.send(twiml(unavailable));
        }

        if (weatherIntent.type === 'weather_tomorrow') {
          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          const tomorrowDate = tomorrow.toISOString().slice(0, 10);
          const entry = forecastData.list.find(e => e.dt_txt.startsWith(tomorrowDate) && e.dt_txt.includes('12:00'))
            || forecastData.list.find(e => e.dt_txt.startsWith(tomorrowDate));

          if (!entry) return res.send(twiml(FORECAST_UNAVAILABLE[wLang] || FORECAST_UNAVAILABLE.en));

          forecastReply = formatWeatherTomorrow(
            city,
            Math.round(entry.main.temp),
            entry.weather[0]?.description || '',
            wLang
          );
        } else {
          const forecastDays = [];
          const requestedDays = weatherIntent.days || 3;

          for (let i = 1; i <= requestedDays; i += 1) {
            const day = new Date();
            day.setDate(day.getDate() + i);
            const dateStr = day.toISOString().slice(0, 10);
            const entry = forecastData.list.find(e => e.dt_txt.startsWith(dateStr) && e.dt_txt.includes('12:00'))
              || forecastData.list.find(e => e.dt_txt.startsWith(dateStr));

            if (entry) {
              forecastDays.push({
                date: dateStr,
                temp: Math.round(entry.main.temp),
                desc: entry.weather[0]?.description || '',
              });
            }
          }

          if (!forecastDays.length) return res.send(twiml(FORECAST_UNAVAILABLE[wLang] || FORECAST_UNAVAILABLE.en));
          forecastReply = formatWeatherForecast(city, forecastDays, wLang, requestedDays, currentLine);
        }

        await saveMessages(tenant.id, userPhone, [
          ...history,
          { role: 'user', content: trimmedMsg },
          { role: 'assistant', content: forecastReply },
        ]).catch(err => console.error('[webhook] saveMessages failed:', err.message));

        console.log(`[webhook] FINAL RESPONSE SENT — weather (${weatherIntent.type})`);
        const reply = forecastReply || currentLine || (WEATHER_UNAVAILABLE[wLang] || WEATHER_UNAVAILABLE.en);
        return res.send(twiml(reply));

      } catch (weatherErr) {
        console.error('[webhook] weather fetch exception:', weatherErr.message);
        return res.send(twiml(WEATHER_UNAVAILABLE[wLang] || WEATHER_UNAVAILABLE.en));
      }
    }

    // ── STEP 3: EVENTS — keyword-detected, DB-first, AI format only ──────────
    if (isEventQuery(trimmedMsg)) {
      const eventPeriod = detectEventPeriod(trimmedMsg); // today/tomorrow/week/null
      await logMessage(tenant.id, userPhone, trimmedMsg, 'events', activeLang).catch(() => {});

      let events = [];
      let reply = null;

      if (eventPeriod) {
        events = await getEventsByPeriod(tenant.id, eventPeriod).catch(() => []);

        if (!events.length) {
          const upcomingEvents = await getUpcomingEvents(tenant.id).catch(() => []);
          reply = upcomingEvents.length
            ? formatPeriodFallbackWithUpcoming(upcomingEvents, eventPeriod, activeLang)
            : (EVENT_LABELS[activeLang] || EVENT_LABELS.en).empty[eventPeriod];

          await saveMessages(tenant.id, userPhone, [
            ...history,
            { role: 'user', content: trimmedMsg },
            { role: 'assistant', content: reply },
          ]).catch(err => console.error('[webhook] saveMessages failed:', err.message));

          console.log(`[webhook] FINAL RESPONSE SENT — events (${eventPeriod}, fallback ${upcomingEvents.length ? 'upcoming' : 'none'})`);
          return res.send(twiml(reply));
        }
      } else {
        events = await getUpcomingEvents(tenant.id).catch(() => []);
      }

      if (!events.length) {
        const noEventsReply = eventPeriod
          ? (EVENT_LABELS[activeLang] || EVENT_LABELS.en).empty[eventPeriod]
          : (NO_EVENTS[activeLang] || NO_EVENTS.hr);

        await saveMessages(tenant.id, userPhone, [
          ...history,
          { role: 'user', content: trimmedMsg },
          { role: 'assistant', content: noEventsReply },
        ]).catch(err => console.error('[webhook] saveMessages failed:', err.message));

        console.log('[webhook] FINAL RESPONSE SENT — events (none found)');
        return res.send(twiml(noEventsReply));
      }

      reply = eventPeriod
        ? formatEventsList(events, eventPeriod, activeLang)
        : formatUpcomingEventsList(events, activeLang);

      await saveMessages(tenant.id, userPhone, [
        ...history,
        { role: 'user', content: trimmedMsg },
        { role: 'assistant', content: reply },
      ]).catch(err => console.error('[webhook] saveMessages failed:', err.message));

      console.log(`[webhook] FINAL RESPONSE SENT — events (${eventPeriod || 'general'}, ${events.length} found)`);
      return res.send(twiml(reply));
    }

    // ── STEP 2: FAQ — database first, AI polish only ─────────────────────────
    const faqMatch = await getFaqMatch(tenant.id, trimmedMsg).catch(() => null);
    if (faqMatch) {
      // FAQ is the source of truth — AI only polishes the wording
      const rawAnswer = faqMatch.answer;
      const answerLang = detectLanguage(rawAnswer);
      let faqReply = rawAnswer;

      if (answerLang !== activeLang) {
        try {
          let aiReply = await rageMessage({
            message: trimmedMsg,
            baseAnswer: rawAnswer,
            history: getLanguageScopedHistory(history, activeLang),
            lang: activeLang,
            systemPrompt: tenant.system_prompt,
            model,
          });
          if (aiReply && detectLanguage(aiReply) !== activeLang) {
            aiReply = await rageMessage({
              message: trimmedMsg,
              baseAnswer: rawAnswer,
              history: [],
              lang: activeLang,
              systemPrompt: tenant.system_prompt,
              model,
            });
          }
          faqReply = aiReply || rawAnswer;
        } catch (e) {
          console.error('[webhook] AI failed (FAQ):', e.message);
        }
      }

      await logMessage(tenant.id, userPhone, trimmedMsg, 'faq', activeLang).catch(() => {});
      await saveMessages(tenant.id, userPhone, [
        ...history,
        { role: 'user',      content: trimmedMsg },
        { role: 'assistant', content: faqReply },
      ]).catch(err => console.error('[webhook] saveMessages failed:', err.message));

      // Consent trigger
      const shouldAskConsent = (
        currentUser &&
        currentUser.opt_in === null &&
        Number(currentUser.asked_opt_in) === 0 &&
        history.length >= 4
      );
      if (shouldAskConsent) {
        await setAskedOptIn(tenant.id, userPhone, 1).catch(() => {});
        const consentQ = CONSENT_ASK[activeLang] || CONSENT_ASK.hr;
        console.log('[webhook] FINAL RESPONSE SENT — FAQ + consent prompt');
        if (faqMatch.link_url || faqMatch.link_image) {
          return res.send(
            `<?xml version="1.0" encoding="UTF-8"?><Response>` +
            `<Message>${escapeXml(faqReply)}</Message>` +
            `<Message><Body>${escapeXml((faqMatch.link_title ? faqMatch.link_title + '\n' : '') + (faqMatch.link_url || ''))}</Body>` +
            (faqMatch.link_image ? `<Media>${escapeXml(faqMatch.link_image)}</Media>` : '') +
            `</Message>` +
            `<Message>${escapeXml(consentQ)}</Message>` +
            `</Response>`
          );
        }
        return res.send(twimlDouble(faqReply, consentQ));
      }

      console.log(`[webhook] FINAL RESPONSE SENT — FAQ ("${faqReply.slice(0, 60)}")`);
      if (faqMatch.link_url || faqMatch.link_image) {
        return res.send(twimlWithFaqLink(faqReply, faqMatch.link_title, faqMatch.link_url, faqMatch.link_image));
      }
      return res.send(twiml(faqReply));
    }

    // ── STEPS 4+5: RELEVANCE FILTER (follow-ups bypass it) ───────────────────
    const followUp = isFollowUp(trimmedMsg);
    if (!followUp && !isRelevant(trimmedMsg)) {
      await logMessage(tenant.id, userPhone, trimmedMsg, 'fallback', activeLang).catch(() => {});
      console.log(`[webhook] FINAL RESPONSE SENT — off-topic: "${trimmedMsg.slice(0, 40)}"`);
      return res.send(twiml(offTopicReply(activeLang)));
    }

    // ── Rate limit ───────────────────────────────────────────────────────────
    const usage = await checkAndIncrementUsage(tenant.id, userPhone);
    if (!usage.allowed) {
      await logMessage(tenant.id, userPhone, trimmedMsg, 'fallback', activeLang).catch(() => {});
      console.log('[webhook] FINAL RESPONSE SENT — rate limited');
      return res.send(twiml(fallbackReply(activeLang)));
    }

    // ── STEP 6: AI FALLBACK — tourism questions not covered by DB ────────────
    const scopedHistory = getLanguageScopedHistory(history, activeLang);
    let aiReply = null;
    try {
      aiReply = await rageMessage({
        message: trimmedMsg,
        history: scopedHistory,
        lang: activeLang,
        systemPrompt: tenant.system_prompt,
        model,
      });

      if (aiReply && detectLanguage(aiReply) !== activeLang) {
        aiReply = await rageMessage({
          message: trimmedMsg,
          history: [],
          lang: activeLang,
          systemPrompt: tenant.system_prompt,
          model,
        });
      }
    } catch (e) {
      console.error('[webhook] AI failed (general):', e.message);
    }

    // STEP 8: Final fallback — only if AI fails
    const reply = aiReply || fallbackReply(activeLang);

    // Persist conversation history
    await saveMessages(tenant.id, userPhone, [
      ...history,
      { role: 'user',      content: trimmedMsg },
      { role: 'assistant', content: reply },
    ]).catch(err => console.error('[webhook] saveMessages failed:', err.message));
    await logMessage(tenant.id, userPhone, trimmedMsg, 'ai', activeLang).catch(() => {});

    // Consent trigger — offer after ≥2 back-and-forth exchanges if never asked
    const shouldAskConsent = (
      currentUser &&
      currentUser.opt_in === null &&
      Number(currentUser.asked_opt_in) === 0 &&
      history.length >= 4
    );
    if (shouldAskConsent) {
      await setAskedOptIn(tenant.id, userPhone, 1).catch(() => {});
      const consentQ = CONSENT_ASK[activeLang] || CONSENT_ASK.hr;
      console.log(`[webhook] FINAL RESPONSE SENT — AI reply + consent prompt`);
      return res.send(twimlDouble(reply, consentQ));
    }

    console.log(`[webhook] FINAL RESPONSE SENT — AI ("${reply.slice(0, 60)}")`);
    return res.send(twiml(reply));

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
