const express = require('express');
const router = express.Router();
const { getTenant, getMessages, saveMessages } = require('../db/sessions');
const { chat } = require('../services/openai');
const { logMessage, getFaqMatch, getUpcomingEvents, checkAndIncrementUsage } = require('../db/bot');

const MULTILINGUAL_PROMPT = `You are a multilingual tourist assistant in Croatia.
Always reply in the same language as the user.
Support all languages naturally (English, German, Italian, Croatian).
Be short, clear, and helpful.`;

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function twiml(message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`;
}

function emptyTwiml() {
  return '<?xml version="1.0" encoding="UTF-8\"?><Response></Response>';
}

// Send raw context data to OpenAI; it detects language and formats the reply.
async function formatReply(context, userMsg, model) {
  return chat(
    `${MULTILINGUAL_PROMPT}\n\n${context}`,
    [{ role: 'user', content: userMsg }],
    model
  );
}

router.post('/webhook', async (req, res) => {
  console.log('[webhook] incoming body:', JSON.stringify(req.body));
  res.type('text/xml');

  try {
    // 1. Extract fields
    const { From: userPhone, To: tenantPhone, Body: userMsg } = req.body || {};
    console.log(`[webhook] From=${userPhone} To=${tenantPhone} Body="${userMsg}"`);

    // 2. Validate fields
    if (!userMsg?.trim() || !userPhone || !tenantPhone) {
      console.warn('[webhook] missing required fields');
      return res.send(emptyTwiml());
    }

    // 3. Resolve tenant
    const tenant = await getTenant(tenantPhone);
    if (!tenant) {
      console.warn(`[webhook] no tenant for number: ${tenantPhone}`);
      return res.send(emptyTwiml());
    }
    console.log(`[webhook] tenant: ${tenant.name} | prompt length: ${tenant.system_prompt?.length ?? 0}`);

    const trimmedMsg = userMsg.trim();
    const model = tenant.openai_model;

    // 4. Human takeover — agent is handling this conversation manually
    if (tenant.human_takeover) {
      console.log(`[webhook] human_takeover active for tenant ${tenant.id} — silencing bot`);
      await logMessage(tenant.id, userPhone, trimmedMsg, 'ai');
      return res.send(emptyTwiml());
    }

    // 5. FAQ check
    const faqAnswer = await getFaqMatch(tenant.id, trimmedMsg);
    if (faqAnswer) {
      await logMessage(tenant.id, userPhone, trimmedMsg, 'faq');
      const reply = await formatReply(`Answer the user's question using this information:\n${faqAnswer}`, trimmedMsg, model);
      console.log(`[webhook] FAQ reply: "${reply}"`);
      return res.send(twiml(reply));
    }

    // 6. Weather check
    const msgLower = trimmedMsg.toLowerCase();

    const daysMatch = msgLower.match(/(\d+)\s*dana/);
    const requestedDays = daysMatch ? parseInt(daysMatch[1], 10) : 0;

    const isMultiDay = requestedDays > 0;
    const isForecast = !isMultiDay && (msgLower.includes('sutra') || msgLower.includes('prognoza'));
    const isWeather  = !isMultiDay && !isForecast && msgLower.includes('vrijeme');

    if (isMultiDay || isForecast || isWeather) {
      await logMessage(tenant.id, userPhone, trimmedMsg, 'weather');

      const apiKey = process.env.OPENWEATHER_API_KEY;
      console.log(`[webhook] OPENWEATHER_API_KEY loaded: ${apiKey ? 'yes (' + apiKey.slice(0, 4) + '...)' : 'NO — key missing'}`);

      const city = tenant.city || 'Brela';

      // More than 5 days — OpenWeather free tier limit, return static link via OpenAI
      if (isMultiDay && requestedDays > 5) {
        console.log(`[webhook] ${requestedDays} days requested — returning static link`);
        const reply = await formatReply(
          `Tell the user that a detailed long-range forecast is available at this link (keep the URL exactly as-is):\nhttps://weather.com/hr-HR/vrijeme/10dana/l/Brela+Splitsko+dalmatinska+%C5%BEupanija`,
          trimmedMsg, model
        );
        return res.send(twiml(reply));
      }

      if (!apiKey) {
        const reply = await formatReply('Tell the user the weather service is temporarily unavailable.', trimmedMsg, model);
        return res.send(twiml(reply));
      }

      try {
        if (isMultiDay) {
          const url = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric`;
          console.log(`[webhook] fetching ${requestedDays}-day forecast for city: ${city}`);
          const forecastRes = await fetch(url);
          const data = await forecastRes.json();

          if (!forecastRes.ok) {
            console.warn(`[webhook] forecast error ${forecastRes.status}:`, data.message);
            const reply = await formatReply('Tell the user the weather forecast is temporarily unavailable.', trimmedMsg, model);
            return res.send(twiml(reply));
          }

          const days = [];
          for (let i = 1; i <= requestedDays; i++) {
            const d = new Date();
            d.setDate(d.getDate() + i);
            const dateStr = d.toISOString().slice(0, 10);
            const entry = data.list.find(e => e.dt_txt.startsWith(dateStr) && e.dt_txt.includes('12:00'))
                       || data.list.find(e => e.dt_txt.startsWith(dateStr));
            if (entry) {
              const temp = Math.round(entry.main.temp);
              const desc = entry.weather[0]?.description || '';
              days.push(`${dateStr}: ${temp}°C, ${desc}`);
            }
          }

          if (!days.length) {
            const reply = await formatReply('Tell the user the weather forecast is temporarily unavailable.', trimmedMsg, model);
            return res.send(twiml(reply));
          }

          console.log(`[webhook] multi-day forecast OK: ${days.length} days`);
          const reply = await formatReply(
            `Format this ${requestedDays}-day weather forecast for ${city} as a short list:\n${days.join('\n')}`,
            trimmedMsg, model
          );
          return res.send(twiml(reply));

        } else if (isForecast) {
          const url = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric`;
          console.log(`[webhook] fetching tomorrow forecast for city: ${city}`);
          const forecastRes = await fetch(url);
          const data = await forecastRes.json();

          if (!forecastRes.ok) {
            console.warn(`[webhook] forecast error ${forecastRes.status}:`, data.message);
            const reply = await formatReply('Tell the user the forecast is temporarily unavailable.', trimmedMsg, model);
            return res.send(twiml(reply));
          }

          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          const tomorrowDate = tomorrow.toISOString().slice(0, 10);

          const entry = data.list.find(e => e.dt_txt.startsWith(tomorrowDate) && e.dt_txt.includes('12:00'))
                     || data.list.find(e => e.dt_txt.startsWith(tomorrowDate));

          if (!entry) {
            const reply = await formatReply('Tell the user the tomorrow forecast is not available yet.', trimmedMsg, model);
            return res.send(twiml(reply));
          }

          const temp = Math.round(entry.main.temp);
          const desc = entry.weather[0]?.description || '';
          console.log(`[webhook] tomorrow forecast OK: ${temp}°C, ${desc}`);
          const reply = await formatReply(
            `Tomorrow's weather forecast for ${city}: ${temp}°C, ${desc}.`,
            trimmedMsg, model
          );
          return res.send(twiml(reply));

        } else {
          const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric`;
          console.log(`[webhook] fetching current weather for city: ${city}`);
          const weatherRes = await fetch(url);
          const data = await weatherRes.json();

          if (!weatherRes.ok) {
            console.warn(`[webhook] weather error ${weatherRes.status}:`, data.message);
            const reply = await formatReply('Tell the user the weather data is temporarily unavailable.', trimmedMsg, model);
            return res.send(twiml(reply));
          }

          const temp = Math.round(data.main.temp);
          const desc = data.weather[0]?.description || '';
          console.log(`[webhook] weather OK: ${temp}°C, ${desc}`);
          const reply = await formatReply(
            `Current weather in ${city}: ${temp}°C, ${desc}.`,
            trimmedMsg, model
          );
          return res.send(twiml(reply));
        }

      } catch (weatherErr) {
        console.error('[webhook] weather fetch exception:', weatherErr.message);
        return res.send(twiml('Weather data is temporarily unavailable.'));
      }
    }

    // 7. Events check
    if (msgLower.includes('događaj') || msgLower.includes('dogadjaj') || msgLower.includes('event')) {
      await logMessage(tenant.id, userPhone, trimmedMsg, 'events');

      const events = await getUpcomingEvents(tenant.id);
      if (!events.length) {
        const reply = await formatReply('Tell the user there are no upcoming events at this time.', trimmedMsg, model);
        return res.send(twiml(reply));
      }

      const rawList = events.map((ev, i) => {
        const dateStr = new Date(ev.date).toISOString().slice(0, 10);
        let line = `${i + 1}. ${ev.title} (${dateStr}): ${ev.description}`;
        if (ev.location_link) line += ` - Location: ${ev.location_link}`;
        return line;
      }).join('\n');

      console.log(`[webhook] events found: ${events.length}`);
      const reply = await formatReply(`List these upcoming events for the user:\n${rawList}`, trimmedMsg, model);
      return res.send(twiml(reply));
    }

    // 8. AI usage rate limit
    const usage = await checkAndIncrementUsage(tenant.id, userPhone);
    if (!usage.allowed) {
      console.log(`[webhook] AI rate limit reached for ${userPhone} on tenant ${tenant.id}`);
      const city = tenant.city || 'Brela';
      return res.send(twiml(`For further questions, a TZ ${city} staff member will contact you.`));
    }

    // 9. AI response
    const messages = await getMessages(tenant.id, userPhone);
    messages.push({ role: 'user', content: trimmedMsg });

    const reply = await chat(`${MULTILINGUAL_PROMPT}\n\n${tenant.system_prompt}`, messages, model);
    console.log(`[webhook] reply: "${reply}"`);
    messages.push({ role: 'assistant', content: reply });

    await saveMessages(tenant.id, userPhone, messages);
    await logMessage(tenant.id, userPhone, trimmedMsg, 'ai');

    res.send(twiml(reply));
    console.log(`[webhook] TwiML sent to ${userPhone}`);
  } catch (err) {
    console.error('[webhook] error:', err.message);
    console.error(err.stack);
    const isQuota = err.status === 429 || err.code === 'insufficient_quota';
    res.send(twiml(isQuota
      ? 'Service temporarily unavailable. Please try again later.'
      : 'An error occurred. Please try again.'
    ));
  }
});

module.exports = router;
