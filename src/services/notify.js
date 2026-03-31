const { sendMessage } = require('./twilio');

const ADMIN_TO = 'whatsapp:+385955225691';
const BOT_FROM = 'whatsapp:+15559449083';

// In-memory deduplication — prevents repeat alerts per user per server session.
// Key: "tenantId:userPhone"
const notifiedUsers = new Set();

/**
 * Returns true when the admin should be alerted about this message.
 * Only fires for explicit help requests — NOT for every general question.
 *   A. message contains help-seeking keywords
 *   B. bot response contains known fallback phrases
 */
function shouldNotifyAdmin(message, intent, response) {
  const msg = (message || '').toLowerCase();
  const keywords = ['agent', 'covjek', 'čovjek', 'osoba', 'help', 'kontakt', 'razgovor', 'pricati', 'pričati'];
  if (keywords.some(k => msg.includes(k))) return true;

  const res = (response || '').toLowerCase();
  const fallbackPhrases = ['ne znam', 'nemam', 'obratite', 'ured'];
  if (fallbackPhrases.some(k => res.includes(k))) return true;

  return false;
}

/**
 * Send a WhatsApp notification to the admin.
 * Silently skips if the admin was already notified for this user this session.
 * Never throws — errors are logged and swallowed so the bot flow is never blocked.
 */
async function notifyAdmin(tenantId, userPhone, message) {
  const key = `${tenantId}:${userPhone}`;
  if (notifiedUsers.has(key)) {
    console.log(`[notify] already notified for ${key} — skipping`);
    return;
  }
  notifiedUsers.add(key);

  const cleanPhone = userPhone.replace('whatsapp:', '');
  const baseUrl = (process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, '');
  const body = [
    '🚨 Gost traži pomoć',
    '',
    `Broj: ${cleanPhone}`,
    `Poruka: "${message}"`,
    '',
    'Otvori dashboard:',
    `${baseUrl}/admin/conversations/${encodeURIComponent(cleanPhone)}`,
  ].join('\n');

  try {
    await sendMessage(ADMIN_TO, BOT_FROM, body);
    console.log(`[notify] admin notified for ${userPhone}`);
  } catch (err) {
    console.error('[notify] failed to send admin notification:', err.message);
  }
}

module.exports = { shouldNotifyAdmin, notifyAdmin };
