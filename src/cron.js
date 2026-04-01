const pool = require('./db/index');
const { sendMessage } = require('./services/twilio');
const { generateOptInMessage } = require('./services/openai');

async function runOptInOutreach() {
  // Cache generated messages per language within this run to avoid redundant AI calls
  const msgCache = new Map();

  try {
    const [tenants] = await pool.query('SELECT id, phone_number FROM tenants');

    for (const tenant of tenants) {
      try {
        const [users] = await pool.query(
          `SELECT phone FROM users_chat
           WHERE tenant_id = ? AND opt_in = 0 AND asked_opt_in = 0
           AND human_takeover = 0
           AND last_message_at < NOW() - INTERVAL 5 MINUTE`,
          [tenant.id]
        );

        for (const user of users) {
          try {
            // Get user's last detected language from the messages table
            const [langRows] = await pool.query(
              `SELECT lang FROM messages
               WHERE tenant_id = ? AND user_phone = ?
               ORDER BY created_at DESC LIMIT 1`,
              [tenant.id, user.phone]
            );
            const lang = (langRows && langRows[0] && langRows[0].lang) || 'hr';

            // Generate (or reuse cached) opt-in message for this language
            if (!msgCache.has(lang)) {
              const generated = await generateOptInMessage(lang);
              msgCache.set(lang, generated);
              console.log(`[cron] generated opt-in message for lang=${lang}: "${generated}"`);
            }
            const optInMsg = msgCache.get(lang);

            await sendMessage('whatsapp:' + user.phone, tenant.phone_number, optInMsg);
            await pool.query(
              'UPDATE users_chat SET asked_opt_in = 1 WHERE tenant_id = ? AND phone = ?',
              [tenant.id, user.phone]
            );
            console.log(`[cron] opt-in prompt (${lang}) sent to ${user.phone} for tenant ${tenant.id}`);
          } catch (userErr) {
            console.error(`[cron] error for user ${user.phone}:`, userErr.message);
          }
        }
      } catch (tenantErr) {
        console.error(`[cron] tenant ${tenant.id} error:`, tenantErr.message);
      }
    }
  } catch (err) {
    console.error('[cron] outreach error:', err.message);
  }
}

function startCron() {
  console.log('[cron] opt-in outreach started (60s interval)');
  setInterval(runOptInOutreach, 60 * 1000);
}

module.exports = { startCron };
