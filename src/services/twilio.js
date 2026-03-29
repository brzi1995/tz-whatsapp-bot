const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/**
 * Send a WhatsApp message via Twilio REST API.
 * Both `to` and `from` must be in "whatsapp:+..." format.
 */
async function sendMessage(to, from, body) {
  return client.messages.create({ to, from, body });
}

/**
 * Validate that an incoming request genuinely came from Twilio.
 * Should be called in production before processing any webhook.
 */
function validateWebhook(req) {
  const signature = req.headers['x-twilio-signature'];
  // WEBHOOK_BASE_URL must match exactly the URL configured in Twilio console
  const url = process.env.WEBHOOK_BASE_URL + req.originalUrl;
  return twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    req.body
  );
}

module.exports = { sendMessage, validateWebhook };
