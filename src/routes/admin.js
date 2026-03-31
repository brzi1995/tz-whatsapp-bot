const express = require('express');
const router = express.Router();
const pool = require('../db/index');
const bcrypt = require('bcryptjs');
const { requireAuth } = require('../middleware/auth');
const { sendMessage } = require('../services/twilio');

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

// GET /admin/login
router.get('/login', (req, res) => {
  if (req.session && req.session.userId) {
    return res.redirect('/admin/dashboard');
  }
  res.render('login', { error: null });
});

// POST /admin/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.render('login', { error: 'Please enter email and password.' });
  }

  try {
    const [rows] = await pool.query(
      'SELECT id, email, password, tenant_id FROM users WHERE email = ? LIMIT 1',
      [email.trim().toLowerCase()]
    );

    if (!rows || rows.length === 0) {
      return res.render('login', { error: 'Invalid email or password.' });
    }

    const user = rows[0];
    if (!user) {
      return res.render('login', { error: 'Invalid email or password.' });
    }
    // TEMP: demo login without bcrypt (restore later)
    const match = password === '123456';

    if (!match) {
      return res.render('login', { error: 'Invalid email or password.' });
    }

    console.log('LOGIN ROWS:', rows);
    console.log('LOGIN USER:', user);
    console.log('SESSION:', req.session);

    req.session.userId = user.id;
    req.session.tenantId = user.tenant_id;

    return res.redirect('/admin/dashboard');
  } catch (err) {
    console.error('[admin] login error FULL:', err);
    return res.status(500).send(err.stack);
  }
});

// GET /admin/logout
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin/login');
  });
});

// ---------------------------------------------------------------------------
// Protected routes
// ---------------------------------------------------------------------------

// GET /admin/dashboard
router.get('/dashboard', requireAuth, async (req, res) => {
  const tenantId = req.session.tenantId;

  try {
    const [usersRows] = await pool.query(
      'SELECT COUNT(DISTINCT user_phone) AS total FROM messages WHERE tenant_id = ?',
      [tenantId]
    );
    const totalUsersRow = (usersRows && usersRows[0]) || { total: 0 };

    const [msgsRows] = await pool.query(
      'SELECT COUNT(*) AS total FROM messages WHERE tenant_id = ?',
      [tenantId]
    );
    const totalMsgsRow = (msgsRows && msgsRows[0]) || { total: 0 };

    const [perDayRows] = await pool.query(
      `SELECT DATE(created_at) AS day, COUNT(*) AS count
       FROM messages
       WHERE tenant_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
       GROUP BY DATE(created_at)
       ORDER BY day ASC`,
      [tenantId]
    );
    const perDay = perDayRows || [];

    const [intentRows] = await pool.query(
      `SELECT intent, COUNT(*) AS count
       FROM messages WHERE tenant_id = ?
       GROUP BY intent ORDER BY count DESC`,
      [tenantId]
    );
    const intents = intentRows || [];

    let languages = [];
    try {
      const [langRows] = await pool.query(
        `SELECT COALESCE(lang, 'hr') AS lang, COUNT(*) AS count
         FROM messages WHERE tenant_id = ?
         GROUP BY lang ORDER BY count DESC`,
        [tenantId]
      );
      languages = langRows || [];
    } catch (_) {
      // lang column may not exist yet — safe fallback
    }

    const [todRows] = await pool.query(
      `SELECT
         SUM(HOUR(created_at) BETWEEN 6  AND 11) AS morning,
         SUM(HOUR(created_at) BETWEEN 12 AND 17) AS afternoon,
         SUM(HOUR(created_at) BETWEEN 18 AND 23) AS evening
       FROM messages WHERE tenant_id = ?`,
      [tenantId]
    );
    const timeOfDay = (todRows && todRows[0]) || { morning: 0, afternoon: 0, evening: 0 };

    const [tenantRows] = await pool.query(
      'SELECT human_takeover FROM tenants WHERE id = ?',
      [tenantId]
    );
    const tenant = (tenantRows && tenantRows[0]) || null;
    const humanTakeover = tenant ? Boolean(tenant.human_takeover) : false;

    let featuredEvents = [];
    try {
      const [fevRows] = await pool.query(
        'SELECT id, title, date, description FROM events WHERE tenant_id = ? AND date >= CURDATE() AND featured = 1 ORDER BY date ASC LIMIT 3',
        [tenantId]
      );
      featuredEvents = fevRows || [];
    } catch (_) {}

    let activeUserTakeovers = 0;
    try {
      const [tkRows] = await pool.query(
        'SELECT COUNT(*) AS total FROM whatsapp_users WHERE tenant_id = ? AND human_takeover = 1',
        [tenantId]
      );
      activeUserTakeovers = (tkRows && tkRows[0] && tkRows[0].total) || 0;
    } catch (_) {}

    // Derive human-readable insights from existing data — no AI calls
    const insights = [];
    const hasData = intents.reduce((s, r) => s + Number(r.count), 0) > 0;

    if (hasData) {
      const intentPhrases = {
        faq:              'Most tourists ask FAQ questions',
        weather_current:  'Most tourists ask about current weather',
        weather_tomorrow: 'Most tourists ask about tomorrow\'s forecast',
        weather_multi:    'Most tourists ask for multi-day forecasts',
        events:           'Most tourists ask about local events',
        ai:               'Most tourists use the AI chat',
        other:            'Most messages are general questions',
      };
      const langPhrases = {
        hr: 'Majority of users speak Croatian',
        en: 'Majority of users speak English',
        de: 'Majority of users speak German',
        it: 'Majority of users speak Italian',
        fr: 'Majority of users speak French',
      };
      const timePhrases = {
        morning:   'Peak activity is in the morning (6–12)',
        afternoon: 'Peak activity is in the afternoon (12–18)',
        evening:   'Peak activity is in the evening (18–24)',
      };

      if (intents.length) {
        const top = intents[0];
        insights.push({ icon: '🎯', text: intentPhrases[top.intent] || `Most common intent: ${top.intent}` });
      }
      if (languages.length) {
        const top = languages[0];
        insights.push({ icon: '🌍', text: langPhrases[top.lang] || `Most used language: ${top.lang.toUpperCase()}` });
      }
      if (timeOfDay) {
        const tod = { morning: Number(timeOfDay.morning)||0, afternoon: Number(timeOfDay.afternoon)||0, evening: Number(timeOfDay.evening)||0 };
        const peak = Object.entries(tod).sort((a, b) => b[1] - a[1])[0];
        if (peak && peak[1] > 0) insights.push({ icon: '⏰', text: timePhrases[peak[0]] });
      }
    }

    res.render('dashboard', {
      totalUsers:    totalUsersRow.total || 0,
      totalMessages: totalMsgsRow.total  || 0,
      perDay,
      intents,
      languages,
      timeOfDay,
      insights,
      activeUserTakeovers,
      featuredEvents,
      tenantId,
    });
  } catch (err) {
    console.error('DASHBOARD ERROR FULL:', err);
    return res.status(500).send('<pre>' + err.stack + '</pre>');
  }
});

