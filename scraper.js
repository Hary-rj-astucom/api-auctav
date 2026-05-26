const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');

const BASE_URL = 'https://www.letrot.com';

const httpClient = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9',
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES : retry + concurrency pool
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retry an async function up to `maxAttempts` times with exponential back-off.
 * @param {() => Promise<any>} fn
 * @param {number} maxAttempts
 * @param {number} baseDelayMs
 */
async function withRetry(fn, maxAttempts = 3, baseDelayMs = 500) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        console.warn(`  ⟳ Retry ${attempt}/${maxAttempts - 1} in ${delay}ms — ${err.message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

/**
 * Run an array of async tasks with a maximum concurrency.
 * @param {Array<() => Promise<any>>} tasks
 * @param {number} concurrency
 * @returns {Promise<Array<{status:'fulfilled'|'rejected', value?: any, reason?: any}>>}
 */
async function poolAll(tasks, concurrency = 5) {
  const results = new Array(tasks.length);
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      try {
        results[i] = { status: 'fulfilled', value: await tasks[i]() };
      } catch (err) {
        results[i] = { status: 'rejected', reason: err };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch and parse HTML from a LeTrot URL
 */
async function fetchPage(path) {
  const { data } = await httpClient.get(path);
  return cheerio.load(data);
}

/**
 * Get the date string from a slug like "aujourd-hui", "demain", "hier"
 * or a YYYY-MM-DD date passed directly
 */
function resolveDate(dateOrSlug) {
  const today = new Date();
  const fmt = (d) => d.toISOString().split('T')[0];

  if (dateOrSlug === 'aujourd-hui' || !dateOrSlug) return fmt(today);
  if (dateOrSlug === 'demain') {
    const d = new Date(today); d.setDate(d.getDate() + 1); return fmt(d);
  }
  if (dateOrSlug === 'hier') {
    const d = new Date(today); d.setDate(d.getDate() - 1); return fmt(d);
  }
  return dateOrSlug; // assume YYYY-MM-DD
}

/**
 * Scrape the day's program: list of reunions with their courses
 * Returns: [{ reunion_id, hippodrome, date, heure, courses: [{num, heure, url}] }]
 */
async function getDayProgram(dateOrSlug = 'aujourd-hui') {
  const date = resolveDate(dateOrSlug);
  const slug = ['aujourd-hui','demain','hier'].includes(dateOrSlug)
    ? dateOrSlug
    : date;

  const $ = await fetchPage(`/courses/${slug}`);

  const reunions = [];

  $('a[href*="/courses/programme/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const match = href.match(/\/courses\/programme\/[\d-]+\/(\d+)/);
    if (!match) return;

    const reunion_id = match[1];
    const text = $(el).text();

    const hippoMatch = text.match(/R\d+\s+([A-ZÀÂÄÉÈÊËÎÏÔÙÛÜ\-\s]+?)(?:\s+terminée|\s+\d+courses|$)/i);
    const hippodrome = hippoMatch ? hippoMatch[1].trim() : '';

    const heureMatch = text.match(/(\d{2}:\d{2})/);
    const heure = heureMatch ? heureMatch[1] : '';

    reunions.push({ reunion_id, hippodrome, date, heure, courses: [] });
  });

  $(`a[href*="/courses/${date}/"]`).each((_, el) => {
    const href = $(el).attr('href') || '';
    const match = href.match(/\/courses\/([\d-]+)\/(\d+)\/(\d+)$/);
    if (!match) return;

    const [, courseDate, reunion_id, num] = match;
    const reunion = reunions.find(r => r.reunion_id === reunion_id);
    if (!reunion) return;

    if (reunion.courses.find(c => c.num === num)) return;

    const heureMatch = $(el).text().match(/(\d{2}:\d{2})/);
    const heure = heureMatch ? heureMatch[1] : '';

    reunion.courses.push({
      num,
      heure,
      url: `/courses/${courseDate}/${reunion_id}/${num}`,
      type: 'course',
    });
  });

  return reunions.filter(r => r.courses.length > 0);
}

/**
 * Scrape one course page: partants with basic info
 * Returns: { prix, hippodrome, discipline, date, distance, dotation, partants[] }
 */
async function getCoursePartants(date, reunion_id, num_course) {
  const path = `/courses/${date}/${reunion_id}/${num_course}`;
  const $ = await fetchPage(path);

  const title = $('title').text();
  const prixMatch = title.match(/C\d+\s+([^:]+?)\s*:/);
  const prix = prixMatch ? prixMatch[1].trim() : '';

  let hippodrome = '';
  $('a[href*="/courses/programme/"]').each((_, el) => {
    const t = $(el).text().trim();
    if (t && !t.match(/^\d/)) hippodrome = t;
  });

  let discipline = 'Attelé';
  $('*').each((_, el) => {
    const t = $(el).text();
    if (t.includes('Monté'))  { discipline = 'Monté';    return false; }
    if (t.includes('Attelé')) { discipline = 'Attelé';   return false; }
    if (t.includes('Plat'))   { discipline = 'Plat';     return false; }
    if (t.includes('Haie') || t.includes('Steeple')) { discipline = 'Obstacle'; return false; }
  });

  const pageText = $('body').text();
  const distMatch = pageText.match(/(\d{3,4})m/);
  const distance = distMatch ? distMatch[1] : '';
  const dotMatch = pageText.match(/([\d\s]+)\s*€/);
  const dotation = dotMatch ? dotMatch[1].replace(/\s/g, '') : '';

  const partants = [];
  $('a[href*="/stats/chevaux/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const nom = $(el).text().trim().toUpperCase();
    const idMatch = href.match(/\/stats\/chevaux\/([^/]+)\/([^/]+)\/courses/);
    if (!idMatch || !nom || nom.length < 2) return;

    const slug = idMatch[1];
    const horse_id = idMatch[2];

    if (partants.find(p => p.horse_id === horse_id)) return;

    partants.push({
      nom,
      slug,
      horse_id,
      cheval_url: `/stats/chevaux/${slug}/${horse_id}/courses`,
    });
  });

  return { prix, hippodrome, discipline, date, distance, dotation, partants };
}

/**
 * Scrape a horse's detail page: naissance, père, mère, réduction, etc.
 * Returns: { nom, naissance, pere, mere, sexe, record, gains, reduction, reduction_date, reduction_lieu, discipline_qualif }
 */
async function getHorseDetails(slug, horse_id) {
  const path = `/stats/chevaux/${slug}/${horse_id}/courses`;
  const $ = await fetchPage(path);

  const pageText = $('body').text();

  const nom = $('h1').first().text().trim().toUpperCase();

  const naissMatch = pageText.match(/Année de nais\.\s*\n?\s*(\d{4})/);
  const naissance = naissMatch ? naissMatch[1] : '';

  const sexeMatch = pageText.match(/Sexe\s*\n?\s*([A-Z])/);
  const sexe = sexeMatch ? sexeMatch[1] : '';

  const pere = $('a[href*="/stats/chevaux/"]').first().text().trim().toUpperCase();

  let mere = '';
  $('a[href*="/stats/chevaux/"]').each((i, el) => {
    if (i === 1) { mere = $(el).text().trim().toUpperCase(); return false; }
  });

  const gainsMatch = pageText.match(/Gains Totaux\s*\n?\s*([\d\s]+)/);
  const gains = gainsMatch ? gainsMatch[1].replace(/\s/g, '') : '';

  const recordMatch = pageText.match(/Record absolu\s*\n?\s*([\d'"]+)/);
  const record = recordMatch ? recordMatch[1] : '';

  const qualifMatch = pageText.match(
    /(\d{2}\/\d{2}\/\d{4})\s*[-–]\s*([\d'"]+)\s*[-–]\s*(attelé|monté|Attelé|Monté)\s*[-–]\s*([A-ZÀÂÄÉÈÊËÎÏÔÙÛÜ\-\s]+)/i
  );
  let reduction = '', reduction_date = '', reduction_lieu = '', discipline_qualif = '';
  if (qualifMatch) {
    reduction_date    = qualifMatch[1];
    reduction         = qualifMatch[2];
    discipline_qualif = qualifMatch[3];
    reduction_lieu    = qualifMatch[4].trim();
  }

  return { nom, naissance, sexe, pere, mere, gains, record, reduction, reduction_date, reduction_lieu, discipline_qualif };
}

/**
 * List of the qualifications
 * Returns: [{ reunion_id, hippodrome, date, heure, courses: [{num, heure, url}] }]
 */
async function getDayQualification(dateOrSlug = 'aujourd-hui') {
  const date = resolveDate(dateOrSlug);
  const slug = ['aujourd-hui','demain','hier'].includes(dateOrSlug)
    ? dateOrSlug
    : date;

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: '/usr/bin/google-chrome',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-gpu'
    ]
  });

  const page = await browser.newPage();

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9' });

  await page.goto(`https://www.letrot.com/courses/${slug}`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  await page.waitForSelector('[data-test-id="meeting-view-item"]', { timeout: 15000 })
    .catch(() => console.warn('⚠️ Blocs non trouvés'));

  const html = await page.content();
  await browser.close();

  const $ = cheerio.load(html);
  const reunions = [];
  const seenQualifs = new Set();

  console.log('Nb blocks meeting-view-item:', $('[data-test-id="meeting-view-item"]').length);

  $('[data-test-id="meeting-view-item"]').each((_, block) => {
    const $block = $(block);

    const $link = $block.find(`a[href*="/courses/qualifications/${date}/"]`).first();
    if (!$link.length) return;

    const href = $link.attr('href') || '';
    const match = href.match(/\/courses\/qualifications\/([\d-]+)\/(\d+)\/(\d+)$/);
    if (!match) return;

    const [, courseDate, reunion_id, qualif_id] = match;

    if (seenQualifs.has(qualif_id)) return;
    seenQualifs.add(qualif_id);

    const hippodrome = $link.find('h2').text().trim().toUpperCase() || '';
    const heure = $block.find('[data-updatable="heureReunion"]').first().text().trim() || '';
    const engagesMatch = $block.text().match(/(\d+)\s+engagés/);
    const nb_engages = engagesMatch ? parseInt(engagesMatch[1]) : 0;

    reunions.push({
      reunion_id, hippodrome, date, heure, nb_engages,
      courses: [{ qualif_id, url: `/courses/qualifications/${courseDate}/${reunion_id}/${qualif_id}`, type: 'qualification' }],
      type: 'qualification'
    });
  });

  return reunions.filter(r => r.courses.length > 0);
}

