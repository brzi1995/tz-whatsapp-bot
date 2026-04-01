const express = require('express');
const router = express.Router();
const pool = require('../db/index');
const bcrypt = require('bcryptjs');
const { requireAuth } = require('../middleware/auth');
const { sendMessage } = require('../services/twilio');
const { normalizePhone } = require('../db/bot');

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

    let humanTakeover = false;
    try {
      const [tenantRows] = await pool.query(
        'SELECT human_takeover FROM tenants WHERE id = ?',
        [tenantId]
      );
      const tenant = (tenantRows && tenantRows[0]) || null;
      humanTakeover = tenant ? Boolean(tenant.human_takeover) : false;
    } catch (err) {
      console.error('TENANT human_takeover ERROR:', err.message);
    }

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
        'SELECT COUNT(*) AS total FROM users_chat WHERE tenant_id = ? AND human_takeover = 1',
        [tenantId]
      );
      activeUserTakeovers = (tkRows && tkRows[0] && tkRows[0].total) || 0;
    } catch (_) {}

    // Derive human-readable insights from existing data — no AI calls
    const insights = [];
    const hasData = intents.reduce((s, r) => s + Number(r.count), 0) > 0;

    if (hasData) {
      const intentPhrases = {
        faq:              'Najčešći upiti korisnika: opće informacije',
        weather_current:  'Najčešći upiti korisnika: trenutno vrijeme',
        weather_tomorrow: 'Najčešći upiti korisnika: prognoza za sutra',
        weather_multi:    'Najčešći upiti korisnika: višednevna prognoza',
        events:           'Najčešći upiti korisnika: lokalni događaji',
        ai:               'Turisti uglavnom koriste AI razgovor',
        other:            'Turisti uglavnom postavljaju opća pitanja',
      };
      const langPhrases = {
        hr: 'Većina korisnika govori hrvatski',
        en: 'Većina korisnika govori engleski',
        de: 'Većina korisnika govori njemački',
        it: 'Većina korisnika govori talijanski',
        fr: 'Većina korisnika govori francuski',
        sv: 'Većina korisnika govori švedski',
        no: 'Većina korisnika govori norveški',
        cs: 'Većina korisnika govori češki',
      };
      const timePhrases = {
        morning:   'Najviše aktivnosti: Jutro (6–12h)',
        afternoon: 'Najviše aktivnosti: Popodne (12–18h)',
        evening:   'Najviše aktivnosti: Večer (18–24h)',
      };

      // Skip admin_reply and fallback when finding top user intent
      const topUserIntent = intents.find(r => r.intent !== 'admin_reply' && r.intent !== 'fallback');
      if (topUserIntent) {
        insights.push({ icon: '🎯', text: intentPhrases[topUserIntent.intent] || `Najčešći upiti: ${topUserIntent.intent}` });
      }
      if (languages.length) {
        const top = languages[0];
        insights.push({ icon: '🌍', text: langPhrases[top.lang] || `Najčešći jezik: ${top.lang.toUpperCase()}` });
      }
      if (timeOfDay) {
        const tod = { morning: Number(timeOfDay.morning)||0, afternoon: Number(timeOfDay.afternoon)||0, evening: Number(timeOfDay.evening)||0 };
        const peak = Object.entries(tod).sort((a, b) => b[1] - a[1])[0];
        if (peak && peak[1] > 0) insights.push({ icon: '⏰', text: timePhrases[peak[0]] });
      }
    }

    const safeData = {
      totalUsers:          totalUsersRow.total || 0,
      totalMessages:       totalMsgsRow.total  || 0,
      perDay:              Array.isArray(perDay)         ? perDay         : [],
      intents:             Array.isArray(intents)        ? intents        : [],
      languages:           Array.isArray(languages)      ? languages      : [],
      timeOfDay:           timeOfDay || { morning: 0, afternoon: 0, evening: 0 },
      insights:            Array.isArray(insights)       ? insights       : [],
      activeUserTakeovers: activeUserTakeovers || 0,
      featuredEvents:      Array.isArray(featuredEvents) ? featuredEvents : [],
      humanTakeover:       humanTakeover || false,
      tenantId,
    };
    res.render('dashboard', safeData);
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
  const { title, description, date, location_link, featured, send_notification } = req.body;

  if (!title || !title.trim()) return res.redirect('/admin/events');

  const notifStatus = send_notification ? 'pending' : 'none';

  try {
    await pool.query(
      'INSERT INTO events (tenant_id, title, description, date, location_link, featured, send_notification, notification_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [tenantId, title.trim(), description || '', date || null, location_link || null, featured ? 1 : 0, send_notification ? 1 : 0, notifStatus]
    );
    res.redirect('/admin/events');
  } catch (err) {
    console.error('[admin] events insert error:', err.message);
    res.status(500).send('Greška pri dodavanju događaja');
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
  const { title, description, date, location_link, featured, send_notification } = req.body;

  if (isNaN(id) || !title || !title.trim()) return res.redirect('/admin/events');

  // When send_notification is toggled off, reset status to 'none'.
  // When toggled on and it was previously 'sent', keep 'sent' (don't re-queue).
  // When toggled on fresh, set 'pending'.
  let notifStatus;
  if (!send_notification) {
    notifStatus = 'none';
  } else {
    // Preserve existing sent status; only set pending for new/re-enabled notifications
    const [existing] = await pool.query(
      'SELECT notification_status FROM events WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );
    const prev = existing && existing[0] && existing[0].notification_status;
    notifStatus = prev === 'sent' ? 'sent' : 'pending';
  }

  try {
    await pool.query(
      'UPDATE events SET title = ?, description = ?, date = ?, location_link = ?, featured = ?, send_notification = ?, notification_status = ? WHERE id = ? AND tenant_id = ?',
      [title.trim(), description || '', date || null, location_link || null, featured ? 1 : 0, send_notification ? 1 : 0, notifStatus, id, tenantId]
    );
    res.redirect('/admin/events');
  } catch (err) {
    console.error('[admin] events edit post error:', err.message);
    res.status(500).send('Greška pri uređivanju događaja');
  }
});

