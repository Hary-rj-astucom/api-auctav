const express = require('express');
const { getDayProgram, getCoursePartants, getHorseDetails, resolveDate, getDayQualification, getCourseEngages, withRetry, poolAll, getHorsePerf, getHorsePerfLeTrot } = require('./services/scraper');
const { getCacheWithTTL, setCache, secondsUntilMidnight } = require('./services/cache');
const { getInfoHorseIFCE } = require('./services/ifce');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3003;

// Concurrency caps (tune to taste)
const HORSE_CONCURRENCY   = 6;  // parallel getHorseDetails
const COURSE_CONCURRENCY  = 4;  // parallel getCoursePartants / getCourseEngages

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared helper: fetch horse details with cache + retry
// ─────────────────────────────────────────────────────────────────────────────
async function fetchHorse(slug, horse_id) {
  const cacheKey = `horse_${horse_id}`;
  const cached = getCacheWithTTL(cacheKey, 86400);
  if (cached) return cached;

  const data = await withRetry(() => getHorseDetails(slug, horse_id));
  //setCache(cacheKey, data, 86400);
  console.log(`Horse: ${data.nom} ${data.naissance} ${data.sexe} ${data.discipline_qualif}`);
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 1 – getDataEquidia equivalent
// GET /api/partants?date=YYYY-MM-DD  (ou "aujourd-hui", "demain")
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/partants', async (req, res) => {
  const dateOrSlug = req.query.date || 'aujourd-hui';
  const date = resolveDate(dateOrSlug);
  const cacheKey = `partants_${date}`;
  const TTL = secondsUntilMidnight();

  const cached = getCacheWithTTL(cacheKey, TTL);
  if (cached) {
    console.log(`[CACHE] partants ${date}`);
    return res.json(cached);
  }else{
    console.log(`[SCRAPE] partants ${date} cache not exist yet`);
    return res.json({});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 2 – partantsRP equivalent
// GET /api/partantsRP?date=YYYY-MM-DD
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/partantsRP', async (req, res) => {
  const dateOrSlug = req.query.date || 'aujourd-hui';
  const date = resolveDate(dateOrSlug);
  const cacheKey = `partantsRP_${date}`;
  const TTL = secondsUntilMidnight();

  const cached = getCacheWithTTL(cacheKey, TTL);
  if (cached) {
    console.log(`[CACHE] partantsRP ${date}`);
    return res.json(cached);
  }else{
    console.log(`[SCRAPE] partantsRP ${date} cache not exist yet`);
    return res.json({});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 3 – engages (qualifications)
// GET /api/engages?date=YYYY-MM-DD
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/engages', async (req, res) => {
  const dateOrSlug = req.query.date || 'aujourd-hui';
  const date = resolveDate(dateOrSlug);
  const cacheKey = `engages_${date}`;

  const cached = getCacheWithTTL(cacheKey, 3600);
  if (cached) {
    console.log(`[CACHE] engages ${date}`);
    return res.json(cached);
  }else{
    console.log(`[SCRAPE] engages ${date} cache not exist yet`);
    return res.json({});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 4 – Fiche cheval individuelle
// GET /api/cheval/:slug/:horse_id
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/cheval/:slug/:horse_id', async (req, res) => {
  const { slug, horse_id } = req.params;
  try {
    const data = await fetchHorse(slug, horse_id);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 5 – Programme du jour (réunions + courses)
// GET /api/programme?date=YYYY-MM-DD
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/programme', async (req, res) => {
  const dateOrSlug = req.query.date || 'aujourd-hui';
  const date = resolveDate(dateOrSlug);
  const cacheKey = `programme_${date}`;
  const TTL = secondsUntilMidnight();

  const cached = getCacheWithTTL(cacheKey, TTL);
  if (cached) return res.json(cached);

  try {
    const data = await getDayProgram(dateOrSlug);
    setCache(cacheKey, data, TTL);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 6 – Programme du jour (réunions + courses)
// GET /api/horseperf?url=https://www.equidia.fr/chevaux/harry-angel
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/horseperf', async (req, res) => {
  try {
    console.log(req.query.url);

    if(req.query.url.includes("equidia")){
      const data = await getHorsePerf(req.query.url);
      res.json(data);
    }else if(req.query.url.includes("letrot")){
      const data = await getHorsePerfLeTrot(req.query.url);
      res.json(data);
    }else{
      res.json(null);
    }

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 7 – Recuperation information cheval de l'IFCE
// GET /api/infohorseifce?q=18129029H
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/infohorseifce', async (req, res) => {
  try {
    console.log(req.query.q);
    const data = await getInfoHorseIFCE(req.query.q);
    res.json(data);
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`\n🎠 LeTrot API running on http://localhost:${PORT}\n`);
  console.log('Endpoints disponibles:');
  console.log(`  GET /api/programme?date=aujourd-hui`);
  console.log(`  GET /api/partants?date=aujourd-hui`);
  console.log(`  GET /api/partantsRP?date=aujourd-hui`);
  console.log(`  GET /api/engages?date=aujourd-hui`);
  console.log(`  GET /api/cheval/:slug/:horse_id`);
  console.log(`  GET /api/horseperf?url={url equidia}`);
  console.log(`  GET /api/infohorseifce?q={sire_number}`);
  console.log(`  GET /health\n`);
  console.log(`  Horse concurrency : ${HORSE_CONCURRENCY}`);
  console.log(`  Course concurrency: ${COURSE_CONCURRENCY}\n`);
});

module.exports = app;
