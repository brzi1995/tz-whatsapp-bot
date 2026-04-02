const express = require('express');
const router = express.Router();
const { getTenant, getConversation, saveConversation } = require('../db/sessions');
const { detectLanguage, detectLanguageWithConfidence, rageMessage } = require('../services/openai');
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
  'hvala', 'nein', 'danke', 'grazie', 'merci',
]);
const SHORT_UNCLEAR = new Set(['da', 'ne', 'yes', 'no', 'yep', 'nope']);

// Greetings — short messages only (≤3 words), handled without AI
const GREETING_WORDS = [
  'hello', 'hi', 'hey', 'bok', 'hej', 'zdravo', 'hallo', 'ciao',
  'bonjour', 'salut', 'buenas', 'buongiorno', 'dobar dan', 'guten tag',
];
const GREETING_LANGUAGE = {
  pozdrav: 'hr',
  bok: 'hr',
  zdravo: 'hr',
  'dobar dan': 'hr',
  hello: 'en',
  hi: 'en',
  hey: 'en',
  hallo: 'de',
  'guten tag': 'de',
  ciao: 'it',
  buongiorno: 'it',
  bonjour: 'fr',
  salut: 'fr',
};
function isGreeting(msg) {
  const lower = msg.toLowerCase().trim().replace(/[!?.,]*$/, '');
  if (lower.split(/\s+/).length > 3) return false; // "hello where is parking" → not greeting
  return GREETING_WORDS.some(w => lower === w || lower.startsWith(w));
}
function detectGreetingLanguage(msg) {
  const lower = msg.toLowerCase().trim().replace(/[!?.,]*$/, '');
  return GREETING_LANGUAGE[lower] || null;
}
const GREETING_MSG = {
  hr: 'Bok! Ja sam Belly, vaš lokalni turistički vodič za Brela. Kako vam mogu pomoći?',
  en: "Hello! I'm Belly, your local guide for Brela. How can I help?",
  de: 'Hallo! Ich bin Belly, Ihr lokaler Guide für Brela. Wie kann ich helfen?',
  it: 'Ciao! Sono Belly, la tua guida locale per Brela. Come posso aiutarti?',
  fr: "Bonjour ! Je suis Belly, votre guide local pour Brela. Comment puis-je aider ?",
  sv: 'Hej! Jag är Belly, din lokala guide för Brela. Hur kan jag hjälpa till?',
  no: 'Hei! Jeg er Belly, din lokale guide for Brela. Hvordan kan jeg hjelpe?',
  cs: 'Ahoj! Jsem Belly, tvůj místní průvodce pro Brela. Jak mohu pomoci?',
};
function greetingReply(lang) { return GREETING_MSG[lang] || GREETING_MSG.hr; }

const YES_MSG = {
  hr: 'Naravno — kako vam mogu pomoći?',
  en: 'Sure — how can I help?',
  de: 'Klar — wie kann ich helfen?',
  it: 'Certo — come posso aiutarti?',
  fr: 'Bien sûr — comment puis-je aider ?',
  sv: 'Självklart — hur kan jag hjälpa till?',
  no: 'Klart — hvordan kan jeg hjelpe?',
  cs: 'Jasně — jak mohu pomoci?',
};
const NO_MSG = {
  hr: 'U redu — tu sam ako vam nešto zatreba o Brelima.',
  en: "Alright — I'm here if you need anything about Brela.",
  de: 'Alles klar — jsem tu, pokud něco potřebujete o Brela.', 
  it: 'Va bene — sono qui se ti serve altro su Brela.',
  fr: "D'accord — je suis là si vous avez besoin de quelque chose sur Brela.",
  sv: 'Okej — jag är här om du behöver något om Brela.',
  no: 'Greit — jeg er her hvis du trenger noe om Brela.',
  cs: 'Dobře — jsem tu, pokud budete něco potřebovat o Brela.',
};
function yesReply(lang) { return YES_MSG[lang] || YES_MSG.hr; }
function noReply(lang) { return NO_MSG[lang] || NO_MSG.hr; }

// Final fallback — used when AI returns nothing useful and for spam
const FALLBACK_MSG = {
  hr: 'Nisam razumio pitanje. Možete pojasniti koju informaciju trebate da odgovor bude točan?',
  en: "I didn't understand the question. Please clarify what information you need so I can be precise.",
  de: 'Ich habe die Frage nicht verstanden. Bitte sagen Sie, welche Information Sie brauchen, damit ich genau antworte.',
  it: "Non ho capito la domanda. Puoi chiarire quale informazione ti serve così rispondo preciso?",
  fr: "Je n'ai pas compris la question. Pouvez-vous préciser quelle info vous voulez pour que je réponde précisément ?",
  sv: 'Jag förstod inte frågan. Förtydliga vilken information du behöver så svarar jag exakt.',
  no: 'Jeg forsto ikke spørsmålet. Presiser hvilken informasjon du trenger, så svarer jeg presist.',
  cs: 'Nerozuměl jsem otázce. Uveďte prosím, jakou informaci potřebujete, a odpovím přesně.',
};
function fallbackReply(lang) { return FALLBACK_MSG[lang] || FALLBACK_MSG.hr; }

const BRELA_INFO_URL = 'https://brela.hr/';
const BRELA_CONTACT_URL = 'https://brela.hr/kontakt/';