// POST /admin/events/:id/toggle-featured
router.post('/events/:id/toggle-featured', requireAuth, async (req, res) => {
  const tenantId = req.session.tenantId;
  const id = parseInt(req.params.id, 10);

  if (isNaN(id)) return res.redirect('/admin/events');

  try {
    await pool.query(
      'UPDATE events SET featured = 1 - featured WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );
    res.redirect('/admin/events');
  } catch (err) {
    console.error('[admin] events toggle-featured error:', err.message);
    res.redirect('/admin/events');
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
      'SELECT COUNT(*) AS total FROM users_chat WHERE tenant_id = ? AND opt_in = 1',
      [tenantId]
    );
    const optedInCount = (countRows && countRows[0] && countRows[0].total) || 0;

    let events = [];
    try {
      const [evRows] = await pool.query(
        'SELECT id, title, description, date, location_link, notification_status FROM events WHERE tenant_id = ? AND send_notification = 1 ORDER BY date ASC',
        [tenantId]
      );
      events = evRows || [];
    } catch (evErr) {
      console.error('[admin] broadcast GET events query error:', evErr.message);
    }

    const justSent = req.query.sent === '1';
    res.render('broadcast', { optedInCount, events, justSent });
  } catch (err) {
    console.error('[admin] broadcast GET error:', err);
    res.render('broadcast', { optedInCount: 0, events: [], justSent: false });
  }
});

// POST /admin/broadcast/:id/send — send notification for a specific event
router.post('/broadcast/:id/send', requireAuth, async (req, res) => {
  const tenantId = req.session.tenantId;
  const id = parseInt(req.params.id, 10);

  if (isNaN(id)) return res.redirect('/admin/broadcast');

  try {
    const [evRows] = await pool.query(
      'SELECT * FROM events WHERE id = ? AND tenant_id = ? AND send_notification = 1',
      [id, tenantId]
    );
    const ev = evRows && evRows[0];
    if (!ev) return res.redirect('/admin/broadcast');

    const [tenantRows] = await pool.query('SELECT phone_number FROM tenants WHERE id = ?', [tenantId]);
    const tenant = tenantRows && tenantRows[0];
    if (!tenant) return res.redirect('/admin/broadcast');

    const [users] = await pool.query(
      'SELECT phone FROM users_chat WHERE tenant_id = ? AND opt_in = 1',
      [tenantId]
    );

    const dateStr = ev.date
      ? new Date(ev.date).toLocaleDateString('hr-HR', { day: 'numeric', month: 'long', year: 'numeric' })
      : null;

    let msg = `📢 Novi događaj: ${ev.title}`;
    if (dateStr)         msg += `\n📅 ${dateStr}`;
    if (ev.location_link) msg += `\n📍 ${ev.location_link}`;
    if (ev.description)   msg += `\n${ev.description}`;

    for (const user of users) {
      try {
        await sendMessage('whatsapp:' + normalizePhone(user.phone), tenant.phone_number, msg);
      } catch (sendErr) {
        console.error(`[admin] notification send error for ${user.phone}:`, sendErr.message);
      }
    }

    // Mark as sent; keep notification visible so the status is clear
    await pool.query(
      "UPDATE events SET notification_status = 'sent' WHERE id = ? AND tenant_id = ?",
      [id, tenantId]
    );

    res.redirect('/admin/broadcast?sent=1');
  } catch (err) {
    console.error('[admin] broadcast/:id/send error:', err.message);
    res.redirect('/admin/broadcast');
  }
});

// POST /admin/broadcast/:id/remove — remove event from notification queue
router.post('/broadcast/:id/remove', requireAuth, async (req, res) => {
  const tenantId = req.session.tenantId;
  const id = parseInt(req.params.id, 10);

  if (isNaN(id)) return res.redirect('/admin/broadcast');

  try {
    await pool.query(
      "UPDATE events SET send_notification = 0, notification_status = 'none' WHERE id = ? AND tenant_id = ?",
      [id, tenantId]
    );
    res.redirect('/admin/broadcast');
  } catch (err) {
    console.error('[admin] broadcast/:id/remove error:', err.message);
    res.redirect('/admin/broadcast');
  }
});

module.exports = router;
