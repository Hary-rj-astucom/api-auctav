const express = require('express');
require('dotenv').config();

const horseRoutes = require('./routes/horseroute');
const otpRoutes = require('./routes/otproute');

const app = express();
const PORT = process.env.PORT || 3003;

// Concurrency caps (tune to taste)
const HORSE_CONCURRENCY   = 6;  // parallel getHorseDetails
const COURSE_CONCURRENCY  = 4;  // parallel getCoursePartants / getCourseEngages

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "https://www.auctav.com");
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.use('', horseRoutes);
app.use('/otp', otpRoutes);

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`\n🎠 LeTrot API running on http://localhost:${PORT}\n`);
});

module.exports = app;
