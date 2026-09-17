const axios = require('axios');
const cheerio = require('cheerio');

const puppeteer = require('puppeteer');
// const puppeteer = require('puppeteer-extra');
// const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// puppeteer.use(StealthPlugin());

const BASE_URL = 'https://www.letrot.com';

const chrome_path = '/usr/bin/google-chrome';
//const chrome_path = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

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

// --------------------------------------------------- //
//         Site LeTrot.com (categorie trot)            //
// --------------------------------------------------- //

/**
 * Scrape the day's program: list of reunions with their courses
 * Returns: [{ reunion_id, hippodrome, date, heure, courses: [{num, heure, url}] }]
 */
async function getDayProgram(dateOrSlug = 'aujourd-hui') {
  const date = resolveDate(dateOrSlug);
  const slug = ['aujourd-hui', 'demain', 'hier'].includes(dateOrSlug)
    ? dateOrSlug
    : date;

  // Puppeteer pour charger le JS
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chrome_path,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--disable-gpu']
  });

  let html = '';
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    await page.goto(`https://www.letrot.com/courses/${slug}`, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Attendre que les blocs soient rendus
    await page.waitForSelector('[data-test-id="meeting-view-item"]', { timeout: 15000 });

    html = await page.content();
  } finally {
    await browser.close();
  }

  const $ = cheerio.load(html);
  const reunions = [];
  const seenReunions = new Set();
  const seenQualifs = new Set();

  // ── Courses normales ──────────────────────────────────────────────────────
  $('[data-test-id="meeting-view-item"]').each((_, block) => {
    const $block = $(block);

    // Chercher un lien /courses/programme/ dans ce block
    const $progLink = $block.find('a[href*="/courses/programme/"]').first();
    if (!$progLink.length) return;

    const href = $progLink.attr('href') || '';
    const match = href.match(/\/courses\/programme\/[\d-]+\/(\d+)/);
    if (!match) return;

    const reunion_id = match[1];
    if (seenReunions.has(reunion_id)) return;
    seenReunions.add(reunion_id);

    // Hippodrome depuis le <h2> dans le lien
    const hippodromeVal = $progLink.find('h2').text().trim().toUpperCase()
      || $progLink.text().replace(/R\d+\s*/, '').trim().toUpperCase();

    // Heure depuis data-updatable="heureReunion"
    const heure = $block.find('[data-updatable="heureReunion"]').first().text().trim() || '';

    let hippodrome = hippodromeVal.replace(heure, '');

    const reunion = { reunion_id, hippodrome, date, heure, courses: [], type: 'course' };
    reunions.push(reunion);

    // Courses du bloc: liens /courses/YYYY-MM-DD/{reunion_id}/{num}
    $block.find(`a[href*="/courses/${date}/${reunion_id}/"]`).each((_, el) => {
      const courseHref = $(el).attr('href') || '';
      const courseMatch = courseHref.match(/\/courses\/([\d-]+)\/(\d+)\/(\d+)$/);
      if (!courseMatch) return;

      const num = courseMatch[3];
      if (reunion.courses.find(c => c.num === num)) return;

      // Discipline depuis icon-monte ou icon-attele
      let discipline = 'Attelé';
      const $el = $(el);
      if ($el.find('.icon-monte').length) discipline = 'Monté';
      else if ($el.find('.icon-attele').length) discipline = 'Attelé';

      // Heure de la course
      const heureC = $el.find('[data-updatable="heureCourse"]').text().trim() || '';

      console.log(`✅ course R${reunions.length}C${num} ${reunion.hippodrome} ${heureC}`);

      reunion.courses.push({
        num,
        heure: heureC,
        url:   `/courses/${date}/${reunion_id}/${num}`,
        code:  `R${reunions.length}C${num}`,
        discipline,
        type:  'course',
      });
    });
  });

  return reunions.filter(r => r.courses.length > 0);
}

/**
 * Scrape one course page: partants with basic info
 * Returns: { prix, hippodrome, discipline, date, distance, dotation, partants[] }
 */
