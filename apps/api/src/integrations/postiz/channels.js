/**
 * Channel catalog - the single source for which social platforms yv. shows,
 * their labels, and how a Postiz integration's providerIdentifier maps onto
 * them. (Label table carried over from the postiz-absorption branch.)
 */

const PLATFORMS = {
  instagram: { label: 'Instagram', profileBase: 'https://www.instagram.com/' },
  youtube: { label: 'YouTube', profileBase: 'https://www.youtube.com/@' },
  linkedin: { label: 'LinkedIn', profileBase: 'https://www.linkedin.com/company/' },
  x: { label: 'X', profileBase: 'https://x.com/' },
};

// Postiz providerIdentifier -> yv. platform key
const POSTIZ_IDENTIFIERS = {
  instagram: 'instagram',
  'instagram-standalone': 'instagram',
  youtube: 'youtube',
  linkedin: 'linkedin',
  'linkedin-page': 'linkedin',
  x: 'x',
};

const PLATFORM_KEYS = Object.keys(PLATFORMS);

function platformLabel(key) {
  return (PLATFORMS[key] && PLATFORMS[key].label) || (key ? key.charAt(0).toUpperCase() + key.slice(1) : 'Unknown');
}

function platformFromPostizIdentifier(identifier) {
  return POSTIZ_IDENTIFIERS[identifier] || null;
}

function profileUrl(platform, handle) {
  const p = PLATFORMS[platform];
  if (!p || !handle) return '';
  return `${p.profileBase}${String(handle).replace(/^@/, '')}`;
}

module.exports = { PLATFORMS, PLATFORM_KEYS, POSTIZ_IDENTIFIERS, platformLabel, platformFromPostizIdentifier, profileUrl };
