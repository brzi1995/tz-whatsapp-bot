const OpenAI = require('openai');

// Instantiated lazily so a missing key doesn't crash the server at startup
let client;
function getClient() {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

/**
 * Send a conversation to OpenAI and return the assistant's reply.
 * @param {string} systemPrompt  - Tenant-specific system prompt
 * @param {Array}  messages      - Conversation history [{role, content}, ...]
 * @param {string} model         - OpenAI model ID (from tenant config)
 */
async function chat(systemPrompt, messages, model = 'gpt-4o-mini') {
  const response = await getClient().chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
  });
  return response.choices[0].message.content.trim();
}

const VALID_LANGS   = ['hr', 'en', 'de', 'it', 'fr', 'sv', 'no', 'cs'];
const VALID_INTENTS = [
  'weather_current', 'weather_tomorrow', 'weather_multi',
  'events_today', 'events_tomorrow', 'events_week', 'events',
  'faq', 'other',
];

/**
 * Heuristic language detection from the current message only.
 * Checked before every AI call — never persisted, never reused across messages.
 * Priority: unique character sets first, then keyword scoring.
 * Defaults to 'en' (not 'hr') so ambiguous Latin text isn't misread as Croatian.
 *
 * @param {string} message
 * @returns {string} ISO 639-1 code
 */
