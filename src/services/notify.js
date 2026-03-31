const { sendMessage } = require('./twilio');

const ADMIN_TO = 'whatsapp:+385955225691';
const BOT_FROM = 'whatsapp:+15559449083';

/**
 * Send a WhatsApp alert to the admin when a user triggers human takeover.
 * Always sends — no dedup. The per-user takeover flag itself ensures this
 * is only triggered once per user (subsequent messages hit the takeover
 * guard and skip AI entirely, never reaching this function again).
 */
async function sendAdminNotification(tenantId, userPhone, message) {
  console.log('ADMIN NOTIFICATION TRIGGERED');

  const cleanPhone = userPhone.replace('whatsapp:', '');
  const baseUrl    = (process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, '');
  const body = [
    '🚨 Gost traži pomoć',
    '',
    `Broj: ${cleanPhone}`,
    `Poruka: "${message}"`,
    '',
    'Otvori razgovor:',
    `${baseUrl}/admin/conversations/${encodeURIComponent(cleanPhone)}`,
  ].join('\n');

  try {
    await sendMessage(ADMIN_TO, BOT_FROM, body);
    console.log('ADMIN NOTIFICATION SENT');
  } catch (err) {
    console.error('ADMIN NOTIFICATION ERROR', err.message);
  }
}

module.exports = { sendAdminNotification };
