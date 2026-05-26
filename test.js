import puppeteer from 'puppeteer';
import * as cheerio from 'cheerio';

const date = '2026-05-26';

(async () => {
  const browser = await puppeteer.launch({ 
    headless: false,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  await page.goto(`https://www.letrot.com/courses/aujourd-hui`, { waitUntil: 'networkidle2' });
  
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

    console.log('✅ Qualif trouvée:', { reunion_id, qualif_id, hippodrome, heure, nb_engages });

    reunions.push({
      reunion_id, hippodrome, date, heure, nb_engages,
      courses: [{ qualif_id, url: `/courses/qualifications/${courseDate}/${reunion_id}/${qualif_id}`, type: 'qualification' }],
      type: 'qualification'
    });
  });

  console.log('\nRésultat final:', JSON.stringify(reunions, null, 2));
})();