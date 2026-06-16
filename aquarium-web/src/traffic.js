'use strict';

// TomTom Traffic Flow — converts a US zip code to a congestion ratio (0=free, 1=gridlock).
// Geocodes the zip once, then polls the Flow Segment endpoint every CACHE_MS.

const https = require('https');

const CACHE_MS = 60_000;
const TOMTOM_KEY = process.env.TOMTOM_API_KEY || '';

// zip -> { lat, lng, fetchedAt }
const geoCache = new Map();
// zip -> { congestion, speed, freeFlow, updatedAt }
const flowCache = new Map();

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function geocodeZip(zip) {
  const cached = geoCache.get(zip);
  if (cached) return cached;

  const url =
    `https://api.tomtom.com/search/2/geocode/${encodeURIComponent(zip)}.json` +
    `?key=${TOMTOM_KEY}&countrySet=US&limit=1`;
  const data = await get(url);
  const pos = data?.results?.[0]?.position;
  if (!pos) throw new Error(`TomTom geocode: no result for zip ${zip}`);
  const entry = { lat: pos.lat, lng: pos.lon };
  geoCache.set(zip, entry);
  return entry;
}

async function fetchFlow(zip) {
  const cached = flowCache.get(zip);
  if (cached && Date.now() - cached.updatedAt < CACHE_MS) return cached;

  const { lat, lng } = await geocodeZip(zip);
  const url =
    `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json` +
    `?key=${TOMTOM_KEY}&point=${lat},${lng}&unit=MPH`;
  const data = await get(url);
  const seg = data?.flowSegmentData;
  if (!seg) throw new Error(`TomTom flow: no segment data for zip ${zip}`);

  const speed = seg.currentSpeed ?? 0;
  const freeFlow = seg.freeFlowSpeed || 1;
  // congestion: 0 = free flow, 1 = complete gridlock
  const congestion = Math.max(0, Math.min(1, 1 - speed / freeFlow));

  const entry = { congestion, speed, freeFlow, updatedAt: Date.now() };
  flowCache.set(zip, entry);
  return entry;
}

module.exports = { fetchFlow, hasKey: () => Boolean(TOMTOM_KEY) };
