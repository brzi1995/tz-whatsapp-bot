const twilio = require('twilio');

let client;
function getClient() {
  if (!client) client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return client;
}

/**
 * Send a WhatsApp message via Twilio REST API.
 * Both `to` and `from` must be in "whatsapp:+..." format.
 */
async function sendMessage(to, from, body) {
  return getClient().messages.create({ to, from, body });
}

/**
 * Validate that an incoming request genuinely came from Twilio.
 * Returns true (skip validation) if TWILIO_AUTH_TOKEN is not configured,
 * to prevent crashes when env vars fail to load.
 */
function validateWebhook(req) {
  if (!process.env.TWILIO_AUTH_TOKEN) {
    console.warn('[twilio] TWILIO_AUTH_TOKEN not set — skipping signature validation');
    return true;
  }
  const signature = req.headers['x-twilio-signature'];
  const url = process.env.WEBHOOK_BASE_URL + req.originalUrl;
  return twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    req.body
  );
}

module.exports = { sendMessage, validateWebhook };