async function getCoursePartants(date, reunion_id, num_course) {
  const url = `https://www.letrot.com/courses/${date}/${reunion_id}/${num_course}`;

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chrome_path,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
  });

  let html = '';
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Attendre que le tableau des partants soit chargé
    await page.waitForSelector('a[href*="/stats/chevaux/"]', { timeout: 15000 })
      .catch(() => console.warn('⚠️ Aucun partant trouvé'));

    html = await page.content();
  } finally {
    await browser.close();
  }

  const $ = cheerio.load(html);

  // Reunion code + Hippodrome — depuis <div translate="no">R2\n        CAEN</div>
  let hippodrome = '';
  let reunion_code = '';

  $('div[translate="no"].md\\:hidden.font-semibold.text-grey').each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      const match = text.match(/^(R\d+)\s+(.+)$/i);
      if (match) {
        reunion_code = match[1];
        hippodrome = match[2].trim();
      }
      else{
        reunion_code = reunion_id;
        hippodrome = text; 
      }
  });

  // Discipline — depuis la classe CSS icon-monte ou icon-attele
  let discipline = 'Attelé';
  if ($('.icon-monte').length)   discipline = 'Monté';
  else if ($('.icon-attele').length) discipline = 'Attelé';

  // Distance + Dotation + nb_partants — depuis "Course F  - 12 partants - 2450m - 21000€"
  const courseInfo = $('[class*="self-center"]').text().trim();
  const distMatch  = courseInfo.match(/(\d{3,4})m/);
  const dotMatch   = courseInfo.match(/([\d\s]+)\s*€/);
  const nbMatch    = courseInfo.match(/(\d+)\s+partants/);
  const distance   = distMatch ? distMatch[1] : '';
  const dotation   = dotMatch  ? dotMatch[1].replace(/\s/g, '') : '';
  const nb_partants = nbMatch  ? parseInt(nbMatch[1]) : 0;

  // Prix — depuis le h1: "C1 PRIX DE BREHAL"
  const prix = $('h1[translate="no"]').text().trim().replace(/^C\d+\s+/, '');

  // Partants — liens /stats/chevaux/{slug}/{horse_id}/courses
  const partants = [];
  $('#partants-arrives a[href*="/stats/chevaux/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const nom  = $(el).text().trim().toUpperCase();

    const idMatch = href.match(/\/stats\/chevaux\/([^/]+)\/([^/]+)\/courses/);
    if (!idMatch || !nom || nom.length < 2) return;

    const slug     = idMatch[1];
    const horse_id = idMatch[2];

    if (partants.find(p => p.horse_id === horse_id)) return;

    partants.push({
      nom,
      slug,
      horse_id,
      cheval_url: `/stats/chevaux/${slug}/${horse_id}/courses`,
    });
  });

  console.log(`✅ ${partants.length} partants trouvés — ${prix} (${hippodrome}) | ${url}`);

  return { prix, reunion_code, hippodrome, discipline, date, distance, dotation, nb_partants, partants };
}


/**
 * Scrape a horse's detail page: naissance, père, mère, réduction, etc.
 * Returns: { nom, naissance, pere, mere, sexe, record, gains, reduction, reduction_date, reduction_lieu, discipline_qualif }
 */
