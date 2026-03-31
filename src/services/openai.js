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

const VALID_LANGS   = ['hr','en','de','it','fr'];
const VALID_INTENTS = [
  'weather_current','weather_tomorrow','weather_multi',
  'events_today','events_tomorrow','events_week','events',
  'faq','other',
];

/**
 * Single AI call that returns both detected language and intent.
 * Falls back to { lang: 'en', intent: 'other' } on any failure.
 */
async function parseMessage(message, model = 'gpt-4o-mini') {
  try {
    const response = await getClient().chat.completions.create({
      model,
      response_format: { type: 'json_object' },
      messages: [{
        role: 'user',
        content: `Detect the language and intent of this tourist message. Return JSON only.

{"lang":"hr|en|de|it|fr","intent":"weather_current|weather_tomorrow|weather_multi|events_today|events_tomorrow|events_week|events|faq|other"}

Intent rules:
- events_today: what to do today / today's events / što raditi danas / eventi oggi / Veranstaltungen heute
- events_tomorrow: what to do tomorrow / tomorrow's events / što raditi sutra / domani / morgen
- events_week: this week / weekend events / ovaj tjedan / diese Woche / cette semaine
- events: events in general (no specific time)
- weather_current: current weather now
- weather_tomorrow: tomorrow's weather forecast
- weather_multi: multi-day weather forecast
- faq: general question about the destination
- other: anything else

Message: ${message}`,
      }],
    });
    const parsed = JSON.parse(response.choices[0].message.content.trim());
    return {
      lang:   VALID_LANGS.includes(parsed.lang)     ? parsed.lang   : 'hr',
      intent: VALID_INTENTS.includes(parsed.intent) ? parsed.intent : 'other',
    };
  } catch (err) {
    console.error('[openai] parseMessage failed:', err.message);
    return { lang: 'en', intent: 'other' };
  }
}

module.exports = { chat, parseMessage };