const OFF_TOPIC_MSG = {
  hr: `Dajem informacije o Brelima (plaže, parking, vrijeme, događaji). Javite što vas točno zanima, a dodatne kontakte imate ovdje: ${BRELA_CONTACT_URL}`,
  en: `I share info about Brela (beaches, parking, weather, events). Tell me what you need for Brela; contacts are here: ${BRELA_CONTACT_URL}`,
  de: `Ich gebe Infos zu Brela (Strände, Parken, Wetter, Events). Sagen Sie mir, was Sie für Brela brauchen; Kontakte hier: ${BRELA_CONTACT_URL}`,
  it: `Posso dati info su Brela (spiagge, parcheggio, meteo, eventi). Dimmi cosa ti serve per Brela; contatti qui: ${BRELA_CONTACT_URL}`,
  fr: `Je fournis des infos sur Brela (plages, parking, météo, événements). Dites-moi ce qu'il vous faut pour Brela; contacts ici : ${BRELA_CONTACT_URL}`,
  sv: `Jag ger info om Brela (stränder, parkering, väder, evenemang). Säg vad du behöver för Brela; kontakter här: ${BRELA_CONTACT_URL}`,
  no: `Jeg gir info om Brela (strender, parkering, vær, arrangementer). Si hva du trenger for Brela; kontakter her: ${BRELA_CONTACT_URL}`,
  cs: `Poskytuji info o Brele (pláže, parkování, počasí, akce). Napište, co přesně potřebujete; kontakty jsou zde: ${BRELA_CONTACT_URL}`,
};
function offTopicReply(lang) { return OFF_TOPIC_MSG[lang] || OFF_TOPIC_MSG.en; }

const UNCLEAR_MSG = {
  hr: `Nisam siguran što točno trebate.\nMožete napisati malo preciznije pitanje.\nZa više informacija: ${BRELA_INFO_URL}`,
  en: `I'm not sure what exactly you're asking.\nCould you be a bit more specific?\nFor more information: ${BRELA_INFO_URL}`,
  de: `Ich bin nicht sicher, was Sie genau meinen.\nKönnen Sie Ihre Frage bitte etwas genauer formulieren?\nMehr Infos: ${BRELA_INFO_URL}`,
  it: `Non sono sicuro di aver razumio esattamente cosa intendi.\nPuoi scrivere la domanda in modo un po’ più preciso?\nPer maggiori informazioni: ${BRELA_INFO_URL}`,
  fr: `Je ne suis pas sûr de comprendre exactement votre demande.\nPouvez-vous être un peu plus précis ?\nPour plus d'informations : ${BRELA_INFO_URL}`,
  sv: `Jag är inte säker på vad du menar.\nKan du skriva lite mer exakt?\nMer information: ${BRELA_INFO_URL}`,
  no: `Jeg er ikke helt sikker på hva du mener.\nKan du være litt mer konkret?\nMer informasjon: ${BRELA_INFO_URL}`,
  cs: `Nejsem si jistý, co přesně potřebujete.\nMůžete otázku napsat trochu přesněji?\nVíce informací: ${BRELA_INFO_URL}`,
};
function unclearReply(lang) { return UNCLEAR_MSG[lang] || UNCLEAR_MSG.en; }

const CLARIFY_MSG = {
  hr: 'Mogu pomoći, ali trebam malo preciznije pitanje.\nNapišite lokaciju ili što vas točno zanima.\nZa više informacija: https://brela.hr/',
  en: 'I can help, but I need a bit more detail.\nPlease send the location or what exactly you need.\nFor more information: https://brela.hr/',
  de: 'Ich kann helfen, brauche aber etwas mehr Details.\nBitte senden Sie den Ort oder was Sie genau brauchen.\nMehr Infos: https://brela.hr/',
  it: 'Posso aiutarti, ma ho bisogno di qualche dettaglio in più.\nScrivi la località o di cosa hai bisogno esattamente.\nPer maggiori informazioni: https://brela.hr/',
  fr: "Je peux aider, mais j'ai besoin d'un peu plus de détails.\nIndiquez le lieu ou ce dont vous avez exactement besoin.\nPour plus d'informations : https://brela.hr/",
  sv: 'Jag kan hjälpa till, men jag behöver lite mer information.\nSkriv platsen eller vad du exakt behöver.\nMer information: https://brela.hr/',
  no: 'Jeg kan hjelpe, men jeg trenger litt mer informasjon.\nSkriv stedet eller hva du trenger helt konkret.\nMer informasjon: https://brela.hr/',
  cs: 'Mohu pomoci, ale potřebuji trochu více podrobností.\nNapište místo nebo co přesně potřebujete.\nVíce informací: https://brela.hr/',
};

const PARKING_CLARIFY_MSG = {
  hr: 'Mogu pomoći oko parkinga, ali trebam malo preciznije pitanje.\nZanima vas:\n1. parking u centru\n2. parking blizu plaže\n3. parking kod smještaja\nZa više informacija: https://brela.hr/',
  en: 'I can help with parking, but I need a bit more detail.\nDo you mean:\n1. parking in the center\n2. parking near the beach\n3. parking near your accommodation\nFor more information: https://brela.hr/',
  de: 'Ich kann beim Parken helfen, brauche aber etwas mehr Details.\nMeinen Sie:\n1. Parken im Zentrum\n2. Parken nahe dem Strand\n3. Parken bei Ihrer Unterkunft\nMehr Infos: https://brela.hr/',
  it: 'Posso aiutarti con il parcheggio, ma ho bisogno di qualche dettaglio in più.\nIntendi:\n1. parcheggio in centro\n2. parcheggio vicino alla spiaggia\n3. parcheggio vicino all’alloggio\nPer maggiori informazioni: https://brela.hr/',
  fr: "Je peux aider pour le parking, mais j'ai besoin d'un peu plus de détails.\nVous parlez de :\n1. parking dans le centre\n2. parking près de la plage\n3. parking près de votre hébergement\nPour plus d'informations : https://brela.hr/",
  sv: 'Jag kan hjälpa till med parkering, men jag behöver lite mer information.\nMenar du:\n1. parkering i centrum\n2. parkering nära stranden\n3. parkering nära ditt boende\nMer information: https://brela.hr/',
  no: 'Jeg kan hjelpe med parkering, men jeg trenger litt mer informasjon.\nMener du:\n1. parkering i sentrum\n2. parkering nær stranden\n3. parkering ved overnattingen din\nMer informasjon: https://brela.hr/',
  cs: 'Mohu pomoci s parkováním, ale potřebuji trochu více podrobností.\nMyslíte:\n1. parkování v centru\n2. parkování blízko pláže\n3. parkování u vašeho ubytování\nVíce informací: https://brela.hr/',
};