async function getHorseDetails(slug, horse_id, _skipGrandParent = false) {
  const path = `/stats/chevaux/${slug}/${horse_id}/courses`;
  const $ = await fetchPage(path);

  const pageText = $('body').text();

  const nom = $('h1').first().text().trim().toUpperCase();

  const naissMatch = pageText.match(/Année de nais\.\s*\n?\s*(\d{4})/);
  const naissance = naissMatch ? naissMatch[1] : '';

  const sexeMatch = pageText.match(/Sexe\s*\n?\s*([A-Z])/);
  const sexe = sexeMatch ? sexeMatch[1] : '';

  // Père et Mère récupérés via leur label (.text-xs), plus fiable que l'ordre des liens
  let pere = '', pere_href = '';
  let mere = '', mere_href = '';

  $('.text-xs').each((i, el) => {
    const label = $(el).text().trim();
    if (label === 'Père' || label === 'Mère') {
      const link = $(el).parent().find('a').first();
      const value = link.find('.text-normal').text().trim().toUpperCase();
      const href = link.attr('href') || '';
      if (label === 'Père') { pere = value; pere_href = href; }
      if (label === 'Mère') { mere = value; mere_href = href; }
    }
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

  // --- Récupération du père de la mère (grand-père maternel) ---
  let pere_de_la_mere = '';
  if (!_skipGrandParent && mere_href) {
    const m = mere_href.match(/\/stats\/chevaux\/([^/]+)\/([^/]+)\/courses/);
    if (m) {
      const [, mereSlug, mereId] = m;
      try {
        const mereDetails = await getHorseDetails(mereSlug, mereId, true); // true = évite une récursion infinie
        pere_de_la_mere = mereDetails.pere;
      } catch (e) {
        // page de la mère non trouvée ou erreur réseau : on laisse vide
        pere_de_la_mere = '';
      }
    }
  }

  return {
    nom, naissance, pere, mere, sexe, record, gains,
    reduction, reduction_date, reduction_lieu, discipline_qualif,
    peremere: pere_de_la_mere
  };
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
    executablePath: chrome_path,
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
    executablePath: chrome_path,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-gpu'
    ]
  });

  let html = '';
  const MAX_RETRIES = 3;

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9' });

    // ── 1. Retry loop ──────────────────────────────────────────────────────────
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`🔄 Tentative ${attempt}/${MAX_RETRIES} — ${url}`);

        // networkidle2 = au plus 2 requêtes réseau pendant 500ms → page vraiment chargée
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

        // ── 2. Attente intelligente : tbody visible ET au moins 1 ligne ────────
        await page.waitForFunction(
          () => {
            const rows = document.querySelectorAll('tbody tr');
            return rows.length > 0;
          },
          { timeout: 20000 }
        );

        // ── 3. Double-check : attendre que les liens chevaux soient présents ──
        //    Si après 10s toujours pas de lien → on accepte quand même (qualification vide possible)
        await page.waitForSelector('a[href*="/stats/chevaux/"]', { timeout: 10000 })
          .catch(() => console.warn('⚠️ Aucun lien cheval — page peut-être vide ou structure différente'));

        // ── 4. Scroll pour forcer le rendu des lignes lazy ────────────────────
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await new Promise(r => setTimeout(r, 800)); // petit délai post-scroll

        html = await page.content();

        // Validation rapide avant de sortir du retry
        if (html.includes('/stats/chevaux/') || html.includes('tbody')) break;

        if (attempt < MAX_RETRIES) {
          console.warn(`⚠️ HTML semble incomplet, nouvelle tentative…`);
          await new Promise(r => setTimeout(r, 2000 * attempt)); // backoff exponentiel
        }

      } catch (err) {
        console.error(`❌ Tentative ${attempt} échouée :`, err.message);
        if (attempt === MAX_RETRIES) throw err;
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }

  } finally {
    await browser.close();
  }

  // ── Parsing inchangé (tu avais un bug : `discipline` déclaré deux fois) ────
  const $ = cheerio.load(html);

  const title = $('title').text();
  const hippoMatch = title.match(/Qualification\s+([^\d]+?)\s+\d{2}\/\d{2}\/\d{4}/i);
  const hippodrome = hippoMatch ? hippoMatch[1].trim().toUpperCase() : '';

  let disciplineGlobal = 'Attelé';
  const bodyText = $('body').text();
  if (bodyText.includes('Monté'))       disciplineGlobal = 'Monté';
  else if (bodyText.includes('Attelé')) disciplineGlobal = 'Attelé';

  const distMatch = bodyText.match(/(\d{3,4})\s*m/);
  const distance = distMatch ? distMatch[1] : '';

  const engages = [];
  $('tbody tr').each((_, row) => {
    const $row = $(row);

    const lot = $row.find('.cel-0').first().text().trim();

    const $link = $row.find('.cel-2 a[href*="/stats/chevaux/"]').first();
    if (!$link.length) return;

    const href = $link.attr('href') || '';
    const nom  = $link.text().trim().toUpperCase();

    const idMatch = href.match(/\/stats\/chevaux\/([^/]+)\/([^/]+)\/courses/);
    if (!idMatch || !nom || nom.length < 2) return;

    const slug     = idMatch[1];
    const horse_id = idMatch[2];

    if (engages.find(p => p.horse_id === horse_id)) return;

    const sa = $row.find('.cel-3').text().trim();
    const disciplineRow = $row.find('.cel-7').text().trim() || disciplineGlobal; // ← fix bug

    engages.push({
      nom,
      slug,
      horse_id,
      lot,
      sexe_age: sa,
      discipline: disciplineRow,
      cheval_url: `/stats/chevaux/${slug}/${horse_id}/courses`,
    });
  });

  console.log(`✅ ${engages.length} engagés trouvés`);

  return { prix: 'QUALIFICATION', hippodrome, discipline: disciplineGlobal, date, distance, engages };
}

/**
 * get perf cheval
 * exemple of URL = https://www.equidia.fr/chevaux/harry-angel
 */
