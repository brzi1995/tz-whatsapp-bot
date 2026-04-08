'use strict';

/**
 * Event Importer — brela.hr/dogadanja scraper
 *
 * Fetches the Brela events page for a given month, parses the HTML with
 * cheerio, and upserts the results into the `events` table.
 *
 * Usage:
 *   const { importEventsForMonth, importAllTenantEvents } = require('./eventImporter');
 *   await importEventsForMonth(tenantId, '2025-07');  // specific month
 *   await importAllTenantEvents();                    // current + next month, all tenants
 */

const axios = require('axios');
const cheerio = require('cheerio');
const pool = require('../db/index');

const EVENTS_BASE_URL = 'https://brela.hr/dogadanja';

// ─── DATE PARSING ─────────────────────────────────────────────────────────────

/** Croatian month name → zero-padded month number */
const HR_MONTHS = {
  siječnja: '01', veljače: '02', ožujka: '03', travnja: '04',
  svibnja: '05', lipnja: '06', srpnja: '07', kolovoza: '08',
  rujna: '09', listopada: '10', studenog: '11', prosinca: '12',
  // nominative forms
  siječanj: '01', veljača: '02', ožujak: '03', travanj: '04',
  svibanj: '05', lipanj: '06', srpanj: '07', kolovoz: '08',
  rujan: '09', listopad: '10', studeni: '11', prosinac: '12',
};

/**
 * Try to parse a date string into YYYY-MM-DD.
 * Handles ISO (2025-06-15), Croatian dotted (15.06.2025),
 * and Croatian long form (15. lipnja 2025).
 * Returns null if unparseable.
 */
function parseDate(text) {
  if (!text) return null;
  const t = String(text).trim();

  // ISO: 2025-06-15 or datetime attribute 2025-06-15T...
  const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // Croatian dotted: 15.06.2025 or 15.6.2025
  const dot = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dot) {
    return `${dot[3]}-${dot[2].padStart(2, '0')}-${dot[1].padStart(2, '0')}`;
  }

  // Croatian long: "15. lipnja 2025" or "15 lipnja 2025"
  for (const [name, num] of Object.entries(HR_MONTHS)) {
    const re = new RegExp(`(\\d{1,2})\\.?\\s+${name}\\s+(\\d{4})`, 'i');
    const m = t.match(re);
    if (m) return `${m[2]}-${num}-${m[1].padStart(2, '0')}`;
  }

  return null;
}

// ─── HTML SCRAPER ─────────────────────────────────────────────────────────────

/**
 * Fetch and parse the events page for a given month.
 * Returns an array of { title, date, description, location_link }.
 */
async function scrapeEventsPage(yearMonth) {
  const url = `${EVENTS_BASE_URL}?date=${yearMonth}`;
  console.log(`[eventImporter] Fetching: ${url}`);

  const response = await axios.get(url, {
    timeout: 20000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; BrelaBot/1.0; +https://brela.hr)',
      'Accept-Language': 'hr,en;q=0.9',
    },
  });

  const $ = cheerio.load(response.data);
  const events = [];

  // Try multiple selector strategies, most specific first
  const SELECTORS = [
    '.tribe-events-calendar-list__event',
    '.tribe-event',
    '.tribe-events-loop .tribe-events-calendar-list__event-wrapper',
    '.event-item',
    '.dogadanje',
    '.wp-block-post',
    'article[class*="event"]',
    'article[class*="tribe"]',
    '.events-list li',
    'article.post',
  ];

  let $items = $();
  for (const sel of SELECTORS) {
    const found = $(sel);
    if (found.length > 0) {
      $items = found;
      console.log(`[eventImporter] Using selector "${sel}" → ${found.length} items`);
      break;
    }
  }

  // Fallback: look for any <article> with a heading and date
  if ($items.length === 0) {
    $items = $('article').filter((_i, el) => {
      const $el = $(el);
      return $el.find('h1,h2,h3,h4').length > 0 && $el.find('time').length > 0;
    });
    if ($items.length) {
      console.log(`[eventImporter] Fallback: found ${$items.length} article elements with heading+time`);
    }
  }

  if ($items.length === 0) {
    console.log('[eventImporter] No event items found — page structure may have changed.');
    return [];
  }

  $items.each((_i, el) => {
    try {
      const $el = $(el);

      // Title — try specific selectors then generic headings
      const title = (
        $el.find('.tribe-event-url, .tribe-events-calendar-list__event-title a, .entry-title a, .event-title a').first().text() ||
        $el.find('h1,h2,h3,h4').first().text() ||
        $el.find('a').first().text()
      ).replace(/\s+/g, ' ').trim();

      if (!title || title.length < 2) return;

      // Date — prefer machine-readable datetime attribute on <time>
      const timeEl = $el.find('time').first();
      const rawDate = (
        timeEl.attr('datetime') ||
        timeEl.text() ||
        $el.find('.tribe-event-date-start, .event-date, .date, .datum').first().text() ||
        ''
      ).trim();

      const date = parseDate(rawDate);
      if (!date) {
        console.log(`[eventImporter] Could not parse date "${rawDate}" for "${title}" — skipping`);
        return;
      }

      // Description — first paragraph or excerpt, truncated to 300 chars
      const rawDesc = (
        $el.find('.tribe-events-calendar-list__event-description p, .event-description, .entry-content p, .excerpt').first().text() ||
        $el.find('p').first().text() ||
        ''
      ).replace(/\s+/g, ' ').trim();
      const description = rawDesc.length > 300 ? rawDesc.slice(0, 297) + '...' : rawDesc;

      // Location link — Google Maps / event detail link
      const locationEl = $el.find('a[href*="maps.google"], a[href*="goo.gl/maps"], a[href*="/dogadanje/"], a[href*="/event/"]').first();
      const location_link = locationEl.attr('href') || null;

      events.push({ title, date, description, location_link });
    } catch (itemErr) {
      console.error('[eventImporter] Error parsing event item:', itemErr.message);
    }
  });

  console.log(`[eventImporter] Parsed ${events.length} events from ${yearMonth}`);
  return events;
}

