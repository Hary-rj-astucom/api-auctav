const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');

// In-memory cache (TTL en secondes)
const memCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

// Cache directory for file persistence
const CACHE_DIR = path.join(__dirname, '../cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

/**
 * Get from memory cache first, then file cache
 */
function getCache(key) {
  const mem = memCache.get(key);
  if (mem !== undefined) return mem;

  const filePath = path.join(CACHE_DIR, `${key}.json`);
  if (!fs.existsSync(filePath)) return null;

  const stat = fs.statSync(filePath);
  const ageSeconds = (Date.now() - stat.mtimeMs) / 1000;
  return ageSeconds; // caller checks the age
}

/**
 * Full cache get with TTL check
 * ttlSeconds: how old the file cache can be
 */
function getCacheWithTTL(key, ttlSeconds = 3600) {
  // Memory first
  const mem = memCache.get(key);
  if (mem !== undefined) return mem;

  // File cache
  const filePath = path.join(CACHE_DIR, `${key}.json`);
  if (!fs.existsSync(filePath)) return null;

  const stat = fs.statSync(filePath);
  const ageSeconds = (Date.now() - stat.mtimeMs) / 1000;
  if (ageSeconds > ttlSeconds) return null;

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    memCache.set(key, data, ttlSeconds - ageSeconds);
    return data;
  } catch {
    return null;
  }
}

/**
 * Save to memory + file cache
 */
function setCache(key, data, ttlSeconds = 3600) {
  memCache.set(key, data, ttlSeconds);
  const filePath = path.join(CACHE_DIR, `${key}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
}

/**
 * Returns seconds until midnight (so cache expires at start of new day)
 */
function secondsUntilMidnight() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return Math.floor((midnight - now) / 1000);
}

module.exports = { getCacheWithTTL, setCache, secondsUntilMidnight };
