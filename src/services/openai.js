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

const LANG_NAMES = { en: 'English', de: 'German', it: 'Italian', fr: 'French', hr: 'Croatian' };

/**
 * Translate text to the target language using OpenAI.
 * Returns the original text unchanged when langCode is 'hr'.
 */
async function translate(text, langCode, model = 'gpt-4o-mini') {
  if (langCode === 'hr') return text;
  const lang = LANG_NAMES[langCode] || langCode;
  const response = await getClient().chat.completions.create({
    model,
    messages: [
      { role: 'system', content: `Translate the following text to ${lang}. Return only the translated text, preserving any URLs and numbers exactly as they are.` },
      { role: 'user', content: text },
    ],
  });
  return response.choices[0].message.content.trim();
}

module.exports = { chat, translate };
