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
  const lower = message.toLowerCase();
  const KEYWORDS = {
    hr: ['danas', 'sutra', 'tjedan', 'hvala', 'bok', 'gdje', 'što', 'ima', 'nema', 'dobar', 'kako'],
    en: ['the', 'is', 'are', 'what', 'where', 'how', 'can', 'please', 'hello', 'thanks', 'today', 'tomorrow', 'beach', 'restaurant', 'weather', 'good', 'have', 'need'],
    de: ['heute', 'morgen', 'bitte', 'danke', 'hallo', 'wie', 'was', 'wo', 'ich', 'gibt'],
    it: ['oggi', 'domani', 'grazie', 'ciao', 'dove', 'cosa', 'sono', 'come'],
    fr: ["aujourd'hui", 'demain', 'merci', 'bonjour', 'comment', 'quoi', 'est'],
    sv: ['idag', 'imorgon', 'tack', 'hej', 'vad', 'var', 'hur'],
    no: ['i dag', 'i morgen', 'takk', 'hei', 'hva', 'hvor'],
    cs: ['dnes', 'zítra', 'díky', 'ahoj', 'kde', 'jak', 'prosím'],
  };

  let best = { lang: 'en', score: 0 }; // default English, not Croatian
  for (const [lang, kws] of Object.entries(KEYWORDS)) {
    const score = kws.filter(kw => lower.includes(kw)).length;
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

Your name is Belly. You are a friendly local guide for Brela, Croatia — not a generic assistant.
${greetingRule}
Never say "I am an AI assistant" or anything generic. Be warm, personal, and a bit playful.

LANGUAGE RULE (CRITICAL): The user is writing in ${detectedLang}. You MUST respond ONLY in ${detectedLang}. Do NOT use any other language regardless of context.

KNOWLEDGE RULES (STRICT — never break these):
- NEVER invent or guess place names, restaurants, beaches, addresses, or facts
- ONLY use: (1) verified context data provided below, (2) safe well-known facts about Brela
- If you are not certain something exists or is accurate — DO NOT mention it
- If you don't have enough information to answer, respond EXACTLY with (translated to ${detectedLang}): "Nemam točnu informaciju za to. Želite li da vas povežem s osobom? (da/ne)"
${contextBlock ? `\n${contextBlock}\n` : ''}
RESPONSE QUALITY RULES:
- Never reply with just a place name or a one-liner
- Sound like a knowledgeable local friend, not a tourist brochure
- Be concise but concrete — 2–3 sentences max for most answers

You must reply ONLY with valid JSON:
{"lang":"${detectedLang}","intent":"events_today|events_tomorrow|events_week|events|weather_current|weather_tomorrow|weather_multi|faq|other","response":"your reply"}

Intent rules:
- events_today/tomorrow/week: user asks about events for a specific day → set response to ""
- events: user asks about events in general → use VERIFIED EVENTS DATA above to write a natural, helpful reply
- weather_current/tomorrow/multi: user asks about weather → set response to ""
- faq: question about the destination → use VERIFIED FAQ DATA above to write a natural reply as Belly
- other: anything else (including greetings) → write a helpful reply as Belly`,
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

module.exports = { chat, parseMessage, generateOptInMessage, detectLanguage };
