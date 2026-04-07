const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://brela.hr/dogadanja';

/**
 * Scrape events from brela.hr for a given month.
 * @param {string} monthKey - Format: 'YYYY-MM', e.g. '2025-07'
 * @returns {Promise<Array<{title: string, date: string, link: string}>>}
 */
async function fetchBrelaEvents(monthKey) {
  const url = `${BASE_URL}?date=${monthKey}`;

  const { data } = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; TZ-Bot/1.0; +https://brela.hr)',
      'Accept-Language': 'hr,en;q=0.9',
    },
    timeout: 15000,
  });

  const $ = cheerio.load(data);
  const events = [];
  const seen = new Set();

  // Try common event list selectors used by Croatian tourism WordPress sites
  const candidates = $(
    '.event-item, .dogadanje, article.event, ' +
    '.events-list .item, .event, ' +
    '.tribe-event, .tribe_events_cat, ' +
    'article[class*="event"], .post-type-tribe_events article, ' +
    '.tribe-events-calendar td.tribe_events_cat, ' +
    '.tribe-events-loop .tribe-event-url'
  );

  candidates.each((_, el) => {
    const $el = $(el);

    const title =
      $el.find('.tribe-event-url, .tribe-events-list-event-title a, .event-title, h2 a, h3 a, h2, h3, .title')
        .first().text().trim() ||
      $el.find('a').first().text().trim();

    const dateAttr =
      $el.find('time[datetime]').attr('datetime') ||
      $el.find('abbr.tribe-events-abbr[title]').attr('title') || '';

    const dateText =
      $el.find('.tribe-event-date-start, .event-date, .date, time').first().text().trim() ||
      $el.find('[class*="date"]').first().text().trim();

    const href =
      $el.find('.tribe-event-url, .tribe-events-list-event-title a, a[href*="dogadanj"]').first().attr('href') ||
      $el.find('a').first().attr('href') || '';

    const link = href.startsWith('http') ? href : href ? `https://brela.hr${href}` : '';

    if (!title) return;

    const date = parseDate(dateAttr || dateText, monthKey);
    if (!date) return;

    // Deduplicate within the scraped batch
    const key = `${title}|${date}`;
    if (seen.has(key)) return;
    seen.add(key);

    events.push({ title, date, link });
  });

  return events;
}

/**
 * Parse a raw date string to YYYY-MM-DD.
 * Handles ISO datetime attributes, DD.MM.YYYY, and DD.MM. (year inferred from monthKey).
 */
function parseDate(raw, monthKey) {
  if (!raw) return null;

  // ISO datetime attr: "2025-07-15" or "2025-07-15T00:00:00"
  const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];

  // DD.MM.YYYY
  const dmyMatch = raw.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dmyMatch) {
    const [, d, m, y] = dmyMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // DD.MM. (no year — infer from monthKey)
  const dmMatch = raw.match(/(\d{1,2})\.(\d{1,2})\./);
  if (dmMatch) {
    const [, d, m] = dmMatch;
    const year = monthKey.slice(0, 4);
    return `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  return null;
}

module.exports = { fetchBrelaEvents };
