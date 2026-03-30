const express = require('express');
const router = express.Router();
const { getTenant, getMessages, saveMessages } = require('../db/sessions');
const { chat } = require('../services/openai');
const { sendMessage, validateWebhook } = require('../services/twilio');

router.post('/webhook', async (req, res) => {
  console.log('[webhook] incoming body:', JSON.stringify(req.body));

  // Acknowledge immediately — Twilio retries if it doesn't get 200 quickly
  res.status(200).end();

  try {
    if (process.env.NODE_ENV === 'production' && !validateWebhook(req)) {
      console.warn('[webhook] signature validation failed');
      return;
    }

    const { From: userPhone, To: tenantPhone, Body: userMsg } = req.body || {};
    console.log(`[webhook] From=${userPhone} To=${tenantPhone} Body="${userMsg}"`);

    if (!userMsg?.trim() || !userPhone || !tenantPhone) {
      console.warn('[webhook] missing required fields, ignoring');
      return;
    }

    const tenant = await getTenant(tenantPhone);
    if (!tenant) {
      console.warn(`[webhook] no tenant configured for number: ${tenantPhone}`);
      return;
    }
    console.log(`[webhook] tenant matched: ${tenant.name} | prompt length: ${tenant.system_prompt?.length ?? 0} | preview: "${tenant.system_prompt?.substring(0, 80)}"`);

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
