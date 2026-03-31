const pool = require('./db/index');
const { sendMessage } = require('./services/twilio');

const OPT_IN_PROMPT = 'Ako želiš, mogu ti slati obavijesti o događajima 😊\nNapiši DA ili NE';

async function runOptInOutreach() {
  try {
    const [tenants] = await pool.query('SELECT id, phone_number FROM tenants');
    for (const tenant of tenants) {
      try {
        const [users] = await pool.query(
          `SELECT phone FROM whatsapp_users
           WHERE tenant_id = ? AND opt_in = 0 AND asked_opt_in = 0
           AND last_message_at < NOW() - INTERVAL 5 MINUTE`,
          [tenant.id]
        );
        for (const user of users) {
          try {
            await sendMessage(user.phone, tenant.phone_number, OPT_IN_PROMPT);
            await pool.query(
              'UPDATE whatsapp_users SET asked_opt_in = 1 WHERE tenant_id = ? AND phone = ?',
              [tenant.id, user.phone]
            );
            console.log(`[cron] opt-in prompt sent to ${user.phone} for tenant ${tenant.id}`);
          } catch (sendErr) {
            console.error(`[cron] send error for ${user.phone}:`, sendErr.message);
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