// ─── DB UPSERT ────────────────────────────────────────────────────────────────

/**
 * Upsert a single event into the DB.
 * Matches on (tenant_id, title, date) — updates description + location_link if found.
 */
async function upsertEvent(tenantId, { title, date, description, location_link }) {
  const [existing] = await pool.query(
    'SELECT id FROM events WHERE tenant_id = ? AND title = ? AND date = ?',
    [tenantId, title, date]
  );

  if (existing.length === 0) {
    await pool.query(
      'INSERT INTO events (tenant_id, title, description, date, location_link, featured, is_active) VALUES (?, ?, ?, ?, ?, 0, 1)',
      [tenantId, title, description || '', date, location_link || null]
    );
  } else {
    await pool.query(
      'UPDATE events SET description = ?, location_link = ?, is_active = 1 WHERE id = ?',
      [description || '', location_link || null, existing[0].id]
    );
  }
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Import events for a specific tenant and month.
 * @param {number} tenantId
 * @param {string} yearMonth  YYYY-MM (defaults to current month)
 * @returns {Promise<{ imported: number, skipped: number, errors: number }>}
 */
async function importEventsForMonth(tenantId, yearMonth) {
  const ym = yearMonth || new Date().toISOString().slice(0, 7);
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const events = await scrapeEventsPage(ym);

    for (const ev of events) {
      try {
        await upsertEvent(tenantId, ev);
        imported++;
      } catch (dbErr) {
        console.error(`[eventImporter] DB error for "${ev.title}" (${ev.date}):`, dbErr.message);
        errors++;
      }
    }

    if (events.length === 0) skipped = 1;
  } catch (fetchErr) {
    console.error(`[eventImporter] Fetch/parse error for ${ym}:`, fetchErr.message);
    errors++;
  }

  console.log(`[eventImporter] tenant=${tenantId} month=${ym}: imported=${imported} skipped=${skipped} errors=${errors}`);
  return { imported, skipped, errors };
}

/**
 * Import events for current month + next month across all tenants.
 * Safe to run on a schedule (idempotent upserts).
 */
async function importAllTenantEvents() {
  try {
    const [tenants] = await pool.query('SELECT id FROM tenants');
    const now = new Date();
    const months = [
      now.toISOString().slice(0, 7),
      new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString().slice(0, 7),
    ];

    for (const tenant of tenants) {
      for (const month of months) {
        await importEventsForMonth(tenant.id, month);
      }
    }
  } catch (err) {
    console.error('[eventImporter] importAllTenantEvents error:', err.message);
  }
}

module.exports = { importEventsForMonth, importAllTenantEvents, parseDate };
