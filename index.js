const express = require('express');
const { getDayProgram, getCoursePartants, getHorseDetails, resolveDate, getDayQualification, getCourseEngages } = require('./scraper');
const { getCacheWithTTL, setCache, secondsUntilMidnight } = require('./cache');

const app = express();
const PORT = process.env.PORT || 3003;

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 1 — getDataEquidia equivalent
// GET /api/partants?date=YYYY-MM-DD  (ou "aujourd-hui", "demain")
//
// Retourne la liste de tous les partants du jour, format identique à
// getDataEquidia.php:
// [{ nom, naissance, discipline, date, course, prix, hippodrome, mere, pere, reduction, reduction_date, reduction_lieu }]
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/partants', async (req, res) => {
  const dateOrSlug = req.query.date || 'aujourd-hui';
  const date = resolveDate(dateOrSlug);
  const cacheKey = `partants_${date}`;
  const TTL = secondsUntilMidnight();

  // Serve from cache if fresh
  const cached = getCacheWithTTL(cacheKey, TTL);
  if (cached) {
    console.log(`[CACHE] partants ${date}`);
    return res.json(cached);
  }

  try {
    console.log(`[SCRAPE] partants ${date}`);
    const reunions = await getDayProgram(dateOrSlug);
    const result = [];

    for (const reunion of reunions) {
      for (const course of reunion.courses.filter(c => c.type === 'course')) {
        // Get partants of this course
        let courseData;
        try {
          courseData = await getCoursePartants(date, reunion.reunion_id, course.num);
        } catch (e) {
          console.warn(`  ✗ Course ${reunion.reunion_id}/${course.num}: ${e.message}`);
          continue;
        }

        // Enrich each horse with its details (père, mère, naissance, réduction)
        for (const partant of courseData.partants) {
          let horseDetails = {};
          try {
            const horseCache = getCacheWithTTL(`horse_${partant.horse_id}`, 86400);
            if (horseCache) {
              horseDetails = horseCache;
            } else {
              horseDetails = await getHorseDetails(partant.slug, partant.horse_id);
              setCache(`horse_${partant.horse_id}`, horseDetails, 86400);
            }
          } catch (e) {
            console.warn(`  ✗ Cheval ${partant.nom}: ${e.message}`);
          }

          let hippodrome = reunion.hippodrome || courseData.hippodrome;
          const raceCode = hippodrome.split('\n')[0].trim();
          hippodrome = hippodrome.split('\n')[1].trim();

          result.push({
            nom:              partant.nom,
            naissance:        horseDetails.naissance || '',
            sexe:             horseDetails.sexe || '',
            pere:             horseDetails.pere || '',
            mere:             horseDetails.mere || '',
            discipline:       courseData.discipline,
            date:             date,
            course:           `${raceCode}C${course.num}`,
            prix:             courseData.prix,
            hippodrome:       hippodrome,
            distance:         courseData.distance,
            record:           horseDetails.record || '',
            gains:            horseDetails.gains || '',
            reduction:        horseDetails.reduction || '',
            reduction_date:   horseDetails.reduction_date || '',
            reduction_lieu:   horseDetails.reduction_lieu || '',
            urlPerfs:         `https://www.letrot.com${partant.cheval_url}`,
          });
        }
      }
    }

    setCache(cacheKey, result, TTL);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 2 — partantsRP equivalent
// GET /api/partantsRP?date=YYYY-MM-DD
//
// Format identique à partantsRP.json (iazone.fr):
// [{ nom, naissance, mere, date, prix, hippodrome }]
// Contient aujourd'hui + demain (comme le PHP original)
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

    // Merge today + tomorrow (comme le PHP original)
    const dates = [date];
    const tomorrow = new Date(date);
    tomorrow.setDate(tomorrow.getDate() + 1);
    dates.push(tomorrow.toISOString().split('T')[0]);

    const result = [];

    for (const d of dates) {
      const slug = d === date ? dateOrSlug : 'demain';
      let reunions;
      try {
        reunions = await getDayProgram(slug);
      } catch (e) {
        console.warn(`  ✗ Programme ${d}: ${e.message}`);
        continue;
      }

      for (const reunion of reunions) {
        // Only trot (Attelé / Monté) — RP = Régions Provinces
        for (const course of reunion.courses.filter(c => c.type === 'course')) {
          let courseData;
          try {
            courseData = await getCoursePartants(d, reunion.reunion_id, course.num);
          } catch (e) {
            continue;
          }

          // Skip non-trot
          if (!['Attelé', 'Monté'].includes(courseData.discipline)) continue;

          for (const partant of courseData.partants) {
            let horseDetails = {};
            try {
              const horseCache = getCacheWithTTL(`horse_${partant.horse_id}`, 86400);
              if (horseCache) {
                horseDetails = horseCache;
              } else {
                horseDetails = await getHorseDetails(partant.slug, partant.horse_id);
                setCache(`horse_${partant.horse_id}`, horseDetails, 86400);
              }
            } catch (e) {
              console.warn(`  ✗ Cheval ${partant.nom}: ${e.message}`);
            }

            let hippodrome = reunion.hippodrome || courseData.hippodrome;
            hippodrome = hippodrome.replace(/\n\t\t/g, '');

            result.push({
              nom:        partant.nom,
              naissance:  horseDetails.naissance || '',
              mere:       horseDetails.mere || '',
              date:       d,
              prix:       courseData.prix,
              hippodrome: hippodrome,
              discipline: courseData.discipline,
              urlPerfs:   `https://www.letrot.com${partant.cheval_url}`,
            });
          }
        }
      }
    }

    setCache(cacheKey, result, TTL);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 3 — engages (qualifications)
// GET /api/engages?date=YYYY-MM-DD
//
// Format identique à getEngages.php:
// { "YYYY-MM-DD": [{ nom, naissance, date, hippodrome, lot, reduction, urlPerfs, discipline }] }
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/engages', async (req, res) => {
  const dateOrSlug = req.query.date || 'aujourd-hui';
  const date = resolveDate(dateOrSlug);
  const cacheKey = `engages_${date}`;

  // Cache 1h (comme le PHP original)
  const cached = getCacheWithTTL(cacheKey, 3600);
  if (cached) {
    console.log(`[CACHE] engages ${date}`);
    return res.json(cached);
  }

  try {
    console.log(`[SCRAPE] engages ${date}`);
    const reunions = await getDayQualification(dateOrSlug);
    const result = {};

    for (const reunion of reunions) {
      for (const course of reunion.courses.filter(c => c.type === 'qualification')) {
        let courseData;
        try {
          courseData = await getCourseEngages(date, reunion.reunion_id, course.qualif_id);
        } catch (e) {
          console.log(e)
          continue;
        }

        // Qualifications only: filter by prix name containing "QUALIFICATION"
        if (!courseData.prix.toUpperCase().includes('QUALIF')) continue;

        if (!result[date]) result[date] = [];

        for (const partant of courseData.engages) {
          let horseDetails = {};
          try {
            const horseCache = getCacheWithTTL(`horse_${partant.horse_id}`, 86400);
            if (horseCache) {
              horseDetails = horseCache;
            } else {
              horseDetails = await getHorseDetails(partant.slug, partant.horse_id);
              setCache(`horse_${partant.horse_id}`, horseDetails, 86400);
            }
          } catch (e) {
            console.warn(`  ✗ Cheval ${partant.nom}: ${e.message}`);
          }

          result[date].push({
            nom:              partant.nom,
            naissance:        horseDetails.naissance || '',
            date:             date,
            hippodrome:       reunion.hippodrome || courseData.hippodrome,
            lot:              course.num,
            reduction:        horseDetails.reduction || '',
            reduction_date:   horseDetails.reduction_date || '',
            discipline:       courseData.discipline,
            urlPerfs:         `https://www.letrot.com${partant.cheval_url}`,
          });
        }
      }
    }

    setCache(cacheKey, result, 3600);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 4 — Fiche cheval individuelle
// GET /api/cheval/:slug/:horse_id
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/cheval/:slug/:horse_id', async (req, res) => {
  const { slug, horse_id } = req.params;
  const cacheKey = `horse_${horse_id}`;

  const cached = getCacheWithTTL(cacheKey, 86400);
  if (cached) return res.json(cached);

  try {
    const data = await getHorseDetails(slug, horse_id);
    setCache(cacheKey, data, 86400);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 5 — Programme du jour (réunions + courses)
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
  console.log(`\n🐎 LeTrot API running on http://localhost:${PORT}\n`);
  console.log('Endpoints disponibles:');
  console.log(`  GET /api/programme?date=aujourd-hui`);
  console.log(`  GET /api/partants?date=aujourd-hui`);
  console.log(`  GET /api/partantsRP?date=aujourd-hui`);
  console.log(`  GET /api/engages?date=aujourd-hui`);
  console.log(`  GET /api/cheval/:slug/:horse_id`);
  console.log(`  GET /health\n`);
});

module.exports = app;