// ---------------------------------------------------------------------------
// FAQ
// ---------------------------------------------------------------------------

// GET /admin/faq
router.get('/faq', requireAuth, async (req, res) => {
  const tenantId = req.session.tenantId;

  try {
    const [rows] = await pool.query(
      'SELECT * FROM faq WHERE tenant_id = ? ORDER BY id DESC',
      [tenantId]
    );
    res.render('faq', { faqs: rows });
  } catch (err) {
    console.error('[admin] faq list error:', err.message);
    res.status(500).send('Server error');
  }
});

// POST /admin/faq
router.post('/faq', requireAuth, async (req, res) => {
  const tenantId = req.session.tenantId;
  const { question, answer } = req.body;

  try {
    await pool.query(
      'INSERT INTO faq (tenant_id, question, answer) VALUES (?, ?, ?)',
      [tenantId, question, answer]
    );
    res.redirect('/admin/faq');
  } catch (err) {
    console.error('[admin] faq insert error:', err.message);
    res.status(500).send('Server error');
  }
});

// POST /admin/faq/:id/delete
router.post('/faq/:id/delete', requireAuth, async (req, res) => {
  const tenantId = req.session.tenantId;
  const id = parseInt(req.params.id, 10);

  try {
    await pool.query(
      'DELETE FROM faq WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );
    res.redirect('/admin/faq');
  } catch (err) {
    console.error('[admin] faq delete error:', err.message);
    res.status(500).send('Server error');
  }
});

// GET /admin/faq/:id/edit
router.get('/faq/:id/edit', requireAuth, async (req, res) => {
  const tenantId = req.session.tenantId;
  const id = parseInt(req.params.id, 10);

  try {
    const [faqRows] = await pool.query(
      'SELECT * FROM faq WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );
    const row = faqRows && faqRows.length ? faqRows[0] : null;

    if (!row) return res.status(404).send('Not found');
    res.render('faq-edit', { faq: row });
  } catch (err) {
    console.error('[admin] faq edit get error:', err.message);
    res.status(500).send('Server error');
  }
});

// POST /admin/faq/:id/edit
router.post('/faq/:id/edit', requireAuth, async (req, res) => {
  const tenantId = req.session.tenantId;
  const id = parseInt(req.params.id, 10);
  const { question, answer } = req.body;

  try {
    await pool.query(
      'UPDATE faq SET question = ?, answer = ? WHERE id = ? AND tenant_id = ?',
      [question, answer, id, tenantId]
    );
    res.redirect('/admin/faq');
  } catch (err) {
    console.error('[admin] faq edit post error:', err.message);
    res.status(500).send('Server error');
  }
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

// GET /admin/events
router.get('/events', requireAuth, async (req, res) => {
  const tenantId = req.session.tenantId;

  try {
    const [rows] = await pool.query(
      'SELECT * FROM events WHERE tenant_id = ? ORDER BY date DESC',
      [tenantId]
    );
    res.render('events', { events: rows });
  } catch (err) {
    console.error('[admin] events list error:', err.message);
    res.status(500).send('Server error');
  }
});

// POST /admin/events
router.post('/events', requireAuth, async (req, res) => {
  const tenantId = req.session.tenantId;
  const { title, description, date, location_link, featured } = req.body;

  try {
    await pool.query(
      'INSERT INTO events (tenant_id, title, description, date, location_link, featured) VALUES (?, ?, ?, ?, ?, ?)',
      [tenantId, title, description || null, date || null, location_link || null, featured ? 1 : 0]
    );
    res.redirect('/admin/events');
  } catch (err) {
    console.error('[admin] events insert error:', err.message);
    res.status(500).send('Server error');
  }
});

// POST /admin/events/:id/delete
router.post('/events/:id/delete', requireAuth, async (req, res) => {
  const tenantId = req.session.tenantId;
  const id = parseInt(req.params.id, 10);

  try {
    await pool.query(
      'DELETE FROM events WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );
    res.redirect('/admin/events');
  } catch (err) {
    console.error('[admin] events delete error:', err.message);
    res.status(500).send('Server error');
  }
});

// GET /admin/events/:id/edit
router.get('/events/:id/edit', requireAuth, async (req, res) => {
  const tenantId = req.session.tenantId;
  const id = parseInt(req.params.id, 10);

  try {
    const [eventRows] = await pool.query(
      'SELECT * FROM events WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );
    const row = eventRows && eventRows.length ? eventRows[0] : null;

    if (!row) return res.status(404).send('Not found');
    res.render('event-edit', { event: row });
  } catch (err) {
    console.error('[admin] events edit get error:', err.message);
    res.status(500).send('Server error');
  }
});

// POST /admin/events/:id/edit
router.post('/events/:id/edit', requireAuth, async (req, res) => {
  const tenantId = req.session.tenantId;
  const id = parseInt(req.params.id, 10);
  const { title, description, date, location_link, featured } = req.body;

  try {
    await pool.query(
      'UPDATE events SET title = ?, description = ?, date = ?, location_link = ?, featured = ? WHERE id = ? AND tenant_id = ?',
      [title, description || null, date || null, location_link || null, featured ? 1 : 0, id, tenantId]
    );
    res.redirect('/admin/events');
  } catch (err) {
    console.error('[admin] events edit post error:', err.message);
    res.status(500).send('Server error');
  }
});

// POST /admin/events/:id/toggle-featured
router.post('/events/:id/toggle-featured', requireAuth, async (req, res) => {
  const tenantId = req.session.tenantId;
  const id = parseInt(req.params.id, 10);

  try {
    await pool.query(
      'UPDATE events SET featured = NOT featured WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );
    res.redirect('/admin/events');
  } catch (err) {
    console.error('[admin] events toggle-featured error:', err.message);
    res.status(500).send('Server error');
  }
});

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

// GET /admin/conversations
router.get('/conversations', requireAuth, async (req, res) => {
  const tenantId = req.session.tenantId;

  try {
    const [rows] = await pool.query(
      `SELECT m.user_phone,
              MAX(m.created_at) AS last_msg,
              COUNT(*) AS msg_count,
              MAX(COALESCE(wu.human_takeover, 0)) AS human_takeover
       FROM messages m
       LEFT JOIN whatsapp_users wu
         ON wu.tenant_id = m.tenant_id AND wu.phone = m.user_phone
       WHERE m.tenant_id = ?
       GROUP BY m.user_phone
       ORDER BY last_msg DESC`,
      [tenantId]
    );
    res.render('conversations', { conversations: rows });
  } catch (err) {
    console.error('[admin] conversations list error:', err.message);
    res.status(500).send('Server error');
  }
});

// GET /admin/conversations/:phone
router.get('/conversations/:phone', requireAuth, async (req, res) => {
  const tenantId = req.session.tenantId;
  const userPhone = req.params.phone;

  try {
    const [messages] = await pool.query(
      `SELECT * FROM messages
       WHERE tenant_id = ? AND user_phone = ?
       ORDER BY created_at ASC`,
      [tenantId, userPhone]
    );

    const [userRows] = await pool.query(
      'SELECT human_takeover FROM whatsapp_users WHERE tenant_id = ? AND phone = ?',
      [tenantId, userPhone]
    );
    const userRecord = (userRows && userRows[0]) || null;

    res.render('conversation', {
      messages,
      userPhone,
      takeover: userRecord ? Boolean(userRecord.human_takeover) : false,
      tenantId,
    });
  } catch (err) {
    console.error('[admin] conversation detail error:', err.message);
    res.status(500).send('Server error');
  }
});

// POST /admin/conversations/:phone/takeover — toggle per-user takeover
router.post('/conversations/:phone/takeover', requireAuth, async (req, res) => {
  const tenantId  = req.session.tenantId;
  const userPhone = req.params.phone;

  try {
    await pool.query(
      'UPDATE whatsapp_users SET human_takeover = NOT human_takeover WHERE tenant_id = ? AND phone = ?',
      [tenantId, userPhone]
    );

    const [rows] = await pool.query(
      'SELECT human_takeover FROM whatsapp_users WHERE tenant_id = ? AND phone = ?',
      [tenantId, userPhone]
    );
    const user = (rows && rows[0]) || null;
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const newValue = Boolean(user.human_takeover);
    console.log(`[admin] per-user takeover for ${userPhone} set to ${newValue}`);
    return res.json({ success: true, human_takeover: newValue });
  } catch (err) {
    console.error('[admin] per-user takeover error:', err.message);
    return res.status(500).json({ success: false, error: 'Database error' });
  }
});

// POST /admin/conversations/:phone/reply
router.post('/conversations/:phone/reply', requireAuth, async (req, res) => {
  const tenantId = req.session.tenantId;
  const userPhone = req.params.phone;
  const message = (req.body.message || '').trim();

  if (!message) {
    return res.redirect(`/admin/conversations/${encodeURIComponent(userPhone)}`);
  }

  try {
    // Get tenant's Twilio number to use as the from address
    const [tenantRows] = await pool.query(
      'SELECT phone_number FROM tenants WHERE id = ?',
      [tenantId]
    );
    const tenant = (tenantRows && tenantRows[0]) || null;
    if (!tenant) return res.status(404).send('Tenant not found');

    // Send WhatsApp message via Twilio
    await sendMessage(userPhone, tenant.phone_number, message);

    // Log the admin reply in the messages table
    await pool.query(
      'INSERT INTO messages (tenant_id, user_phone, message, intent, lang) VALUES (?, ?, ?, ?, ?)',
      [tenantId, userPhone, message, 'admin_reply', 'hr']
    );

    console.log(`[admin] reply sent to ${userPhone} by tenant ${tenantId}`);
    res.redirect(`/admin/conversations/${encodeURIComponent(userPhone)}`);
  } catch (err) {
    console.error('[admin] reply error:', err);
    res.status(500).send('Greška pri slanju poruke: ' + err.message);
  }
});

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

// GET /admin/broadcast
router.get('/broadcast', requireAuth, async (req, res) => {
  const tenantId = req.session.tenantId;
  try {
    const [countRows] = await pool.query(
      'SELECT COUNT(*) AS total FROM whatsapp_users WHERE tenant_id = ? AND opt_in = 1',
      [tenantId]
    );
    const optedInCount = (countRows && countRows[0] && countRows[0].total) || 0;
    res.render('broadcast', { optedInCount, sent: null, error: null });
  } catch (err) {
    console.error('[admin] broadcast get error:', err.message);
    res.status(500).send('Server error');
  }
});

// POST /admin/broadcast
router.post('/broadcast', requireAuth, async (req, res) => {
  const tenantId = req.session.tenantId;
  const message = (req.body.message || '').trim();

  if (!message) return res.redirect('/admin/broadcast');

  try {
    const [tenantRows] = await pool.query('SELECT phone_number FROM tenants WHERE id = ?', [tenantId]);
    const tenant = (tenantRows && tenantRows[0]) || null;
    if (!tenant) return res.status(404).send('Tenant not found');

    const [users] = await pool.query(
      'SELECT phone FROM whatsapp_users WHERE tenant_id = ? AND opt_in = 1',
      [tenantId]
    );

    let sentCount = 0;
    for (const user of users) {
      try {
        await sendMessage(user.phone, tenant.phone_number, message);
        sentCount++;
      } catch (sendErr) {
        console.error(`[admin] broadcast send error for ${user.phone}:`, sendErr.message);
      }
    }

    const [countRows] = await pool.query(
      'SELECT COUNT(*) AS total FROM whatsapp_users WHERE tenant_id = ? AND opt_in = 1',
      [tenantId]
    );
    const optedInCount = (countRows && countRows[0] && countRows[0].total) || 0;

    res.render('broadcast', { optedInCount, sent: sentCount, error: null });
  } catch (err) {
    console.error('[admin] broadcast post error:', err.message);
    res.status(500).send('Server error');
  }
});

module.exports = router;
