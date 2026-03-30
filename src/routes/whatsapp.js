const express = require('express');
const router = express.Router();
const { getTenant, getMessages, saveMessages } = require('../db/sessions');
const { chat } = require('../services/openai');
const { logMessage, getFaqMatch, getUpcomingEvents, checkAndIncrementUsage } = require('../db/bot');

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
  return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
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
      return res.send(twiml(faqAnswer));
    }

    // 6. Weather check
    const msgLower = trimmedMsg.toLowerCase();

    // Detect "X dana" pattern (e.g. "3 dana", "10 dana")
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
      const fallback = 'Trenutno ne mogu dohvatiti podatke o vremenu. Pokušajte malo kasnije.';

      // More than 5 days — OpenWeather free tier only covers 5 days, send static link
      if (isMultiDay && requestedDays > 5) {
        console.log(`[webhook] ${requestedDays} days requested — returning static link`);
        return res.send(twiml(
          `Detaljna prognoza za duži period dostupna je ovdje:\n` +
          `https://weather.com/hr-HR/vrijeme/10dana/l/Brela+Splitsko+dalmatinska+%C5%BEupanija`
        ));
      }

      if (!apiKey) {
        return res.send(twiml('Servis za vremenske podatke trenutno nije dostupan.'));
      }

      try {
        if (isMultiDay) {
          // Multi-day forecast (2–5 days): one summary per day at ~12:00
          const url = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric&lang=hr`;
          console.log(`[webhook] fetching ${requestedDays}-day forecast for city: ${city}`);
          const forecastRes = await fetch(url);
          const data = await forecastRes.json();

          if (!forecastRes.ok) {
            console.warn(`[webhook] forecast error ${forecastRes.status}:`, data.message);
            return res.send(twiml(fallback));
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
              const label = d.toLocaleDateString('hr-HR', { weekday: 'short', day: '2-digit', month: '2-digit' });
              days.push(`${label}: ${temp}°C, ${desc}`);
            }
          }

          if (!days.length) return res.send(twiml(fallback));

          const weatherText = `Prognoza za ${city} (${requestedDays} dana):\n` + days.join('\n');
          console.log(`[webhook] multi-day forecast OK: ${days.length} days`);
          return res.send(twiml(weatherText));

        } else if (isForecast) {
          // Tomorrow forecast
          const url = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric&lang=hr`;
          console.log(`[webhook] fetching tomorrow forecast for city: ${city}`);
          const forecastRes = await fetch(url);
          const data = await forecastRes.json();

          if (!forecastRes.ok) {
            console.warn(`[webhook] forecast error ${forecastRes.status}:`, data.message);
            return res.send(twiml(fallback));
          }

          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          const tomorrowDate = tomorrow.toISOString().slice(0, 10);

          const entry = data.list.find(e => e.dt_txt.startsWith(tomorrowDate) && e.dt_txt.includes('12:00'))
                     || data.list.find(e => e.dt_txt.startsWith(tomorrowDate));

          if (!entry) return res.send(twiml('Prognoza za sutra trenutno nije dostupna.'));

          const temp = Math.round(entry.main.temp);
          const desc = entry.weather[0]?.description || '';
          const weatherText = `Sutra u ${city} se očekuje ${temp}°C, ${desc}.`;
          console.log(`[webhook] tomorrow forecast OK: "${weatherText}"`);
          return res.send(twiml(weatherText));

        } else {
          // Current weather
          const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric&lang=hr`;
          console.log(`[webhook] fetching current weather for city: ${city}`);
          const weatherRes = await fetch(url);
          const data = await weatherRes.json();

          if (!weatherRes.ok) {
            console.warn(`[webhook] weather error ${weatherRes.status}:`, data.message);
            return res.send(twiml(fallback));
          }

          const temp = Math.round(data.main.temp);
          const desc = data.weather[0]?.description || '';
          const weatherText = `U ${city} je trenutno ${temp}°C, ${desc}.`;
          console.log(`[webhook] weather OK: "${weatherText}"`);
          return res.send(twiml(weatherText));
        }

      } catch (weatherErr) {
        console.error('[webhook] weather fetch exception:', weatherErr.message);
        return res.send(twiml(fallback));
      }
    }

    // 7. Events check
    if (msgLower.includes('događaj') || msgLower.includes('dogadjaj') || msgLower.includes('event')) {
      await logMessage(tenant.id, userPhone, trimmedMsg, 'events');

      const events = await getUpcomingEvents(tenant.id);
      if (!events.length) {
        return res.send(twiml('Trenutno nema nadolazećih događaja.'));
      }

      const lines = events.map((ev, i) => {
        const dateStr = new Date(ev.date).toLocaleDateString('hr-HR', { day: '2-digit', month: '2-digit', year: 'numeric' });
        let line = `${i + 1}. ${ev.title} (${dateStr})\n${ev.description}`;
        if (ev.location_link) line += `\nLokacija: ${ev.location_link}`;
        return line;
      });

      return res.send(twiml('Nadolazeći događaji:\n' + lines.join('\n\n')));
    }

    // 8. AI usage rate limit
    const usage = await checkAndIncrementUsage(tenant.id, userPhone);
    if (!usage.allowed) {
      console.log(`[webhook] AI rate limit reached for ${userPhone} on tenant ${tenant.id}`);
      const city = tenant.city || 'Brela';
      return res.send(twiml(`Za dodatna pitanja javit će vam se zaposlenik TZ ${city}.`));
    }

    // 9. AI response
    const messages = await getMessages(tenant.id, userPhone);
    messages.push({ role: 'user', content: trimmedMsg });

    const reply = await chat(tenant.system_prompt, messages, tenant.openai_model);
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
      ? 'Trenutno ne mogu odgovoriti — privremena tehnička pogreška. Pokušajte malo kasnije.'
      : 'Došlo je do greške. Pokušajte ponovo.'
    ));
  }
});

module.exports = router;