async function getHorsePerf(urlPerfs) {
    const browser = await puppeteer.launch({
        headless: true,
        executablePath: chrome_path,
        args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--disable-gpu'
        ]
    });

    try {
        const page = await browser.newPage();

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({'Accept-Language': 'fr-FR,fr;q=0.9'});

        await page.goto(urlPerfs, {
            waitUntil: 'networkidle2',
            timeout: 30000
        });

        // attendre que les courses soient rendues
        await page.waitForSelector('.link-course.clickable',{ timeout: 15000 });

        // attendre que les position ne sont pas la
        await page.waitForSelector('.classm',{ timeout: 15000 }); 

        const html = await page.content();

        const $ = cheerio.load(html);
        const performances = [];

        console.log("element place length Html: " + $('.classm').length);
        console.log("element course length Html: " + $('.link-course.clickable').length);

        $('tr.customable-table--row.collapse-row').each((_, row) => {
          // -------------------------
          // COURSE
          // -------------------------
          const courseEl = $(row).find('.link-course.clickable');

          if (!courseEl.length) return;

          const rawText = courseEl.text().replace(/\s+/g, ' ').trim();

          // nom course
          const parts = rawText.split(' - ').map(v => v.trim());

          const prix = parts[0] || null;

          // -------------------------
          // DATE
          // -------------------------
          const dateMatch = rawText.match(/(\d{2})\/(\d{2})\/(\d{2})/);

          let date = null;

          if (dateMatch) {
              const [, day, month, year] = dateMatch;
              date = `20${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
          }

          // -------------------------
          // LINK
          // -------------------------
          const raceMatch = rawText.match(/R(\d+)C(\d+)/);
          let link = null;

          if (raceMatch && date) {
              const [, race, course] = raceMatch;
              link = `https://www.equidia.fr/courses/${date}/R${race}/C${course}`;
          }

          // -------------------------
          // PLACE = ligne précédente
          // -------------------------
          const prevRow = $(row).prev('tr.customable-table--row');
          const placeText = prevRow.find('.classm').text().replace(/\s+/g, ' ').trim();
          const place = parseInt(placeText, 10) || placeText;

          // -------------------------
          //  Hippodromme
          // -------------------------
          const hippodrome = prevRow.find('.hippodrome').text().replace(/\s+/g, ' ').trim();

          // -------------------------
          //  Prix
          // -------------------------
          const prixVal = prevRow.find('.prix').text().replace(/\s+/g, ' ').trim();

          performances.push({
              date,
              place,
              prix : `${prixVal} (${hippodrome})`,
              link
          });

          console.log({
              date,
              place,
              prix: `${prixVal} (${hippodrome})`,
              link
          });
      });
      return performances;
    } finally {
        await browser.close();
    }
}

/**
 * get perf cheval LeTrot
 * exemple of URL = https://www.letrot.com/stats/chevaux/nuit-du-pont/ZmF8ZQMHBQUZ/courses
 */
async function getHorsePerfLeTrot(urlPerfs){
  const browser = await puppeteer.launch({
      headless: true,
      executablePath: chrome_path,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-gpu'
      ]
  });

  try {

    const page = await browser.newPage();

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({'Accept-Language': 'fr-FR,fr;q=0.9'});

    await page.goto(urlPerfs, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // attendre que les courses soient rendues
    await page.waitForSelector('#performances',{ timeout: 15000 });

    const html = await page.content();

    const $ = cheerio.load(html);
    const performances = [];

    $('#performances tbody tr').each((_, row) => {
      const $row = $(row);

      // Date + link (cel-0)
      const $dateCell = $row.find('.cel-0');
      const date = $dateCell.find('a').first().text().trim().replace(/(\d{2})\/(\d{2})\/(\d{2})/, '20$3-$2-$1');

      if(date != ""){

        const link = $dateCell.find('a').first().attr('href');

        // Hippodrome + Prix (cel-7)
        const $hippoCell = $row.find('.cel-7');
        const hippodrome = $hippoCell.find('a').first().text().trim();
        const prixVal = $hippoCell.find('a').last().text().trim();

        let place = '-';
        // Rang (cel-1)
        if(prixVal.includes('QUALIFICATION')){
          place = $row.find('.cel-2 #is-justify-2.cel-main').text().trim();
        }else{
          place = $row.find('.cel-1 span.border-b-2').text().trim();
        }

        performances.push({
          date,
          place,
          prix: `${prixVal} (${hippodrome})`,
          link: link ? `https://www.letrot.com${link}` : null
        });

        console.log({
            date,
            place,
            prix: `${prixVal} (${hippodrome})`,
            link
        });

      }

    });

    return performances;

  } finally {
      await browser.close();
  }

}