const PARKING_FALLBACK = {
  hr: `Javni parking je u centru (Trg A. Stepinca) i uz glavne plaže (Punta Rata, Soline, Podrače). Karta i točne lokacije: ${BRELA_INFO_URL}\nNapišite uz koju plažu trebate pa šaljem najbliže mjesto.`,
  en: `Public parking is in the center (Trg A. Stepinca) and by main beaches (Punta Rata, Soline, Podrače). Map: ${BRELA_INFO_URL}\nTell me which beach and I'll send the nearest spot.`,
  de: `Öffentliches Parken gibt es im Zentrum (Trg A. Stepinca) und bei den Hauptstränden (Punta Rata, Soline, Podrače). Karte: ${BRELA_INFO_URL}\nSag mir, bei welchem Strand du parkst, dann nenne ich den nächsten Platz.`,
  it: `Parcheggi pubblici sono in centro (Trg A. Stepinca) e presso le spiagge principali (Punta Rata, Soline, Podrače). Mappa: ${BRELA_INFO_URL}\nDimmi quale spiaggia e invio il parcheggio più vicino.`,
  fr: `Parking public au centre (Trg A. Stepinca) et près des plages principales (Punta Rata, Soline, Podrače). Carte : ${BRELA_INFO_URL}\nDis-moi quelle plage et j’indiquerai le parking le plus proche.`,
};
function parkingFallbackReply(lang) {
  return PARKING_FALLBACK[lang] || PARKING_FALLBACK.en;
}

const FAQ_CHOICE_INTRO = {
  hr: 'Nisam siguran na koje pitanje točno mislite. Možda vas zanima:',
  en: "I'm not sure which question you mean. Maybe you mean:",
  de: 'Ich bin nicht sicher, welche Frage Sie genau meinen. Vielleicht meinen Sie:',
  it: 'Non sono sicuro a quale domanda ti riferisci esattamente. Forse intendi:',
  fr: 'Je ne suis pas sûr de savoir à quelle question vous faites référence. Peut-être voulez-vous dire :',
};
const FAQ_CHOICE_PROMPT = {
  hr: 'Odgovorite s 1, 2 ili 3.',
  en: 'Reply with 1, 2, or 3.',
  de: 'Antworten Sie mit 1, 2 oder 3.',
  it: 'Rispondi con 1, 2 o 3.',
  fr: 'Répondez avec 1, 2 ou 3.',
};
function formatFaqClarifyReply(options, lang) {
  const intro = FAQ_CHOICE_INTRO[lang] || FAQ_CHOICE_INTRO.en;
  const prompt = FAQ_CHOICE_PROMPT[lang] || FAQ_CHOICE_PROMPT.en;
  const lines = options.slice(0, 3).map((option, index) => `${index + 1}. ${option.question}`);
  return `${intro}\n${lines.join('\n')}\n${prompt}`;
}

function normalizeConversationState(state) {
  const safe = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  const awaiting = safe.awaiting && typeof safe.awaiting === 'object' && !Array.isArray(safe.awaiting)
    ? safe.awaiting
    : null;
  return {
    lastLanguage: safe.lastLanguage || null,
    lastTopic: safe.lastTopic || null,
    lastWeatherIntent: safe.lastWeatherIntent || null,
    lastEventPeriod: safe.lastEventPeriod || null,
    lastFaq: safe.lastFaq || null,
    awaiting,
  };
}

function clarificationReply(message, lang) {
  const normalized = normalizeLookup(message);
  const isParking = ['parking', 'parkiranje', 'parkinga', 'parcheggio', 'parken', 'parkov', 'stationnement'].some(term => normalized.includes(term));
  if (isParking) return PARKING_CLARIFY_MSG[lang] || PARKING_CLARIFY_MSG.en;
  return CLARIFY_MSG[lang] || CLARIFY_MSG.en;
}

function needsParkingClarification(message) {
  // Disable multi-step parking clarification; answer directly with fallback.
  return false;
}

