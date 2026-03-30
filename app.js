const fs = require('fs');
const path = require('path');

try {
  require('dotenv').config();

  console.log('[app] .env loaded');
  console.log('[app] DB_HOST:', process.env.DB_HOST);

  const express = require('express');

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.get('/', (_req, res) => res.send('App running'));

  // TEMP DISABLED:
  // const whatsappRoutes = require('./src/routes/whatsapp');
  // app.use('/whatsapp', whatsappRoutes);

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server on ${PORT}`));

} catch (err) {
  fs.writeFileSync(
    path.join(__dirname, 'startup-error.txt'),
    err.stack || String(err)
  );
  throw err;
}
