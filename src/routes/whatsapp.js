const express = require('express');
const router = express.Router();

router.post('/webhook', (req, res) => {
  console.log('[webhook] hit | body:', JSON.stringify(req.body));
  res.type('text/xml').send(`
    <Response>
      <Message>RADIIII</Message>
    </Response>
  `);
});

module.exports = router;
