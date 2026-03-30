const fs = require('fs');
const path = require('path');

try {
  const dotenvResult = require('dotenv').config({ path: path.join(__dirname, '.env') });
  if (dotenvResult.error) {
    console.warn('[app] .env file not found — relying on system env vars:', dotenvResult.error.message);
  } else {
    console.log('[app] .env loaded successfully');
  }
  console.log('[app] NODE_ENV:', process.env.NODE_ENV, '| DB_HOST:', process.env.DB_HOST, '| DB_NAME:', process.env.DB_NAME);
  const express = require('express');
  const whatsappRoutes = require('./src/routes/whatsapp');

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.get('/', (_req, res) => res.send('TZ WhatsApp Bot is running'));
  app.use('/whatsapp', whatsappRoutes);

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
  module.exports = app;
} catch (err) {
  fs.writeFileSync(path.join(__dirname, 'startup-error.txt'), err.stack || String(err));
  throw err;
}
