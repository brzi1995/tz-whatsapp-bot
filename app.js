const fs = require('fs');
const path = require('path');

try {
  require('dotenv').config();
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
