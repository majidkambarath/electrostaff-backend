// Site geofence rules. Pure functions, no I/O.
const { invalid } = require('./errors');

const EARTH_M = 6371000;
const RADIUS = { min: 50, max: 2000, default: 200 };
// A phone's GPS accuracy is added to the radius, capped so a very rough fix can't pass from far away.
const MAX_ACCURACY_ALLOWANCE = 100;

const toRad = (d) => (d * Math.PI) / 180;

// Great-circle distance in metres between two { lat, lng } points.
const distanceMeters = (a, b) => {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_M * Math.asin(Math.sqrt(h)));
};

const validPoint = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

// Office input -> stored geofence, or null to clear it.
const parseGeofence = (input) => {
  if (input === null || input === '' || input === false) return null;
  const lat = Number(input?.lat);
  const lng = Number(input?.lng);
  if (!validPoint(lat, lng)) throw invalid('Set a valid site location (latitude and longitude)');
  const radius = input.radius === undefined || input.radius === '' ? RADIUS.default : Math.round(Number(input.radius));
  if (!Number.isFinite(radius) || radius < RADIUS.min || radius > RADIUS.max) {
    throw invalid(`Check-in radius must be ${RADIUS.min}–${RADIUS.max} metres`);
  }
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, radius };
};

// Is a check-in at `location` ({ lat, lng, accuracy }) inside the site's fence?
const checkFence = (fence, location) => {
  const distance = distanceMeters(fence, location);
  const allowance = Math.min(Math.max(location.accuracy || 0, 0), MAX_ACCURACY_ALLOWANCE);
  return { inside: distance <= fence.radius + allowance, distance };
};

const formatDistance = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);

module.exports = { RADIUS, distanceMeters, parseGeofence, checkFence, formatDistance };
