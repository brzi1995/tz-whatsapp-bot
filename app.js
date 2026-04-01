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
    // Safe migration — add featured column for existing installs that predate the schema change
    const pool = require('./src/db/index');
    pool.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS featured TINYINT(1) NOT NULL DEFAULT 0')
      .then(() => console.log('[migration] events.featured column ensured'))
      .catch(err => console.warn('[migration] events.featured skipped:', err.message));
  });

  module.exports = app;
} catch (err) {
  fs.writeFileSync(path.join(__dirname, 'startup-error.txt'), err.stack || String(err));
  throw err;
}