/**
 * Scrape one qualification page: engagés with basic info
 * Returns: { prix, hippodrome, discipline, date, distance, engages[] }
 */
async function getCourseEngages(date, reunion_id, valif_id) {
  const url = `https://www.letrot.com/courses/qualifications/${date}/${reunion_id}/${valif_id}`;

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: '/usr/bin/google-chrome',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-gpu'
    ]
  });

  let html = '';
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9' });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    await page.waitForSelector('a[href*="/stats/chevaux/"]', { timeout: 15000 })
      .catch(() => console.warn('⚠️ Aucun lien cheval trouvé après attente'));

    html = await page.content();
  } finally {
    await browser.close();
  }

  const $ = cheerio.load(html);

  const title = $('title').text();
  const hippoMatch = title.match(/Qualification\s+([^\d]+?)\s+\d{2}\/\d{2}\/\d{4}/i);
  const hippodrome = hippoMatch ? hippoMatch[1].trim().toUpperCase() : '';

  let discipline = ' ';
  const bodyText = $('body').text();
  if (bodyText.includes('Monté'))       discipline = 'Monté';
  else if (bodyText.includes('Attelé')) discipline = 'Attelé';

  const distMatch = bodyText.match(/(\d{3,4})\s*m/);
  const distance = distMatch ? distMatch[1] : '';

  const engages = [];
  $('a[href*="/stats/chevaux/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const nom  = $(el).text().trim().toUpperCase();

    const idMatch = href.match(/\/stats\/chevaux\/([^/]+)\/([^/]+)\/courses/);
    if (!idMatch || !nom || nom.length < 2) return;

    const slug     = idMatch[1];
    const horse_id = idMatch[2];

    if (engages.find(p => p.horse_id === horse_id)) return;

    engages.push({
      nom,
      slug,
      horse_id,
      cheval_url: `/stats/chevaux/${slug}/${horse_id}/courses`,
    });
  });

  console.log(`✅ ${engages.length} engagés trouvés`);

  return { prix: 'QUALIFICATION', hippodrome, discipline, date, distance, engages };
}

module.exports = {
  getDayProgram, getCoursePartants, getHorseDetails, resolveDate,
  getCourseEngages, getDayQualification,
  withRetry, poolAll,
};
