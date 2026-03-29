require('dotenv').config();
const express = require('express');
const whatsappRoutes = require('./routes/whatsapp');

const app = express();

// Twilio webhooks arrive as application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/', (_req, res) => res.send('TZ WhatsApp Bot is running'));

app.use('/whatsapp', whatsappRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
