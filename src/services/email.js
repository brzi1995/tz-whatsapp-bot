const nodemailer = require('nodemailer');

/**
 * Send a human-handover notification to the admin.
 * Never throws — errors are logged and swallowed so the request flow continues.
 *
 * Required env vars:
 *   EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_TO
 */
async function sendHandoverEmail(userPhone, message) {
  try {
    const port = parseInt(process.env.EMAIL_PORT || '587', 10);
    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port,
      secure: port === 465,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const timestamp = new Date().toLocaleString('hr-HR', {
      timeZone: 'Europe/Zagreb',
      dateStyle: 'short',
      timeStyle: 'medium',
    });

    await transporter.sendMail({
      from: `"TZ Bot" <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_TO,
      subject: 'New tourist inquiry requires response',
      text: [
        'A tourist requires human assistance.',
        '',
        `User:      ${userPhone}`,
        `Message:   ${message}`,
        `Timestamp: ${timestamp}`,
      ].join('\n'),
    });

    console.log(`[email] handover notification sent for ${userPhone}`);
  } catch (err) {
    console.error('[email] sendHandoverEmail failed:', err.message);
  }
}

module.exports = { sendHandoverEmail };