// --------------------------------------------------- //
//         Site Equidia (categorie galop)              //
// --------------------------------------------------- //

/**
 * Scrape the day's program: list of reunions with their courses Galop (date with YYYY-MM-DD format)
 * Returns: [{ reunion_id, hippodrome, date, heure, courses: [{num, heure, url}] }]
*/
async function getDayProgramEquidia(date){
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chrome_path,
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
 
  await page.goto(`https://www.equidia.fr/courses-hippique/galop?date=${date}`, { waitUntil: 'networkidle2', timeout: 30000 });
 
  await new Promise(resolve => setTimeout(resolve, 3000));
 
  // Sélecteur par classes multiples (au lieu de [class="..."] exact) :
  // matche toute réunion possédant ces 4 classes de base, qu'elle soit
  // "normale" (fill-primary-blue) ou "live" (fill-primary-red text-primary-red live-row)
  const REUNION_SELECTOR = '.row.clickable.table-row.row-reunion';
 
  await page.waitForSelector(REUNION_SELECTOR, { timeout: 15000 })
    .catch(() => console.warn('⚠️ Blocs non trouvés'));
 
  await page.waitForSelector('[class="course-container"]', { timeout: 15000 })
    .catch(() => console.warn('⚠️ course non trouvés'));
 
  const html = await page.content();
  await browser.close();
 
  const $ = cheerio.load(html);
  const reunions = [];
 
  const $blocksAll = $(REUNION_SELECTOR).not('[hidden]');
  console.log('Nb blocks meeting-view-item (blue + red/live):', $blocksAll.length);
 
  // ── Courses normales + live ─────────────────────────────────────────────
  $blocksAll.each((i, block) => {
    const $block = $(block);
 
    // Détection live : présence des classes fill-primary-red / live-row
    const classList = ($block.attr('class') || '').split(/\s+/);
    const isLive = classList.includes('live-row') || classList.includes('fill-primary-red');
 
    // ── reunion_id : extraire "R1" depuis l'attribut xlink:href="#logo-R1" ──
    let reunion_id = null;
    $block.find('use').each((_, use) => {
      const h = $(use).attr('href') || $(use).attr('xlink:href') || '';
      const m = h.match(/#logo-ER(\d+)/);
      if (m) {
        reunion_id = `R${m[1]}`;
        return false; // break
      }
    });
 
    // Fallback : index réel dans la liste (corrige le bug de `i` non défini)
    if (!reunion_id) reunion_id = `R${i + 1}`;
 
    // ── hippodrome ────────────────────────────────────────────────────────
    const hippodrome = $block.find('.reunion-lieu').text().trim();
 
    // ── heure de la réunion (heure de début diffusion) ──────────────────────
    const heure = $block.find('.hour-reunion').text().trim();
 
    // ── courses ───────────────────────────────────────────────────────────
    const courses = [];
    $block.find('.course-container').each((_, container) => {
      const $container = $(container);
 
      // Ignore les courses masquées (attribut hidden)
      if ($container.is('[hidden]')) {
        return; // équivalent de "continue" dans .each()
      }
 
      // Numéro : texte du <a class="num-course">, ex: " C1 " → 1
      const numText = $container.find('a.num-course').contents().filter(function() {
        return this.nodeType === 3; // nœud texte uniquement (ignore les <img>)
      }).text().trim(); // "C1"
 
      // Heure de la course
      const heureCourse = $container.find('.font-size-caption.text-primary-blue').text().trim();
 
      // URL construite (les <a> n'ont pas de href dans le HTML rendu)
      const url = numText && reunion_id
        ? `https://www.equidia.fr/courses/${date}/${reunion_id}/${numText}`
        : null;
 
      if (numText) {
        console.log(url);
        courses.push({ numText, heure: heureCourse, url });
      }
    });
 
    reunions.push({ reunion_id, hippodrome, date, heure, live: isLive, courses });
  });
 
  return reunions;
}

async function clickByIndex(page, selector, index) {
  await page.evaluate((sel, idx) => {
    const els = document.querySelectorAll(sel);
    if (els[idx]) els[idx].click();
  }, selector, index);
}

/**
 * Attend que le DOM soit totalement débarrassé de toute modale.
 * On ne teste plus la "visibilité" (offsetParent, display, etc.) car un
 * élément .modal-body peut rester présent en DOM (contenu déjà vidé par
 * Angular) pendant l'animation de fermeture, ce qui crée une ambiguïté
 * avec la modale suivante qui s'ouvre par-dessus.
 * On veut : querySelectorAll('.modal-body').length === 0
 */
async function closeModalIfOpen(page) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const count = await page.$$eval('.modal-body', els => els.length);
    if (count === 0) return true;

    // Clic natif sur le bouton close
    await page.evaluate(() => {
      const btn = document.querySelector('button[aria-label="Close"]');
      if (btn) btn.click();
    });

    // On attend la disparition COMPLETE du DOM (pas juste "hidden")
    const closed = await page.waitForFunction(
      () => document.querySelectorAll('.modal-body').length === 0,
      { timeout: 4000 }
    ).then(() => true).catch(() => false);

    if (closed) return true;

    // Fallback : Escape
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 600));
  }

  const finalCount = await page.$$eval('.modal-body', els => els.length);
  return finalCount === 0;
}

