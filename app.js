const fs = require('fs');
const path = require('path');


try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });

  console.log('[app] env loaded | NODE_ENV:', process.env.NODE_ENV, '| DB_HOST:', process.env.DB_HOST, '| DB_NAME:', process.env.DB_NAME);

  const express = require('express');
  const session = require('express-session');
  const whatsappRoutes = require('./src/routes/whatsapp');

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(session({
    secret: process.env.SESSION_SECRET || 'tz-bot-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 hours
  }));

  app.get('/', (_req, res) => res.send('TZ WhatsApp Bot is running'));
  app.use('/whatsapp', whatsappRoutes);
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/admin', require('./src/routes/admin'));

  const { startCron } = require('./src/cron');

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    startCron();
    // Safe migrations — idempotent, run on every startup
    const pool = require('./src/db/index');
    pool.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS featured TINYINT(1) NOT NULL DEFAULT 0')
      .catch(err => console.warn('[migration] events.featured:', err.message));
    pool.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS send_notification TINYINT(1) NOT NULL DEFAULT 0')
      .catch(err => console.warn('[migration] events.send_notification:', err.message));
    pool.query("ALTER TABLE events ADD COLUMN IF NOT EXISTS notification_status VARCHAR(20) NOT NULL DEFAULT 'none'")
      .catch(err => console.warn('[migration] events.notification_status:', err.message));
    pool.query('ALTER TABLE faq ADD COLUMN IF NOT EXISTS link_title VARCHAR(255) DEFAULT NULL')
      .catch(err => console.warn('[migration] faq.link_title:', err.message));
    pool.query('ALTER TABLE faq ADD COLUMN IF NOT EXISTS link_url VARCHAR(500) DEFAULT NULL')
      .catch(err => console.warn('[migration] faq.link_url:', err.message));
    pool.query('ALTER TABLE faq ADD COLUMN IF NOT EXISTS link_image VARCHAR(500) DEFAULT NULL')
      .catch(err => console.warn('[migration] faq.link_image:', err.message));
    pool.query('ALTER TABLE faq ADD COLUMN IF NOT EXISTS category VARCHAR(100) DEFAULT NULL')
      .catch(err => console.warn('[migration] faq.category:', err.message));
    pool.query('ALTER TABLE users_chat ADD COLUMN IF NOT EXISTS language VARCHAR(5) DEFAULT NULL')
      .then(() => console.log('[migration] all columns ensured'))
      .catch(err => console.warn('[migration] users_chat.language:', err.message));
  });

  module.exports = app;
} catch (err) {
  fs.writeFileSync(path.join(__dirname, 'startup-error.txt'), err.stack || String(err));
  throw err;
}