function isSpecificParkingQuestion(message) {
  const normalized = normalizeLookup(message);
  const hasParking = ['parking', 'parkiranje', 'parkinga', 'parcheggio', 'parken', 'parkov', 'stationnement'].some(term => normalized.includes(term));
  return hasParking && !needsParkingClarification(message);
}

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
      today:    `Danas nema najavljenih događaja u Brelima.\nZa više informacija: ${BRELA_INFO_URL}`,
      tomorrow: `Sutra nema najavljenih događaja u Brelima.\nZa više informacija: ${BRELA_INFO_URL}`,
      week:     `Ovaj tjedan nema najavljenih događaja u Brelima.\nZa više informacija: ${BRELA_INFO_URL}`,
    },
  },
  en: {
    today:    'Yes, there are events in Brela today:',
    tomorrow: 'Yes, there are events in Brela tomorrow:',
    week:     'Here are the events in Brela this week:',
    empty: {
      today:    `There are no announced events in Brela today.\nFor more information: ${BRELA_INFO_URL}`,
      tomorrow: `There are no announced events in Brela tomorrow.\nFor more information: ${BRELA_INFO_URL}`,
      week:     `There are no announced events in Brela this week.\nFor more information: ${BRELA_INFO_URL}`,
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
// Links defined before use in unavailable messages
const FORECAST_LONG_RANGE_URL = 'https://weather.com/hr-HR/vrijeme/10dana/l/Brela+Splitsko+dalmatinska+%C5%BEupanija';
const FORECAST_LONG_RANGE = {
  hr: `Za detaljnu 10-dnevnu prognozu:\n${FORECAST_LONG_RANGE_URL}`,
  en: `For a detailed 10-day forecast:\n${FORECAST_LONG_RANGE_URL}`,
  de: `Für die 10-Tage-Vorhersage:\n${FORECAST_LONG_RANGE_URL}`,
  it: `Per le previsioni a 10 giorni:\n${FORECAST_LONG_RANGE_URL}`,
  fr: `Pour les prévisions à 10 jours:\n${FORECAST_LONG_RANGE_URL}`,
};
const WEATHER_UNAVAILABLE = {
  hr: `🌤️ Trenutne podatke nemam pri ruci. Pogledaj ovdje: ${FORECAST_LONG_RANGE_URL}`,
  en: `🌤️ I don't have live data right now. Check here: ${FORECAST_LONG_RANGE_URL}`,
  de: `🌤️ Keine Live-Daten gerade. Schau hier: ${FORECAST_LONG_RANGE_URL}`,
  it: `🌤️ Non ho i dati live ora. Vedi qui: ${FORECAST_LONG_RANGE_URL}`,
  fr: `🌤️ Pas de données en direct pour l'instant. Voir ici : ${FORECAST_LONG_RANGE_URL}`,
};
const FORECAST_UNAVAILABLE = {
  hr: `🌤️ Prognoza mi nije pri ruci. Detaljna: ${FORECAST_LONG_RANGE_URL}`,
  en: `🌤️ I don't have that forecast handy. Full details: ${FORECAST_LONG_RANGE_URL}`,
  de: `🌤️ Keine Vorhersage verfügbar. Details: ${FORECAST_LONG_RANGE_URL}`,
  it: `🌤️ Non ho quella previsione adesso. Dettagli: ${FORECAST_LONG_RANGE_URL}`,
  fr: `🌤️ Prévision indisponible. Détails : ${FORECAST_LONG_RANGE_URL}`,
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
  'događaj', 'dogadjaj', 'dogadaj', 'dogadanja', 'dogadanj',
  'event', 'events',
  'veranstaltung', 'veranstaltungen',
  'evento', 'eventi',
  'événement', 'événements',
  'evenemang', 'arrangement',
  'akce', 'události',
];
const EVENT_PHRASES = [
  'što ima', 'sta ima', 'sto ima',
  'što se događa', 'sta se dogadja', 'sta se dogada', 'sto se dogada', 'šta se dešava',
  'ima li ista', 'ima li ista ovih dana', 'ovih dana', 'ovaj tjedan',
  'sta ima ovih dana', 'sto ima ovih dana',
  'sta se dogada ovaj tjedan', 'sto se dogada ovaj tjedan',
  'ima li događ', 'ima li dogadj',
  "what's happening", "what's on", 'whats happening', 'what is happening',
  'what happening', 'what is on', 'whats on',
  'what is going on', 'whats going on', 'going on',
  'happening this week', 'events this week', 'events today', 'events tomorrow',
  // Natural English phrasings that don't use the word "event"
  'anything happening', 'anything going on', 'anything on this',
  'anything on today', 'anything on tonight', 'anything on tomorrow',
  'what to do tonight', 'what to do this',
];
function isEventQuery(msg) {
  const lower = msg.toLowerCase();
  const normalized = normalizeLookup(msg);
  const hasEventStem = EVENT_STEMS.some(s => lower.includes(s) || normalized.includes(normalizeLookup(s)));
  const hasEventPhrase = EVENT_PHRASES.some(p => normalized.includes(normalizeLookup(p)));
  const hasEnglishEventShape =
    ['happening', 'going on', 'what is on', 'whats on', 'what s on'].some(p => normalized.includes(p)) &&
    ['today', 'tonight', 'tomorrow', 'week', 'weekend', 'this evening'].some(w => normalized.includes(w));

  return hasEventStem || hasEventPhrase || hasEnglishEventShape;
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
  'dive', 'snorkel', 'kayak', 'bike', 'rent', 'parking', 'spa', 'wellness',
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
  const normalized = normalizeLookup(msg);
  const tokens = normalized.split(' ').filter(Boolean);
  return WEATHER_QUERY_WORDS.some(word => {
    const lookup = normalizeLookup(word);
    return lookup.includes(' ') ? normalized.includes(lookup) : tokens.includes(lookup);
  });
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

function historyLooksLikeWeather(history) {
  const recent = history.slice(-4);
  return recent.some(msg => {
    const content = String(msg.content || '');
    return content.includes('°C')
      || /weather in brela|forecast for|vrijeme u brelima|prognoza|wetter in brela|meteo a brela|météo à brela/i.test(content);
  });
}

function detectShortReplyLanguage(message, fallbackLang) {
  const normalized = normalizeLookup(message);
  if (normalized === 'da' || normalized === 'ne') return 'hr';
  if (normalized === 'yes' || normalized === 'no' || normalized === 'yep' || normalized === 'nope') return 'en';
  return fallbackLang;
}

function resolveParkingSelection(message, lang, conversationState, history = []) {
  const normalized = normalizeLookup(message);
  if (!['1', '2', '3'].includes(normalized)) return null;

  const awaitingParking = conversationState?.awaiting?.type === 'parking_choice';
  if (!awaitingParking) {
    const lastAssistant = [...history].reverse().find(msg => msg.role === 'assistant' && typeof msg.content === 'string');
    if (!lastAssistant) return null;

    const assistantNorm = normalizeLookup(lastAssistant.content);
    if (!assistantNorm.includes('parking') || !assistantNorm.includes('1') || !assistantNorm.includes('2') || !assistantNorm.includes('3')) {
      return null;
    }
  }

  const map = {
    hr: { '1': 'parking u centru', '2': 'parking blizu plaže', '3': 'parking kod smještaja' },
    en: { '1': 'parking in the center', '2': 'parking near the beach', '3': 'parking near accommodation' },
    de: { '1': 'parken im zentrum', '2': 'parken nahe dem strand', '3': 'parken bei der unterkunft' },
    it: { '1': 'parcheggio in centro', '2': 'parcheggio vicino alla spiaggia', '3': 'parcheggio vicino all alloggio' },
    fr: { '1': 'parking dans le centre', '2': 'parking près de la plage', '3': 'parking près de l hébergement' },
  };
  const selectedMap = map[lang] || map.en;
  return selectedMap[normalized] || null;
}

function resolveFaqSelection(message, conversationState) {
  const normalized = normalizeLookup(message);
  if (conversationState?.awaiting?.type !== 'faq_choice') return null;
  const options = Array.isArray(conversationState.awaiting.options) ? conversationState.awaiting.options : [];
  if (!['1', '2', '3'].includes(normalized)) return null;
  const selected = options[Number(normalized) - 1];
  return selected || null;
}

function cleanMixedLanguageReply(reply, lang) {
  let text = String(reply || '').trim();
  if (!text) return text;

  if (lang === 'en') {
    const replacements = [
      [/\bpla[zž]e?\s+u\s+brelima\b/gi, 'beaches in Brela'],
      [/\bpla[zž]i\s+u\s+brelima\b/gi, 'beaches in Brela'],
      [/\bu\s+brelima\b/gi, 'in Brela'],
      [/\bpla[zž]e\b/gi, 'beaches'],
      [/\bpla[zž]i\b/gi, 'beaches'],
      [/\bpla[zž]a\b/gi, 'beach'],
    ];
    for (const [pattern, replacement] of replacements) {
      text = text.replace(pattern, replacement);
    }
  }

  return text
    .replace(/\s{2,}/g, ' ')
    .replace(/ \./g, '.')
    .replace(/ ,/g, ',')
    .trim();
}

function isWeatherFollowUp(message, conversationState) {
  if (conversationState?.lastTopic !== 'weather' && !conversationState?.lastWeatherIntent) return false;
  const normalized = normalizeLookup(message);
  if (!normalized) return false;
  if (isWeatherQuery(message)) return true;
  if (/\b\d{1,2}\b/.test(normalized)) return true;
  return [
    'a sutra', 'a danas', 'iducih dana', 'sljedecih dana',
    'and tomorrow', 'and today', 'next days',
    'sutra', 'danas', 'tomorrow', 'today',
  ].some(term => normalized.includes(normalizeLookup(term)));
}

function isEventFollowUp(message, conversationState) {
  if (conversationState?.lastTopic !== 'events') return false;
  const normalized = normalizeLookup(message);
  if (!normalized) return false;
  if (isEventQuery(message)) return true;
  if (detectEventPeriod(message)) return true;
  return [
    'ovih dana', 'ovaj tjedan', 'a sutra', 'a danas',
    'this week', 'today', 'tomorrow', 'tonight', 'this weekend',
  ].some(term => normalized.includes(normalizeLookup(term)));
}

function detectWeatherIntent(message, conversationState = {}) {
  const normalized = normalizeLookup(message);
  const tokens = normalized.split(' ').filter(Boolean);
  const hasTerm = term => {
    const lookup = normalizeLookup(term);
    return lookup.includes(' ') ? normalized.includes(lookup) : tokens.includes(lookup);
  };
  const requestedDaysMatch = normalized.match(/\b(\d{1,2})\b/);
  let requestedDays = requestedDaysMatch ? parseInt(requestedDaysMatch[1], 10) : null;

  // phrases like "in 5 days" / "za 4 dana"
  const inDaysMatch = normalized.match(/\b(in|za)\s*(\d{1,2})\s*(day|days|dan|dana)?\b/);
  if (inDaysMatch && !requestedDays) {
    requestedDays = parseInt(inDaysMatch[2], 10);
  }

  // If continuing a weather chat, any number up to 7 defaults to forecast
  const continuingWeather = conversationState.lastTopic === 'weather' || conversationState.lastWeatherIntent;

  const asksTomorrow = ['tomorrow', 'sutra', 'morgen', 'domani', 'demain'].some(hasTerm);
  const asksCurrent = ['today', 'danas', 'heute', 'oggi', 'aujourdhui', 'current', 'now', 'trenutno', 'sada'].some(hasTerm);
  const asksMulti = ['forecast', 'next', 'coming', 'days', 'dana', 'week', 'tjedan', 'tage', 'giorni', 'jours', 'previsioni', 'prognoza'].some(hasTerm);

  if (requestedDays && requestedDays > 5) return { type: 'weather_long', days: requestedDays };
  if ((requestedDays && requestedDays > 1) || asksMulti || (continuingWeather && requestedDays)) {
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

    // Load conversation history + lightweight state
    const conversation = await getConversation(tenant.id, userPhone).catch(() => ({ messages: [], state: {} }));
    const history = Array.isArray(conversation.messages) ? conversation.messages : [];
    let conversationState = normalizeConversationState(conversation.state);
    console.log(`[webhook] history length: ${history.length}`);

    const greetingNorm = lowerMsg
      .replace(/[!?.,;:]*$/, '')
      .replace(/[^a-zčćšžđ\s]/g, '') // strip emojis and non-letter characters
      .replace(/\s+/g, ' ')
      .trim();
    const greetingLang = detectGreetingLanguage(greetingNorm);
    const langSignal = greetingLang
      ? { lang: greetingLang, ambiguous: false }
      : detectLanguageWithConfidence(trimmedMsg);
    // Current message language should win. Short/ambiguous messages inherit chat lang; fallback to EN.
    const lang = langSignal.ambiguous
      ? (conversationState.lastLanguage || currentUser?.language || langSignal.lang || 'en')
      : (langSignal.lang || conversationState.lastLanguage || currentUser?.language || 'en');
    const activeLang = lang;

    const YES_TOKENS = new Set(['da', 'yes', 'y', 'yep', 'oui', 'si']);
    const NO_TOKENS  = new Set(['ne', 'no', 'nope', 'nah', 'non']);

    const persistTurn = async (assistantReply, statePatch = {}) => {
      const nextState = {
        ...conversationState,
        lastLanguage: statePatch.lastLanguage || activeLang,
        ...statePatch,
      };
      await saveConversation(tenant.id, userPhone, {
        messages: [
          ...history,
          { role: 'user', content: trimmedMsg },
          { role: 'assistant', content: assistantReply },
        ],
        state: nextState,
      }).catch(err => console.error('[webhook] saveConversation failed:', err.message));
      conversationState = nextState;
      return nextState;
    };

    // ── CONSENT GATE — highest priority ──────────────────────────────────────
    if (currentUser && Number(currentUser.asked_opt_in) === 1) {
      if (lowerMsg === 'da') {
        await setOptIn(tenant.id, userPhone, 1);
        await setAskedOptIn(tenant.id, userPhone, 0);
        await logMessage(tenant.id, userPhone, trimmedMsg, 'ai', lang).catch(() => {});
        console.log('[webhook] FINAL RESPONSE SENT — consent: opted in');
        return res.send(twiml(OPT_IN_CONFIRM[lang] || OPT_IN_CONFIRM.hr));
      } else if (lowerMsg === 'ne') {
        // Mark explicit opt-out so we don't ask again (opt_in = -1)
        await setOptIn(tenant.id, userPhone, -1);
        await setAskedOptIn(tenant.id, userPhone, 0);
        await logMessage(tenant.id, userPhone, trimmedMsg, 'ai', lang).catch(() => {});
        console.log('[webhook] FINAL RESPONSE SENT — consent: opted out');
        return res.send(twiml(OPT_OUT_CONFIRM[lang] || OPT_OUT_CONFIRM.hr));
      } else {
        console.log('[webhook] FINAL RESPONSE SENT — consent: invalid reply');
        return res.send(twiml(CONSENT_INVALID[lang] || CONSENT_INVALID.hr));
      }
    }

    // ── QUICK YES/NO (outside opt-in flow) ───────────────────────────────────
    if (YES_TOKENS.has(lowerMsg)) {
      const reply = yesReply(activeLang);
      await logMessage(tenant.id, userPhone, trimmedMsg, 'other', activeLang).catch(() => {});
      await persistTurn(reply, { awaiting: null, lastTopic: 'other', lastLanguage: activeLang });
      console.log('[webhook] FINAL RESPONSE SENT — simple YES');
      return res.send(twiml(reply));
    }
    if (NO_TOKENS.has(lowerMsg)) {
      const reply = noReply(activeLang);
      await logMessage(tenant.id, userPhone, trimmedMsg, 'other', activeLang).catch(() => {});
      await persistTurn(reply, { awaiting: null, lastTopic: 'other', lastLanguage: activeLang });
      console.log('[webhook] FINAL RESPONSE SENT — simple NO');
      return res.send(twiml(reply));
    }

    const faqSelection = resolveFaqSelection(trimmedMsg, conversationState);
    const parkingSelection = resolveParkingSelection(trimmedMsg, activeLang, conversationState, history);
    const effectiveMsg = parkingSelection || trimmedMsg;

    if (!parkingSelection && !faqSelection && TRIVIAL.has(lowerMsg)) {
      console.log('[webhook] FINAL RESPONSE SENT — trivial (empty)');
      return res.send(emptyTwiml());
    }

    if (conversationState.awaiting && !faqSelection && !parkingSelection && !/^[1-3]$/.test(normalizeLookup(trimmedMsg))) {
      conversationState = { ...conversationState, awaiting: null };
    }

    if (!parkingSelection && !faqSelection && (SHORT_UNCLEAR.has(lowerMsg) || /^[1-3]$/.test(lowerMsg))) {
      const replyLang = detectShortReplyLanguage(trimmedMsg, lang);
      const reply = unclearReply(replyLang);
      await persistTurn(reply, { awaiting: null, lastTopic: 'fallback', lastLanguage: replyLang });
      await logMessage(tenant.id, userPhone, trimmedMsg, 'fallback', replyLang).catch(() => {});
      console.log('[webhook] FINAL RESPONSE SENT — unclear short reply');
      return res.send(twiml(reply));
    }

    // ── Spam filter ──────────────────────────────────────────────────────────
    if (isSpam(effectiveMsg)) {
      await logMessage(tenant.id, userPhone, trimmedMsg, 'fallback', lang).catch(() => {});
      await persistTurn(fallbackReply(lang), {
        awaiting: null,
        lastTopic: 'fallback',
        lastWeatherIntent: null,
        lastEventPeriod: null,
      });
      console.log(`[webhook] BLOCKED — spam: "${trimmedMsg.slice(0, 40)}"`);
      return res.send(twiml(fallbackReply(lang)));
    }

    const model = tenant.openai_model;

    await setUserLang(tenant.id, userPhone, lang).catch(() => {});

    if (faqSelection) {
      const rawAnswer = faqSelection.answer;
      const answerLang = detectLanguage(rawAnswer);
      let faqReply = rawAnswer;

      if (answerLang !== activeLang) {
        try {
          let aiReply = await rageMessage({
            message: faqSelection.question,
            baseAnswer: rawAnswer,
            history: getLanguageScopedHistory(history, activeLang),
            lang: activeLang,
            systemPrompt: tenant.system_prompt,
            model,
          });
          if (aiReply && detectLanguage(aiReply) !== activeLang) {
            aiReply = await rageMessage({
              message: faqSelection.question,
              baseAnswer: rawAnswer,
              history: [],
              lang: activeLang,
              systemPrompt: tenant.system_prompt,
              model,
            });
          }
          faqReply = cleanMixedLanguageReply(aiReply || rawAnswer, activeLang);
        } catch (e) {
          console.error('[webhook] AI failed (FAQ selection):', e.message);
        }
      }

      faqReply = cleanMixedLanguageReply(faqReply, activeLang);
      await logMessage(tenant.id, userPhone, trimmedMsg, 'faq', activeLang).catch(() => {});
      await persistTurn(faqReply, {
        awaiting: null,
        lastTopic: 'faq',
        lastWeatherIntent: null,
        lastEventPeriod: null,
        lastFaq: {
          question: faqSelection.question,
          answer: rawAnswer,
          link_title: faqSelection.link_title || null,
          link_url: faqSelection.link_url || null,
          link_image: faqSelection.link_image || null,
        },
      });

      console.log('[webhook] FINAL RESPONSE SENT — FAQ selection');
      if (faqSelection.link_url || faqSelection.link_image) {
        return res.send(twimlWithFaqLink(faqReply, faqSelection.link_title, faqSelection.link_url, faqSelection.link_image));
      }
      return res.send(twiml(faqReply));
    }

    // ── STEP 1: GREETING — one-time only, exact match, empty history ─────────
    const EXACT_GREETINGS = new Set(['pozdrav', 'bok', 'hej', 'zdravo', 'dobar dan', 'hello', 'hi', 'hey', 'hallo', 'guten tag', 'ciao', 'buongiorno', 'bonjour', 'salut']);
    if (EXACT_GREETINGS.has(greetingNorm) && history.length === 0) {
      await logMessage(tenant.id, userPhone, trimmedMsg, 'ai', activeLang).catch(() => {});
      const reply = greetingReply(activeLang);
      await persistTurn(reply, {
        awaiting: null,
        lastTopic: 'greeting',
        lastWeatherIntent: null,
        lastEventPeriod: null,
      });
      console.log('[webhook] FINAL RESPONSE SENT — greeting (first message only)');
      return res.send(twiml(reply));
    }

    // ── WEATHER — keyword-detected, API-first, no AI formatting ─────────────
    if (isWeatherQuery(effectiveMsg) || isWeatherFollowUp(effectiveMsg, conversationState) || (historyLooksLikeWeather(history) && /\b\d{1,2}\b/.test(normalizeLookup(effectiveMsg)))) {
      const weatherIntent = detectWeatherIntent(effectiveMsg, conversationState);
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
            await persistTurn(currentLine, {
              awaiting: null,
              lastTopic: 'weather',
              lastWeatherIntent: weatherIntent,
              lastEventPeriod: null,
            });
            console.log('[webhook] FINAL RESPONSE SENT — weather (current)');
            return res.send(twiml(currentLine));
          }
        }

        const forecastUrl = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric&lang=${owLang}`;
        const forecastRes = await fetch(forecastUrl);
        const forecastData = await forecastRes.json();

        if (!forecastRes.ok) {
          const unavailable = FORECAST_UNAVAILABLE[wLang] || FORECAST_UNAVAILABLE.en;
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

        await persistTurn(forecastReply, {
          awaiting: null,
          lastTopic: 'weather',
          lastWeatherIntent: weatherIntent,
          lastEventPeriod: null,
        });

        console.log(`[webhook] FINAL RESPONSE SENT — weather (${weatherIntent.type})`);
        const reply = forecastReply || currentLine || (WEATHER_UNAVAILABLE[wLang] || WEATHER_UNAVAILABLE.en);
        return res.send(twiml(reply));

      } catch (weatherErr) {
        console.error('[webhook] weather fetch exception:', weatherErr.message);
        return res.send(twiml(WEATHER_UNAVAILABLE[wLang] || WEATHER_UNAVAILABLE.en));
      }
    }

    // ── STEP 3: EVENTS — keyword-detected, DB-first, AI format only ──────────
    if (isEventQuery(effectiveMsg) || isEventFollowUp(effectiveMsg, conversationState)) {
      const eventPeriod = detectEventPeriod(effectiveMsg); // today/tomorrow/week/null
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

          await persistTurn(reply, {
            awaiting: null,
            lastTopic: 'events',
            lastEventPeriod: eventPeriod,
            lastWeatherIntent: null,
          });

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

        await persistTurn(noEventsReply, {
          awaiting: null,
          lastTopic: 'events',
          lastEventPeriod: eventPeriod || 'general',
          lastWeatherIntent: null,
        });

        console.log('[webhook] FINAL RESPONSE SENT — events (none found)');
        return res.send(twiml(noEventsReply));
      }

      reply = eventPeriod
        ? formatEventsList(events, eventPeriod, activeLang)
        : formatUpcomingEventsList(events, activeLang);

      await persistTurn(reply, {
        awaiting: null,
        lastTopic: 'events',
        lastEventPeriod: eventPeriod || 'general',
        lastWeatherIntent: null,
      });

      console.log(`[webhook] FINAL RESPONSE SENT — events (${eventPeriod || 'general'}, ${events.length} found)`);
      return res.send(twiml(reply));
    }

    // Generic parking questions should clarify before FAQ matching so the bot
    // doesn't dump a broad answer or the wrong parking link.
    if (needsParkingClarification(effectiveMsg)) {
      const clarifyReply = clarificationReply(effectiveMsg, activeLang);
      await logMessage(tenant.id, userPhone, trimmedMsg, 'faq', activeLang).catch(() => {});
      await persistTurn(clarifyReply, {
        awaiting: { type: 'parking_choice' },
        lastTopic: 'parking',
        lastWeatherIntent: null,
        lastEventPeriod: null,
      });

      console.log('[webhook] FINAL RESPONSE SENT — parking clarification');
      return res.send(twiml(clarifyReply));
    }

    // ── STEP 2: FAQ — database first, AI polish only ─────────────────────────
    const faqMatch = await getFaqMatch(tenant.id, effectiveMsg).catch(() => null);
    if (faqMatch?.matchType === 'clarify') {
      const clarifyReply = formatFaqClarifyReply(faqMatch.options || [], activeLang);

      await logMessage(tenant.id, userPhone, trimmedMsg, 'faq', activeLang).catch(() => {});
      await persistTurn(clarifyReply, {
        awaiting: {
          type: 'faq_choice',
          options: (faqMatch.options || []).map(option => ({
            question: option.question,
            answer: option.answer,
            link_title: option.link_title || null,
            link_url: option.link_url || null,
            link_image: option.link_image || null,
          })),
        },
        lastTopic: 'faq',
        lastWeatherIntent: null,
        lastEventPeriod: null,
      });

      console.log('[webhook] FINAL RESPONSE SENT — FAQ clarification');
      return res.send(twiml(clarifyReply));
    }

    if (faqMatch?.matchType === 'strong') {
      // FAQ is the source of truth — AI only polishes the wording
      const rawAnswer = faqMatch.answer;
      const answerLang = detectLanguage(rawAnswer);
      let faqReply = rawAnswer;

      if (answerLang !== activeLang) {
        try {
          let aiReply = await rageMessage({
            message: effectiveMsg,
            baseAnswer: rawAnswer,
            history: getLanguageScopedHistory(history, activeLang),
            lang: activeLang,
            systemPrompt: tenant.system_prompt,
            model,
          });
          if (aiReply && detectLanguage(aiReply) !== activeLang) {
            aiReply = await rageMessage({
              message: effectiveMsg,
              baseAnswer: rawAnswer,
              history: [],
              lang: activeLang,
              systemPrompt: tenant.system_prompt,
              model,
            });
          }
          faqReply = cleanMixedLanguageReply(aiReply || rawAnswer, activeLang);
        } catch (e) {
          console.error('[webhook] AI failed (FAQ):', e.message);
        }
      }
      faqReply = cleanMixedLanguageReply(faqReply, activeLang);

      await logMessage(tenant.id, userPhone, trimmedMsg, 'faq', activeLang).catch(() => {});
      await persistTurn(faqReply, {
        awaiting: null,
        lastTopic: 'faq',
        lastWeatherIntent: null,
        lastEventPeriod: null,
        lastFaq: {
          question: faqMatch.question,
          answer: rawAnswer,
          link_title: faqMatch.link_title || null,
          link_url: faqMatch.link_url || null,
          link_image: faqMatch.link_image || null,
        },
      });

      // Consent trigger
      const shouldAskConsent = (
        currentUser &&
        currentUser.opt_in === 0 &&            // only if not opted in or explicitly opted out
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

    if (isSpecificParkingQuestion(effectiveMsg)) {
      const parkingReply = parkingFallbackReply(activeLang);
      await logMessage(tenant.id, userPhone, trimmedMsg, 'faq', activeLang).catch(() => {});
      await persistTurn(parkingReply, {
        awaiting: null,
        lastTopic: 'parking',
        lastWeatherIntent: null,
        lastEventPeriod: null,
      });

      console.log('[webhook] FINAL RESPONSE SENT — parking specific fallback');
      return res.send(twiml(parkingReply));
    }

    // ── STEPS 4+5: RELEVANCE FILTER (follow-ups bypass it) ───────────────────
    const followUp = isFollowUp(trimmedMsg) || Boolean(parkingSelection);
    if (!followUp && !isRelevant(effectiveMsg)) {
      await logMessage(tenant.id, userPhone, trimmedMsg, 'fallback', activeLang).catch(() => {});
      await persistTurn(offTopicReply(activeLang), {
        awaiting: null,
        lastTopic: 'fallback',
        lastWeatherIntent: null,
        lastEventPeriod: null,
      });
      console.log(`[webhook] FINAL RESPONSE SENT — off-topic: "${trimmedMsg.slice(0, 40)}"`);
      return res.send(twiml(offTopicReply(activeLang)));
    }

    // ── Rate limit ───────────────────────────────────────────────────────────
    const usage = await checkAndIncrementUsage(tenant.id, userPhone);
    if (!usage.allowed) {
      await logMessage(tenant.id, userPhone, trimmedMsg, 'fallback', activeLang).catch(() => {});
      await persistTurn(fallbackReply(activeLang), {
        awaiting: null,
        lastTopic: 'fallback',
        lastWeatherIntent: null,
        lastEventPeriod: null,
      });
      console.log('[webhook] FINAL RESPONSE SENT — rate limited');
      return res.send(twiml(fallbackReply(activeLang)));
    }

    // ── STEP 6: AI FALLBACK — tourism questions not covered by DB ────────────
    const scopedHistory = getLanguageScopedHistory(history, activeLang);
    let aiReply = null;
    try {
      aiReply = await rageMessage({
        message: effectiveMsg,
        history: scopedHistory,
        lang: activeLang,
        systemPrompt: tenant.system_prompt,
        model,
      });

      if (aiReply && detectLanguage(aiReply) !== activeLang) {
        aiReply = await rageMessage({
          message: effectiveMsg,
          history: [],
          lang: activeLang,
          systemPrompt: tenant.system_prompt,
          model,
        });
      }
      aiReply = cleanMixedLanguageReply(aiReply, activeLang);
    } catch (e) {
      console.error('[webhook] AI failed (general):', e.message);
    }

    // STEP 8: Final fallback — only if AI fails
    const reply = aiReply || fallbackReply(activeLang);

    // Persist conversation history
    await persistTurn(reply, {
      awaiting: null,
      lastTopic: aiReply ? 'ai' : 'fallback',
      lastWeatherIntent: null,
      lastEventPeriod: null,
    });
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