/**
 * Attend qu'exactement UNE modale soit ouverte et que son .nom-cheval
 * contienne un texte non vide, différent du cheval précédent, ET stable
 * (relu deux fois à 150ms d'intervalle) pour éviter de capturer un état
 * transitoire pendant le rendu Angular.
 */
async function waitForStableModal(page, previousNom, timeout = 10000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const count = await page.$$eval('.modal-body', els => els.length);

    if (count === 1) {
      const nom1 = await page.$eval('.modal-body .nom-cheval', el =>
        el.textContent.replace(/\s+/g, ' ').trim()
      ).catch(() => '');

      if (nom1 && nom1 !== previousNom) {
        await new Promise(r => setTimeout(r, 150));

        const countAfter = await page.$$eval('.modal-body', els => els.length);
        if (countAfter !== 1) continue; // état instable, on reboucle

        const nom2 = await page.$eval('.modal-body .nom-cheval', el =>
          el.textContent.replace(/\s+/g, ' ').trim()
        ).catch(() => '');

        if (nom2 === nom1) {
          return true; // texte stable sur deux lectures consécutives
        }
      }
    }

    await new Promise(r => setTimeout(r, 100));
  }

  return false;
}

/**
 * Scrape one course page: partants with basic info (Equidia)
 * Returns: [{ nom, naissance, sexe, pere, mere, discipline, date, course, prix, hippodrome, distance, record, gains, reduction, reduction_date, reduction_lieu, urlPerfs }]
 */
