const express = require('express');
const router = express.Router();
const { getTenant, getMessages, saveMessages } = require('../db/sessions');
const { chat } = require('../services/openai');
const { sendMessage, validateWebhook } = require('../services/twilio');

/**
 * POST /whatsapp/webhook
 *
 * Twilio sends a form-encoded POST with at minimum:
 *   From  - sender's WhatsApp number, e.g. "whatsapp:+385912345678"
 *   To    - your Twilio WhatsApp number, e.g. "whatsapp:+38512345678"
 *   Body  - the message text
 *
 * The tenant is identified by the `To` number, so each tourist board
 * gets its own Twilio number pointing to this same webhook.
 */
router.post('/webhook', async (req, res) => {
  if (process.env.NODE_ENV === 'production' && !validateWebhook(req)) {
    return res.status(403).send('Forbidden');
  }

  // Respond to Twilio immediately — it retries if it doesn't get 200 quickly
  res.sendStatus(200);

  const { From: userPhone, To: tenantPhone, Body: userMsg } = req.body;

  if (!userMsg?.trim() || !userPhone || !tenantPhone) return;

  try {
    const tenant = await getTenant(tenantPhone);
    if (!tenant) {
      console.warn(`[webhook] No tenant configured for number: ${tenantPhone}`);
      return;
    }

    const messages = await getMessages(tenant.id, userPhone);
    messages.push({ role: 'user', content: userMsg.trim() });

    const reply = await chat(tenant.system_prompt, messages, tenant.openai_model);
    messages.push({ role: 'assistant', content: reply });

    await saveMessages(tenant.id, userPhone, messages);
    await sendMessage(userPhone, tenantPhone, reply);
  } catch (err) {
    console.error('[webhook] Error processing message:', err);
  }
});

module.exports = router;
