const { getDayProgram, getCoursePartants, getHorseDetails, resolveDate, getDayQualification, getCourseEngages, withRetry, poolAll, getHorsePerf, getHorsePerfLeTrot } = require('../services/scraper');
const { getCacheWithTTL, setCache, secondsUntilMidnight } = require('../services/cache');
const { getInfoHorseIFCE } = require('../services/ifce');

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
// ─────────────────────────────────────────────────────────────────────────────
const getPartant = async (req, res) => {
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
};

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 2 – partantsRP equivalent
// ─────────────────────────────────────────────────────────────────────────────
const getPartantRP = async (req, res) => {
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
};

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 3 – engages (qualifications)
// ─────────────────────────────────────────────────────────────────────────────
const getEngages = async (req, res) => {
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
};

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 4 – Fiche cheval individuelle
// ─────────────────────────────────────────────────────────────────────────────
const getHorse = async (req, res) => {
  const { slug, horse_id } = req.params;
  try {
    const data = await fetchHorse(slug, horse_id);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 5 – Programme du jour (réunions + courses)
// ─────────────────────────────────────────────────────────────────────────────
const getProgamme = async (req, res) => {
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
};

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 6 – Programme du jour (réunions + courses)
// ─────────────────────────────────────────────────────────────────────────────
const horseperf = async (req, res) => {
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
};

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 7 – Recuperation information cheval de l'IFCE
// ─────────────────────────────────────────────────────────────────────────────
const getinfohorseIFCE = async (req, res) => {
  try {
    console.log(req.query.q);
    const data = await getInfoHorseIFCE(req.query.q);
    res.json(data);
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  getPartant,
  getPartantRP,
  getEngages,
  getHorse,
  getProgamme,
  horseperf,
  getinfohorseIFCE
};