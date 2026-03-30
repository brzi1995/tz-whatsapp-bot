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

module.exports = { chat };
