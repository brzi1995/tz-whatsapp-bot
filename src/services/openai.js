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
 * Single AI call: detects language + intent AND generates the reply.
 * For event/weather intents the caller uses DB/API instead of response.
 * Falls back to { lang: 'hr', intent: 'other', response: '' } on any failure.
 *
 * @param {string} message       - Raw user message
 * @param {string} systemPrompt  - Tenant system prompt (sets bot personality)
 * @param {string} model         - OpenAI model ID
 * @returns {{ lang, intent, response }}
 */
async function parseMessage(message, systemPrompt, model = 'gpt-4o-mini') {
  try {
    const result = await getClient().chat.completions.create({
      model,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `${systemPrompt}

You must reply ONLY with valid JSON:
{"lang":"hr|en|de|it|fr|sv|no|cs","intent":"events_today|events_tomorrow|events_week|events|weather_current|weather_tomorrow|weather_multi|faq|other","response":"your reply"}

Intent rules:
- events_today/tomorrow/week: user asks about events for a specific day → set response to ""
- events: user asks about events in general (no specific time) → set response to ""
- weather_current/tomorrow/multi: user asks about weather → set response to ""
- faq: question about the destination → write a helpful reply
- other: anything else → write a helpful reply

Always reply in the same language as the user.`,
        },
        {
          role: 'user',
          content: message,
        },
      ],
    });
    const parsed = JSON.parse(result.choices[0].message.content.trim());
    return {
      lang:     VALID_LANGS.includes(parsed.lang)     ? parsed.lang   : 'hr',
      intent:   VALID_INTENTS.includes(parsed.intent) ? parsed.intent : 'other',
      response: typeof parsed.response === 'string'   ? parsed.response : '',
    };
  } catch (err) {
    console.error('[openai] parseMessage failed:', err.message);
    return { lang: 'hr', intent: 'other', response: '' };
  }
}

module.exports = { chat, parseMessage };