function detectLanguage(message) {
  const normalized = String(message || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Croatian-specific characters — highest confidence signal
  if (/[đšžćčĐŠŽĆČ]/.test(message)) return 'hr';
  // German-specific
  if (/[äöüÄÖÜß]/.test(message)) return 'de';
  // French-specific (ç, circumflex, œ, ë) — check before Italian
  if (/[çâêîôûœæëÇÂÊÎÔÛŒÆ]/.test(message)) return 'fr';
  // Swedish/Norwegian-specific
  if (/[åÅ]/.test(message)) {
    // å appears in both — differentiate by keywords
    if (/\b(hei|takk|ikke|hvor)\b/i.test(message)) return 'no';
    return 'sv';
  }
  // Czech-specific
  if (/[řůŘŮ]/.test(message)) return 'cs';

  // Keyword scoring for plain Latin script — default wins at score 0
  const tokens = normalized.split(' ').filter(Boolean);
  const KEYWORDS = {
    hr: ['danas', 'sutra', 'tjedan', 'hvala', 'bok', 'gdje', 'sto', 'sta', 'ima', 'nema', 'dobar', 'kako', 'dogadaj', 'dogadaja', 'vrijeme', 'plaza', 'parking', 'restoran', 'smjestaj', 'izlet', 'uvala', 'brela'],
    en: ['what', 'where', 'how', 'can', 'please', 'hello', 'thanks', 'today', 'tomorrow', 'week', 'happening', 'events', 'beach', 'restaurant', 'weather', 'parking', 'rent', 'kayak', 'prices', 'locations'],
    de: ['heute', 'morgen', 'bitte', 'danke', 'hallo', 'wie', 'was', 'wo', 'ich', 'gibt', 'veranstaltungen', 'wetter', 'strand', 'parken', 'restaurant'],
    it: ['oggi', 'domani', 'grazie', 'ciao', 'dove', 'cosa', 'sono', 'come', 'eventi', 'parcheggio', 'spiaggia', 'tempo', 'ristorante'],
    fr: ['aujourdhui', 'demain', 'merci', 'bonjour', 'comment', 'quoi', 'evenements', 'plage', 'meteo', 'parking', 'restaurant'],
    sv: ['idag', 'imorgon', 'tack', 'hej', 'vad', 'var', 'hur', 'evenemang'],
    no: ['i dag', 'i morgen', 'takk', 'hei', 'hva', 'hvor', 'arrangementer'],
    cs: ['dnes', 'zitra', 'diky', 'ahoj', 'kde', 'jak', 'prosim', 'akce'],
  };

  let best = { lang: 'en', score: 0 }; // default English, not Croatian
  for (const [lang, kws] of Object.entries(KEYWORDS)) {
    const score = kws.reduce((total, kw) => {
      if (kw.includes(' ')) return total + (normalized.includes(kw) ? 2 : 0);
      return total + (tokens.includes(kw) ? 2 : normalized.includes(kw) ? 1 : 0);
    }, 0);
    if (score > best.score) best = { lang, score };
  }
  return best.lang;
}

/**
 * Single AI call: detects language + intent AND generates the reply.
 * detectLanguage() runs first so the heuristic lang is always available as
 * fallback — even if OpenAI fails or returns an unexpected lang value.
 *
 * @param {string} message       - Raw user message
 * @param {string} systemPrompt  - Tenant system prompt (sets bot personality)
 * @param {string} model         - OpenAI model ID
 * @returns {{ lang, intent, response }}
 */
async function parseMessage(message, systemPrompt, model = 'gpt-4o-mini', history = [], context = {}) {
  // Run heuristic BEFORE the try block so it's available in the catch fallback
  const detectedLang = detectLanguage(message);

  // Greeting instruction only shown when there is no prior history
  const greetingRule = history.length === 0
    ? 'When a tourist greets you (hello, hi, bok, zdravo, hallo, ciao, hej, bonjour, etc.), introduce yourself as Belly and warmly invite them to ask anything. Keep it short and natural — like a local who loves showing people around.'
    : 'The conversation is already in progress. Do NOT re-introduce yourself. Answer the user\'s question directly.';

  const { faqContext, eventContext } = context;
  const contextBlock = [
    faqContext   ? `VERIFIED FAQ DATA (use this verbatim as the basis for your answer — do NOT deviate):\n${faqContext}`   : '',
    eventContext ? `VERIFIED EVENTS DATA (mention these specifically — do not add events not listed here):\n${eventContext}` : '',
  ].filter(Boolean).join('\n\n');

  try {
    const result = await getClient().chat.completions.create({
      model,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `${systemPrompt}

You are a local tourism assistant for Brela, Croatia. Your only job is to help tourists with questions about Brela.
${greetingRule}

LANGUAGE RULE (CRITICAL):
- Always respond in the SAME language as the user's current message
- If language is unclear or message is very short, check the conversation history for the last clear language used
- If still unclear, default to ENGLISH
- NEVER mix languages in one response
- Ignore earlier messages written in other languages when answering the current message
- Current message language detected: ${detectedLang}
${contextBlock ? `\n${contextBlock}\n` : ''}
DATA PRIORITY:
1. VERIFIED EVENTS DATA (only for event-related questions or clear event follow-ups)
2. VERIFIED FAQ DATA (use verbatim facts)
3. Well-known facts about Brela (last resort)

KNOWLEDGE RULES:
- NEVER invent place names, restaurants, beaches, addresses, events, or facts
- ONLY use: (1) verified context data above, (2) well-known facts about Brela
- If VERIFIED EVENTS DATA is provided but the user is not asking about events, ignore it
- If information is missing from context and not a well-known Brela fact, say briefly in the user's language that you do not currently have that information
- If the user asks for more details and you have a relevant answer, you may include: https://brela.hr/

RESPONSE STYLE:
- Short, natural, direct — 2–3 sentences max
- No filler phrases: never use "slobodno pitaj", "tu sam za tebe", "ako treba još", "ne oklijevaj", "stojim na raspolaganju"
- BAD: "There are several parking options available in the area."
- GOOD: "Parking je kod Punta Rata i uz cestu iznad plaža — u sezoni se brzo popuni, bolje doći ranije."

You must reply ONLY with valid JSON:
{"lang":"${detectedLang}","intent":"events_today|events_tomorrow|events_week|events|weather_current|weather_tomorrow|weather_multi|faq|other","response":"your reply"}

Intent rules:
- events_today/tomorrow/week: user asks about events for a specific day → set response to ""
- events: user asks about events in general → use VERIFIED EVENTS DATA above to write a natural, helpful reply
- weather_current/tomorrow/multi: user asks about weather → set response to ""
- faq: question about the destination → use VERIFIED FAQ DATA above to write a natural, conversational reply
- other: anything else (greetings, unclear questions, small talk) → write a helpful, friendly reply`,
        },
        ...history,
        {
          role: 'user',
          content: `User message (${detectedLang}): ${message}`,
        },
      ],
    });
    const parsed = JSON.parse(result.choices[0].message.content.trim());
    return {
      lang:     VALID_LANGS.includes(parsed.lang)     ? parsed.lang     : detectedLang,
      intent:   VALID_INTENTS.includes(parsed.intent) ? parsed.intent   : 'other',
      response: typeof parsed.response === 'string'   ? parsed.response : '',
    };
  } catch (err) {
    console.error('[openai] parseMessage failed:', err.message);
    return { lang: detectedLang, intent: 'other', response: '' };
  }
}

