const express = require('express');
const router = express.Router();
const pool = require('../db/index');
const bcrypt = require('bcryptjs');
const { requireAuth } = require('../middleware/auth');

/**
 * POST /admin/takeover/:tenantId
 * Toggles the human_takeover flag for the given tenant.
 * Returns { success: true, human_takeover: <new boolean value> }
 *
 * Auth is intentionally omitted here — added in Phase 2.
 */
router.post('/takeover/:tenantId', async (req, res) => {
  const tenantId = parseInt(req.params.tenantId, 10);
  if (!tenantId || isNaN(tenantId)) {
    return res.status(400).json({ success: false, error: 'Invalid tenant ID' });
  }

  try {
    // Toggle the flag in a single atomic statement
    await pool.query(
      'UPDATE tenants SET human_takeover = NOT human_takeover WHERE id = ?',
      [tenantId]
    );

    // Read back the new value so the caller knows the current state
    const [rows] = await pool.query(
      'SELECT human_takeover FROM tenants WHERE id = ?',
      [tenantId]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, error: 'Tenant not found' });
    }

    const newValue = Boolean(rows[0].human_takeover);
    console.log(`[admin] tenant ${tenantId} human_takeover set to ${newValue}`);
    return res.json({ success: true, human_takeover: newValue });
  } catch (err) {
    console.error('[admin] takeover error:', err.message);
    return res.status(500).json({ success: false, error: 'Database error' });
  }
});

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

    if (!rows.length) {
      return res.render('login', { error: 'Invalid email or password.' });
    }

    const user = rows[0];
    // TEMP: demo login without bcrypt (restore later)
    const match = password === '123456';

    if (!match) {
      return res.render('login', { error: 'Invalid email or password.' });
    }

    req.session.userId = user.id;
    req.session.tenantId = user.tenant_id;

    return res.redirect('/admin/dashboard');
  } catch (err) {
    console.error('[admin] login error:', err.message);
    return res.render('login', { error: 'Server error. Please try again.' });
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
    const [[totalUsersRow]] = await pool.query(
      'SELECT COUNT(DISTINCT user_phone) AS total FROM messages WHERE tenant_id = ?',
      [tenantId]
    );

    const [[totalMsgsRow]] = await pool.query(
      'SELECT COUNT(*) AS total FROM messages WHERE tenant_id = ?',
      [tenantId]
    );

    const [perDay] = await pool.query(
      `SELECT DATE(created_at) AS day, COUNT(*) AS count
       FROM messages
       WHERE tenant_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
       GROUP BY DATE(created_at)
       ORDER BY day ASC`,
      [tenantId]
    );

    res.render('dashboard', {
      totalUsers: totalUsersRow.total,
      totalMessages: totalMsgsRow.total,
      perDay,
    });
  } catch (err) {
    console.error('[admin] dashboard error:', err.message);
    res.status(500).send('Server error');
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
    const [[row]] = await pool.query(
      'SELECT * FROM faq WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );

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
  const { title, description, date, location_link } = req.body;

  try {
    await pool.query(
      'INSERT INTO events (tenant_id, title, description, date, location_link) VALUES (?, ?, ?, ?, ?)',
      [tenantId, title, description || null, date || null, location_link || null]
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
    const [[row]] = await pool.query(
      'SELECT * FROM events WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );

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
  const { title, description, date, location_link } = req.body;

  try {
    await pool.query(
      'UPDATE events SET title = ?, description = ?, date = ?, location_link = ? WHERE id = ? AND tenant_id = ?',
      [title, description || null, date || null, location_link || null, id, tenantId]
    );
    res.redirect('/admin/events');
  } catch (err) {
    console.error('[admin] events edit post error:', err.message);
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
      `SELECT user_phone,
              MAX(created_at) AS last_msg,
              COUNT(*) AS msg_count
       FROM messages
       WHERE tenant_id = ?
       GROUP BY user_phone
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

    const [[tenant]] = await pool.query(
      'SELECT human_takeover FROM tenants WHERE id = ?',
      [tenantId]
    );

    res.render('conversation', {
      messages,
      userPhone,
      takeover: tenant ? Boolean(tenant.human_takeover) : false,
      tenantId,
    });
  } catch (err) {
    console.error('[admin] conversation detail error:', err.message);
    res.status(500).send('Server error');
  }
});

module.exports = router;
