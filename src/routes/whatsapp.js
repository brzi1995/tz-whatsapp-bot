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
  console.log('[webhook] incoming request body:', JSON.stringify(req.body));

  if (process.env.NODE_ENV === 'production' && !validateWebhook(req)) {
    console.warn('[webhook] signature validation failed');
    return res.status(403).send('Forbidden');
  }

  // Respond to Twilio immediately — it retries if it doesn't get 200 quickly
  res.sendStatus(200);

  const { From: userPhone, To: tenantPhone, Body: userMsg } = req.body;
  console.log(`[webhook] From=${userPhone} To=${tenantPhone} Body="${userMsg}"`);

  if (!userMsg?.trim() || !userPhone || !tenantPhone) {
    console.warn('[webhook] missing required fields, ignoring');
    return;
  }

  try {
    const tenant = await getTenant(tenantPhone);
    if (!tenant) {
      console.warn(`[webhook] no tenant configured for number: ${tenantPhone}`);
      return;
    }
    console.log(`[webhook] tenant matched: ${tenant.name}`);

    const messages = await getMessages(tenant.id, userPhone);
    messages.push({ role: 'user', content: userMsg.trim() });

    const reply = await chat(tenant.system_prompt, messages, tenant.openai_model);
    console.log(`[webhook] OpenAI reply: "${reply}"`);
    messages.push({ role: 'assistant', content: reply });

    await saveMessages(tenant.id, userPhone, messages);
    await sendMessage(userPhone, tenantPhone, reply);
    console.log(`[webhook] message sent to ${userPhone}`);
  } catch (err) {
    console.error('[webhook] error:', err.message);
    console.error(err.stack);
  }
});

module.exports = router;