async function getCoursePartantsEquidia(hippodrome_course, date_course, reunion_id, num_course) {
  const url = `https://www.equidia.fr/courses/${date_course}/${reunion_id}/${num_course}`;

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chrome_path,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
  });

  const result = [];

  function extractLabelValuePairs($, container) {
    const data = {};
    $(container).find('.info-cheval').each((i, el) => {
      const label = $(el).text().replace(':', '').trim();
      const parentText = $(el).parent().text().trim();
      const value = parentText.replace($(el).text(), '').trim();
      data[label] = value;
    });
    return data;
  }

  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    const cookie = await page.waitForSelector('button[aria-label="Consent"]', { timeout: 20000 })
      .catch(() => console.warn('Aucun cookie trouvé'));
    if (cookie) await cookie.click();

    await page.waitForSelector('.table-row.clickable', { timeout: 15000 })
      .catch(() => console.warn('⚠️ Aucun partant trouvé'));

    const htmlCourse = await page.content();
    const $course = cheerio.load(htmlCourse);

    const discipline = $course('.condition-summary--main--info').text().trim();
    const prix = $course('h1').text().trim();
    const distance = $course('.condition-summary--piste--details ul li').text().trim();
    const course = `${reunion_id}${num_course}`;

    const nbPartants = (await page.$$('.table-row.clickable')).length;
    console.log(`Course chargée : ${prix} - ${nbPartants} partants`);

    let previousNom = null;

    for (let i = 0; i < nbPartants; i++) {
      let success = false;

      for (let retry = 0; retry < 3 && !success; retry++) {
        try {
          // 1. S'assurer qu'aucune modale ne traîne dans le DOM
          const closedBefore = await closeModalIfOpen(page);
          if (!closedBefore) {
            console.warn(`⚠️ [i=${i}] Impossible de nettoyer le DOM avant clic (retry ${retry})`);
          }

          // 2. Cliquer sur la ligne
          await clickByIndex(page, '.table-row.clickable', i);

          // 3. Attendre une modale UNIQUE avec un contenu stable
          const stable = await waitForStableModal(page, previousNom, 10000);
          if (!stable) {
            throw new Error('Modale non stabilisée (contenu vide, dupliqué, ou inchangé)');
          }

          await new Promise(r => setTimeout(r, 200));

          const htmlModal = await page.content();
          const $ = cheerio.load(htmlModal);
          const modal = $('.modal-body');

          const nom = modal.find('.nom-cheval').clone().find('app-favorite-star').remove().end().text().trim();

          if (!nom) {
            throw new Error('Nom vide après extraction cheerio');
          }

          previousNom = nom;

          const musique = modal.find('.musique-cheval').text().trim();

          const jockeyEntraineurProprio = extractLabelValuePairs($, modal.find('.flex-container-2.block-info-cheval .col-6').first());
          const perePere = extractLabelValuePairs($, modal.find('.flex-container-2.block-info-cheval .col-6').eq(1));

          const noteEquidia = modal.find('app-final-note .final-note').first().text().trim();
          const cotePmu = modal.find('.block-cote-graph .info').first().text().replace(/\s+/g, ' ').trim();

          const hrefFiche = modal.find('a.button-complete-display').attr('href');
          const urlFiche = hrefFiche ? `https://www.equidia.fr${hrefFiche}` : null;

          let infosComplementaires = {};
          if (urlFiche) {
            const detailPage = await browser.newPage();
            try {
              await detailPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
              await detailPage.goto(urlFiche, { waitUntil: 'networkidle2', timeout: 30000 });
              await detailPage.waitForSelector('.block-informations', { timeout: 10000 }).catch(() => {});
              const htmlDetail = await detailPage.content();
              const $d = cheerio.load(htmlDetail);
              infosComplementaires = extractLabelValuePairs($d, $d('.block-informations'));
            } catch (e) {
              console.warn(`⚠️ Erreur fiche complète pour ${nom}:`, e.message);
            } finally {
              await detailPage.close();
            }
          }

          result.push({
            nom,
            naissance: infosComplementaires['Age'] || null,
            sexe: infosComplementaires['Sexe'] || null,
            pere: perePere['Père'] || infosComplementaires['Père'] || null,
            mere: perePere['Mère'] || infosComplementaires['Mère'] || null,
            discipline,
            date: date_course,
            course,
            prix,
            hippodrome: hippodrome_course,
            distance,
            record: musique,
            gains: "",
            reduction: noteEquidia,
            reduction_date: "",
            reduction_lieu: "",
            urlPerfs: urlFiche,

            cote_pmu: cotePmu,
            jockey: jockeyEntraineurProprio['Jockey'] || null,
            entraineur: jockeyEntraineurProprio['Entraineur'] || infosComplementaires['Entraineur'] || null,
            proprietaire: jockeyEntraineurProprio['Propriétaire'] || infosComplementaires['Propriétaire'] || null,
            peremere: infosComplementaires['Père de la mère'] || null,
            eleveur: infosComplementaires['Éleveur'] || null,
            race: infosComplementaires['Race'] || null,
            robe: infosComplementaires['Robe'] || null
          });

          console.log(`✔ ${nom} récupéré`);

          const closedAfter = await closeModalIfOpen(page);
          if (!closedAfter) console.warn(`⚠️ [i=${i}] Modal non fermé après ${nom}`);

          success = true;

        } catch (err) {
          console.warn(`⚠️ [i=${i}] Échec tentative ${retry}:`, err.message);
          await closeModalIfOpen(page); // nettoyage avant retry ou passage au suivant
          await new Promise(r => setTimeout(r, 300));
        }
      }

      if (!success) {
        console.warn(`❌ [i=${i}] Abandon définitif après 3 tentatives`);
      }
    }

  } finally {
    await browser.close();
  }

  return result;
}

module.exports = {
  getDayProgram, getCoursePartants, getHorseDetails, resolveDate,
  getCourseEngages, getDayQualification,
  withRetry, poolAll, getHorsePerf,getHorsePerfLeTrot, 
  getDayProgramEquidia, getCoursePartantsEquidia
};
