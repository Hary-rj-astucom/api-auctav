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

  // Each reunion block
  $('a[href*="/courses/programme/"]').each((_, el) => {

    console.log("tafiditra 1");

    const href = $(el).attr('href') || '';
    const match = href.match(/\/courses\/programme\/[\d-]+\/(\d+)/);
    if (!match) return;

    const reunion_id = match[1];
    const text = $(el).text();

    // Extract hippodrome name
    const hippoMatch = text.match(/R\d+\s+([A-ZÀÂÄÉÈÊËÎÏÔÙÛÜ\-\s]+?)(?:\s+terminée|\s+\d+courses|$)/i);
    const hippodrome = hippoMatch ? hippoMatch[1].trim() : '';

    // Extract heure
    const heureMatch = text.match(/(\d{2}:\d{2})/);
    const heure = heureMatch ? heureMatch[1] : '';

    reunions.push({ reunion_id, hippodrome, date, heure, courses: [] });
  });

  // Course links: /courses/YYYY-MM-DD/{reunion_id}/{num}
  $(`a[href*="/courses/${date}/"]`).each((_, el) => {

    console.log("tafiditra 2");

    const href = $(el).attr('href') || '';
    const match = href.match(/\/courses\/([\d-]+)\/(\d+)\/(\d+)$/);
    if (!match) return;

    const [, courseDate, reunion_id, num] = match;
    const reunion = reunions.find(r => r.reunion_id === reunion_id);
    if (!reunion) return;

    // Avoid duplicates
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

  // Remove reunions with no courses
  return reunions.filter(r => r.courses.length > 0);
}

/**
 * Scrape one course page: partants with basic info
 * Returns: { prix, hippodrome, discipline, date, distance, dotation, partants[] }
 */
async function getCoursePartants(date, reunion_id, num_course) {
  const path = `/courses/${date}/${reunion_id}/${num_course}`;
  const $ = await fetchPage(path);

  // Prix & hippodrome from title
  const title = $('title').text();
  const prixMatch = title.match(/C\d+\s+([^:]+?)\s*:/);
  const prix = prixMatch ? prixMatch[1].trim() : '';

  // Hippodrome from breadcrumb or heading
  let hippodrome = '';
  $('a[href*="/courses/programme/"]').each((_, el) => {
    const t = $(el).text().trim();
    if (t && !t.match(/^\d/)) hippodrome = t;
  });

  // Discipline
  let discipline = 'Attelé';
  $('*').each((_, el) => {
    const t = $(el).text();
    if (t.includes('Monté')) { discipline = 'Monté'; return false; }
    if (t.includes('Attelé')) { discipline = 'Attelé'; return false; }
    if (t.includes('Plat'))   { discipline = 'Plat';   return false; }
    if (t.includes('Haie') || t.includes('Steeple')) { discipline = 'Obstacle'; return false; }
  });

  // Distance & dotation
  const pageText = $('body').text();
  const distMatch = pageText.match(/(\d{3,4})m/);
  const distance = distMatch ? distMatch[1] : '';
  const dotMatch = pageText.match(/([\d\s]+)\s*€/);
  const dotation = dotMatch ? dotMatch[1].replace(/\s/g, '') : '';

  // Partants: extract horse name + letrot URL from links in the table
  const partants = [];
  $('a[href*="/stats/chevaux/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const nom = $(el).text().trim().toUpperCase();
    // href format: /stats/chevaux/{slug}/{horse_id}/courses
    const idMatch = href.match(/\/stats\/chevaux\/([^/]+)\/([^/]+)\/courses/);
    if (!idMatch || !nom || nom.length < 2) return;

    const slug = idMatch[1];
    const horse_id = idMatch[2];

    // Avoid duplicates
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

  const getText = (label) => {
    let val = '';
    $('*').each((_, el) => {
      if ($(el).text().trim() === label) {
        val = $(el).next().text().trim() || $(el).parent().next().text().trim();
        return false;
      }
    });
    return val;
  };

  const pageText = $('body').text();

  // Nom
  const nom = $('h1').first().text().trim().toUpperCase();

  // Année de naissance
  const naissMatch = pageText.match(/Année de nais\.\s*\n?\s*(\d{4})/);
  const naissance = naissMatch ? naissMatch[1] : '';

  // Sexe
  const sexeMatch = pageText.match(/Sexe\s*\n?\s*([A-Z])/);
  const sexe = sexeMatch ? sexeMatch[1] : '';

  // Père
  const pere = $('a[href*="/stats/chevaux/"]').first().text().trim().toUpperCase();

  // Mère (2e lien cheval)
  let mere = '';
  $('a[href*="/stats/chevaux/"]').each((i, el) => {
    if (i === 1) { mere = $(el).text().trim().toUpperCase(); return false; }
  });

  // Gains
  const gainsMatch = pageText.match(/Gains Totaux\s*\n?\s*([\d\s]+)/);
  const gains = gainsMatch ? gainsMatch[1].replace(/\s/g, '') : '';

  // Record
  const recordMatch = pageText.match(/Record absolu\s*\n?\s*([\d'"]+)/);
  const record = recordMatch ? recordMatch[1] : '';

  // Qualification: date + reduction + lieu + discipline
  const qualifMatch = pageText.match(
    /(\d{2}\/\d{2}\/\d{4})\s*[-–]\s*([\d'"]+)\s*[-–]\s*(attelé|monté|Attelé|Monté)\s*[-–]\s*([A-ZÀÂÄÉÈÊËÎÏÔÙÛÜ\-\s]+)/i
  );
  let reduction = '', reduction_date = '', reduction_lieu = '', discipline_qualif = '';
  if (qualifMatch) {
    reduction_date     = qualifMatch[1];
    reduction          = qualifMatch[2];
    discipline_qualif  = qualifMatch[3];
    reduction_lieu     = qualifMatch[4].trim();
  }

  return { nom, naissance, sexe, pere, mere, gains, record, reduction, reduction_date, reduction_lieu, discipline_qualif };
}

/**
 * List of the qualifacation
 * Returns: [{ reunion_id, hippodrome, date, heure, courses: [{num, heure, url}] }]
*/
async function getDayQualification(dateOrSlug = 'aujourd-hui'){
  const date = resolveDate(dateOrSlug);
  const slug = ['aujourd-hui','demain','hier'].includes(dateOrSlug)
    ? dateOrSlug
    : date;

  const browser = await puppeteer.launch({ 
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  await page.goto(`https://www.letrot.com/courses/${slug}`, { waitUntil: 'networkidle2' });
  
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

  // Remove reunions with no courses
  return reunions.filter(r => r.courses.length > 0);
}

/**
 * Scrape one course page: qualification with basic info
 * Returns: { prix, hippodrome, discipline, date, distance, dotation, partants[] }
 */
async function getCourseEngages(date, reunion_id, qualif_id) {
  const url = `https://www.letrot.com/courses/qualifications/${date}/${reunion_id}/${qualif_id}`;

  // Puppeteer pour attendre le rendu JS
  const browser = await puppeteer.launch({ 
    headless: 'new',
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  let html = '';
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');
    
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Attendre que les liens chevaux soient présents dans le DOM
    await page.waitForSelector('a[href*="/stats/chevaux/"]', { timeout: 10000 })
      .catch(() => console.warn('⚠️ Aucun lien cheval trouvé après attente'));

    html = await page.content();
  } finally {
    await browser.close();
  }

  const $ = cheerio.load(html);

  console.log("tafiditra 3");
  console.log("Nb liens chevaux:", $('a[href*="/stats/chevaux/"]').length);

  // Hippodrome depuis le titre de la page
  const title = $('title').text();
  console.log("Title:", title);
  const hippoMatch = title.match(/Qualification\s+([^\d]+?)\s+\d{2}\/\d{2}\/\d{4}/i);
  const hippodrome = hippoMatch ? hippoMatch[1].trim().toUpperCase() : '';

  // Discipline
  let discipline = ' ';
  const bodyText = $('body').text();
  if (bodyText.includes('Monté'))   discipline = ' ';
  else if (bodyText.includes('Attelé')) discipline = ' ';

  // Distance
  const distMatch = bodyText.match(/(\d{3,4})\s*m/);
  const distance = distMatch ? distMatch[1] : '';

  // Engagés
  const engages = [];
  $('a[href*="/stats/chevaux/"]').each((_, el) => {
    console.log("tafiditra 4");

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

  return { prix:'QUALIFICATION', hippodrome, discipline, date, distance, engages };
}

module.exports = { getDayProgram, getCoursePartants, getHorseDetails, resolveDate, getCourseEngages, getDayQualification };