/**
 * Generate a short opt-in notification message in the user's language.
 * Instructs the user to reply DA (yes) or NE (no) — those words are what
 * the webhook handler checks for, so they must stay fixed.
 * Falls back to Croatian if OpenAI is unavailable.
 *
 * @param {string} lang  ISO 639-1 code detected from the user's messages
 * @returns {Promise<string>}
 */
async function generateOptInMessage(lang = 'hr') {
  try {
    const result = await getClient().chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            `You are a friendly WhatsApp tourist bot assistant. ` +
            `Write a single short message (2 sentences max) asking the tourist if they want to receive event notifications. ` +
            `Write it entirely in the language with ISO 639-1 code "${lang}". ` +
            `The message must end by asking them to reply with exactly "DA" or "NE" — keep those two words unchanged. ` +
            `Use a friendly emoji. Return ONLY the message text, nothing else.`,
        },
        { role: 'user', content: 'Write the opt-in message.' },
      ],
    });
    return result.choices[0].message.content.trim();
  } catch (err) {
    console.error('[openai] generateOptInMessage failed:', err.message);
    return 'Ako želiš, mogu ti slati obavijesti o događajima 😊\nNapiši DA ili NE';
  }
}

/**
 * Polish/format pre-fetched data or generate a contextual reply.
 * Returns just the reply string — no intent detection, no JSON parsing.
 * Used for FAQ polishing, event formatting, and AI fallback responses.
 *
 * @param {Object} opts
 * @param {string} opts.message        - User message (or formatting instruction for events)
 * @param {string} [opts.baseAnswer]   - Verified FAQ answer to rephrase naturally
 * @param {Array}  [opts.history]      - Conversation history [{role,content},...]
 * @param {string} [opts.faqContext]   - Raw FAQ data as additional context
 * @param {string} [opts.eventContext] - Pre-formatted events string (no AI additions allowed)
 * @param {string} [opts.lang]         - ISO 639-1 language code for response
 * @param {string} [opts.systemPrompt] - Tenant system prompt (bot personality)
 * @param {string} [opts.model]        - OpenAI model ID
 * @returns {Promise<string>}
 */
async function rageMessage({ message, baseAnswer, history = [], faqContext, eventContext, lang = 'en', systemPrompt = '', model = 'gpt-4o-mini' }) {
  const contextParts = [];
  if (baseAnswer) {
    contextParts.push(`VERIFIED ANSWER (rephrase naturally in ${lang} — keep ALL facts exact, do NOT change any detail):\n${baseAnswer}`);
  }
  if (faqContext) {
    contextParts.push(`VERIFIED FAQ DATA (use these facts verbatim — do not deviate, do not add information):\n${faqContext}`);
  }
  if (eventContext) {
    contextParts.push(`VERIFIED EVENTS — use these only for event-related questions or clear event follow-ups. Do not invent, change, or hide details:\n${eventContext}`);
  }

  const sysContent = [
    systemPrompt,
    'You are Belly, a local tourism assistant for Brela, Croatia.',
    `CRITICAL: Respond ONLY in ${lang}. Never mix languages. Never switch to another language.`,
    'Ignore previous messages written in other languages. Reply only in the language of the current user message.',
    'DATA PRIORITY — use this order only when the data is relevant to the user message:',
    '  1. VERIFIED EVENTS DATA (for event-related questions only)',
    '  2. VERIFIED FAQ DATA (use verbatim facts only)',
    '  3. Well-known general facts about Brela (last resort)',
    'Ignore VERIFIED EVENTS DATA when the user is not asking about events.',
    'MISSING INFO RULE: If the answer is not in the provided context and is not a well-known fact about Brela, say briefly in the user language that you do not currently have that information.',
    'MORE INFO RULE: If the user asks for more details and you have a relevant answer, you may include this link: https://brela.hr/',
    'NEVER invent event names, dates, links, addresses, or facts not present in the verified context.',
    'STYLE: Short and natural. WhatsApp-friendly. Bullet points for lists. 2–3 sentences max for most answers.',
    'Do NOT re-introduce yourself. Do NOT greet. Answer directly.',
    'PROHIBITED phrases (never use these): "slobodno pitaj", "tu sam za tebe", "ako treba još", "ako imaš pitanja", "ne oklijevaj", "tu smo za tebe", "stojim na raspolaganju".',
    contextParts.length ? '\n' + contextParts.join('\n\n') : '',
  ].filter(Boolean).join('\n');

  const messages = [
    ...history.slice(-10),
    { role: 'user', content: message },
  ];

  return chat(sysContent, messages, model);
}

module.exports = { chat, parseMessage, generateOptInMessage, detectLanguage, rageMessage };
