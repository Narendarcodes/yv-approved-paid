/**
 * Small timezone helpers (no dependency): read the weekday/hour of an instant
 * in an IANA zone, and find the next instant at a given local weekday/hour.
 * Used by "Suggest best time" and the best-posting-time heatmap.
 */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtCache = new Map();

function formatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(
      tz,
      new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' })
    );
  }
  return fmtCache.get(tz);
}

/** -> { weekday: 0..6 (Sun=0), hour: 0..23, date: 'YYYY-MM-DD' } in tz */
function localParts(date, tz = 'UTC') {
  const parts = formatter(tz).formatToParts(new Date(date));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  const hour = Number(get('hour')) % 24;
  return { weekday: WEEKDAYS.indexOf(get('weekday')), hour, minute: Number(get('minute')), date: `${get('year')}-${get('month')}-${get('day')}` };
}

/**
 * Next instant strictly after `after` that is exactly HH:00 local time in tz
 * (works for half/quarter-hour zones like Asia/Kolkata) on the given weekday
 * (null = any day). Scans 15-minute steps over at most 8 days.
 */
function nextLocalSlot({ weekday = null, hour }, after = new Date(), tz = 'UTC') {
  const STEP = 15 * 60000;
  const t = new Date(Math.floor(new Date(after).getTime() / STEP) * STEP + STEP);
  for (let i = 0; i < 4 * 24 * 8 + 4; i += 1) {
    const p = localParts(t, tz);
    if (p.minute === 0 && p.hour === hour && (weekday === null || p.weekday === weekday)) return new Date(t);
    t.setTime(t.getTime() + STEP);
  }
  return null;
}

module.exports = { WEEKDAYS, localParts, nextLocalSlot };
