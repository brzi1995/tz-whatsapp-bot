const express = require('express');
const router = express.Router();
const pool = require('../db/index');

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

module.exports = router;
