const express = require('express');
const { getDayProgram, getCoursePartants, getHorseDetails, resolveDate, getDayQualification, getCourseEngages, withRetry, poolAll } = require('./scraper');
const { getCacheWithTTL, setCache, secondsUntilMidnight } = require('./cache');

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
  }

  try {
    console.log(`[SCRAPE] partants ${date}`);
    const reunions = await getDayProgram(dateOrSlug);

    console.log(`${reunions.length} reunions trouvees`);

    // ── Step 1: fetch all courses in parallel (capped) ──────────────────────
    const courseTasks = [];
    for (const reunion of reunions) {
      for (const course of reunion.courses.filter(c => c.type === 'course')) {
        courseTasks.push({ reunion, course });
      }
    }

    const courseResults = await poolAll(
      courseTasks.map(({ reunion, course }) => () =>
        withRetry(() => getCoursePartants(date, reunion.reunion_id, course.num))
          .then(data => ({ reunion, course, data }))
      ),
      COURSE_CONCURRENCY
    );

    // ── Step 2: collect all (partant, meta) pairs ────────────────────────────
    const partantJobs = [];
    for (const r of courseResults) {
      if (r.status === 'rejected') {
        console.warn(`  ✗ Course scrape: ${r.reason?.message}`);
        continue;
      }
      const { reunion, course, data: courseData } = r.value;

      let hippodrome = courseData.hippodrome || reunion.hippodrome;
      const raceCode  = courseData.reunion_code;
      const hippoName = hippodrome.split('\n')[1]?.trim() || hippodrome.trim();

      for (const partant of courseData.partants) {
        partantJobs.push({ partant, courseData, raceCode, hippoName, courseNum: course.num });
      }
    }

    // ── Step 3: fetch all horse details in parallel (capped) ─────────────────
    const horseResults = await poolAll(
      partantJobs.map(job => () =>
        fetchHorse(job.partant.slug, job.partant.horse_id)
          .then(details => ({ ...job, details }))
          .catch(err => {
            console.warn(`  ✗ Cheval ${job.partant.nom}: ${err.message}`);
            return { ...job, details: {} };
          })
      ),
      HORSE_CONCURRENCY
    );

    // ── Step 4: assemble result ───────────────────────────────────────────────
    const result = [];
    for (const r of horseResults) {
      if (r.status === 'rejected') continue;
      const { partant, courseData, raceCode, hippoName, courseNum, details } = r.value;

      result.push({
        nom:            partant.nom,
        naissance:      details.naissance      || '',
        sexe:           details.sexe           || '',
        pere:           details.pere           || '',
        mere:           details.mere           || '',
        discipline:     courseData.discipline,
        date,
        course:         `${raceCode}C${courseNum}`,
        prix:           courseData.prix,
        hippodrome:     hippoName,
        distance:       courseData.distance,
        record:         details.record         || '',
        gains:          details.gains          || '',
        reduction:      details.reduction      || '',
        reduction_date: details.reduction_date || '',
        reduction_lieu: details.reduction_lieu || '',
        urlPerfs:       `https://www.letrot.com${partant.cheval_url}`,
      });
    }

    setCache(cacheKey, result, TTL);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
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
  }

  try {
    console.log(`[SCRAPE] partantsRP ${date} + demain`);

    const tomorrow = new Date(date);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dates = [
      { d: date,                                slug: dateOrSlug },
      { d: tomorrow.toISOString().split('T')[0], slug: 'demain'  },
    ];

    // ── Step 1: fetch programmes for both days ────────────────────────────────
    const programmes = await poolAll(
      dates.map(({ d, slug }) => async () => {
        const reunions = await withRetry(() => getDayProgram(slug));
        return { d, slug, reunions };
      }),
      2
    );

    // ── Step 2: build course task list (trot only after discipline known) ─────
    const courseTasks = [];
    for (const pr of programmes) {
      if (pr.status === 'rejected') { console.warn(`  ✗ Programme: ${pr.reason?.message}`); continue; }
      const { d, reunions } = pr.value;
      for (const reunion of reunions) {
        for (const course of reunion.courses.filter(c => c.type === 'course')) {
          courseTasks.push({ d, reunion, course });
        }
      }
    }

    const courseResults = await poolAll(
      courseTasks.map(({ d, reunion, course }) => () =>
        withRetry(() => getCoursePartants(d, reunion.reunion_id, course.num))
          .then(data => ({ d, reunion, data }))
      ),
      COURSE_CONCURRENCY
    );

    // ── Step 3: collect trot partants ─────────────────────────────────────────
    const partantJobs = [];
    for (const r of courseResults) {
      if (r.status === 'rejected') { console.warn(`  ✗ Course: ${r.reason?.message}`); continue; }
      const { d, reunion, data: courseData } = r.value;

      if (!['Attelé', 'Monté'].includes(courseData.discipline)) continue;

      let hippodrome = reunion.hippodrome || courseData.hippodrome;
      hippodrome = hippodrome.replace(/\n\t\t/g, '');

      for (const partant of courseData.partants) {
        partantJobs.push({ partant, courseData, hippodrome, d });
      }
    }

    // ── Step 4: fetch horse details in parallel ───────────────────────────────
    const horseResults = await poolAll(
      partantJobs.map(job => () =>
        fetchHorse(job.partant.slug, job.partant.horse_id)
          .then(details => ({ ...job, details }))
          .catch(err => {
            console.warn(`  ✗ Cheval ${job.partant.nom}: ${err.message}`);
            return { ...job, details: {} };
          })
      ),
      HORSE_CONCURRENCY
    );

    // ── Step 5: assemble result ───────────────────────────────────────────────
    const result = [];
    for (const r of horseResults) {
      if (r.status === 'rejected') continue;
      const { partant, courseData, hippodrome, d, details } = r.value;

      result.push({
        nom:        partant.nom,
        naissance:  details.naissance || '',
        mere:       details.mere      || '',
        date:       d,
        prix:       courseData.prix,
        hippodrome,
        discipline: courseData.discipline,
        urlPerfs:   `https://www.letrot.com${partant.cheval_url}`,
      });
    }

    setCache(cacheKey, result, TTL);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
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
  }

  try {
    console.log(`[SCRAPE] engages ${date}`);
    const reunions = await getDayQualification(dateOrSlug);

    // ── Step 1: fetch all qualification courses in parallel ───────────────────
    const qualifTasks = [];
    for (const reunion of reunions) {
      for (const course of reunion.courses.filter(c => c.type === 'qualification')) {
        qualifTasks.push({ reunion, course });
      }
    }

    const qualifResults = await poolAll(
      qualifTasks.map(({ reunion, course }) => () =>
        withRetry(() => getCourseEngages(date, reunion.reunion_id, course.qualif_id))
          .then(data => ({ reunion, course, data }))
      ),
      COURSE_CONCURRENCY
    );

    // ── Step 2: collect engagé jobs ───────────────────────────────────────────
    const engageJobs = [];
    for (const r of qualifResults) {
      if (r.status === 'rejected') { console.warn(`  ✗ Qualif: ${r.reason?.message}`); continue; }
      const { reunion, course, data: courseData } = r.value;

      if (!courseData.prix.toUpperCase().includes('QUALIF')) continue;

      for (const partant of courseData.engages) {
        engageJobs.push({ partant, courseData, reunion, course });
      }
    }

    // ── Step 3: fetch horse details in parallel ───────────────────────────────
    const horseResults = await poolAll(
      engageJobs.map(job => () =>
        fetchHorse(job.partant.slug, job.partant.horse_id)
          .then(details => ({ ...job, details }))
          .catch(err => {
            console.warn(`  ✗ Cheval ${job.partant.nom}: ${err.message}`);
            return { ...job, details: {} };
          })
      ),
      HORSE_CONCURRENCY
    );

    // ── Step 4: assemble result ───────────────────────────────────────────────
    const result = {};
    for (const r of horseResults) {
      if (r.status === 'rejected') continue;
      const { partant, courseData, reunion, course, details } = r.value;

      if (!result[date]) result[date] = [];
      result[date].push({
        nom:            partant.nom,
        naissance:      details.naissance      || '',
        date,
        hippodrome:     reunion.hippodrome     || courseData.hippodrome,
        lot:            partant.lot            || '',
        reduction:      details.reduction      || '',
        reduction_date: details.reduction_date || '',
        discipline:     partant.discipline     || '',
        urlPerfs:       `https://www.letrot.com${partant.cheval_url}`,
      });
    }

    setCache(cacheKey, result, 3600);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
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
  console.log(`  GET /health\n`);
  console.log(`  Horse concurrency : ${HORSE_CONCURRENCY}`);
  console.log(`  Course concurrency: ${COURSE_CONCURRENCY}\n`);
});

module.exports = app;
