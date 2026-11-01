/**
 * Per-platform publishing settings.
 *
 * The composer sends a small, yv.-shaped settings object per platform; this
 * module validates it *before* anything is scheduled (in both demo and Postiz
 * mode) and maps it onto the Postiz `settings` object whose `__type` names the
 * provider (https://docs.postiz.com/public-api/providers/*).
 *
 *   instagram  { format: post|reel|story, collaborators: [username] }
 *              -> { __type: instagram|instagram-standalone, post_type, collaborators: [{label}] }
 *   youtube    { title, visibility: public|unlisted|private, madeForKids: bool, tags: [str], thumbnailFileId }
 *              -> { __type: youtube, title, type, selfDeclaredMadeForKids: yes|no, tags: [{value,label}], thumbnail }
 *   x          { whoCanReply: everyone|following|mentionedUsers|subscribers|verified }
 *              -> { __type: x, who_can_reply_post }
 *   linkedin   { carousel: bool, carouselName }
 *              -> { __type: linkedin|linkedin-page, post_as_images_carousel, carousel_name }
 */

const IG_FORMATS = ['post', 'reel', 'story'];
const YT_VISIBILITY = ['public', 'unlisted', 'private'];
const X_REPLY = ['everyone', 'following', 'mentionedUsers', 'subscribers', 'verified'];
const X_MAX_CHARS = 280;
const IG_MAX_CAPTION = 2200;
const IG_MAX_COLLABORATORS = 3;
const YT_MAX_TAGS = 15;

function validationError(message, details) {
  const err = { status: 400, code: 'validation_error', message };
  if (details) err.details = details;
  return err;
}

const isVideo = (f) => Boolean(f && /^video\//.test(f.mimeType || ''));
const isImage = (f) => Boolean(f && /^image\//.test(f.mimeType || ''));

/** Fill defaults so a channel with no explicit settings still schedules. */
function withDefaults(platform, input, ctx = {}) {
  const s = { ...(input || {}) };
  if (platform === 'instagram') {
    if (!s.format) s.format = isVideo(ctx.file) ? 'reel' : 'post';
    s.collaborators = Array.isArray(s.collaborators) ? s.collaborators : [];
  } else if (platform === 'youtube') {
    if (s.title === undefined || s.title === null) s.title = String(ctx.projectTitle || '').slice(0, 100);
    if (!s.visibility) s.visibility = 'public';
    // API callers that send no YouTube settings at all get "not made for kids";
    // the composer always sends an explicit choice.
    if (input === undefined || input === null) s.madeForKids = false;
    s.tags = Array.isArray(s.tags) ? s.tags : [];
  } else if (platform === 'x') {
    if (!s.whoCanReply) s.whoCanReply = 'everyone';
  } else if (platform === 'linkedin') {
    s.carousel = Boolean(s.carousel);
  }
  return s;
}

/**
 * Validate one platform's settings. Returns [{ platform, field, message }]
 * (empty when valid). ctx: { caption, file, files (all approved files) }.
 */
function check(platform, s, ctx = {}) {
  const errs = [];
  const add = (field, message) => errs.push({ platform, field, message });
  const caption = String(ctx.caption || '');
  const files = ctx.files || [];
  if (platform === 'instagram') {
    if (!IG_FORMATS.includes(s.format)) add('format', 'Instagram format must be post, reel or story');
    if (!ctx.file) add('media', 'Instagram needs an image or video');
    if (s.format === 'reel' && ctx.file && !isVideo(ctx.file)) add('format', 'A Reel needs a video file');
    if (caption.length > IG_MAX_CAPTION) add('caption', `Instagram captions are limited to ${IG_MAX_CAPTION} characters`);
    if (s.collaborators.length > IG_MAX_COLLABORATORS) add('collaborators', `Instagram allows up to ${IG_MAX_COLLABORATORS} collaborators`);
    for (const c of s.collaborators) {
      if (!/^@?[A-Za-z0-9._]{1,30}$/.test(String(c))) add('collaborators', `"${c}" is not a valid Instagram username`);
    }
    if (s.format === 'story' && s.collaborators.length) add('collaborators', 'Stories cannot have collaborators');
  } else if (platform === 'youtube') {
    const title = String(s.title || '').trim();
    if (title.length < 2 || title.length > 100) add('title', 'YouTube title must be 2-100 characters');
    if (!YT_VISIBILITY.includes(s.visibility)) add('visibility', 'YouTube visibility must be public, unlisted or private');
    if (typeof s.madeForKids !== 'boolean') add('madeForKids', 'Say whether the video is made for kids (required by YouTube)');
    if (!ctx.file || !isVideo(ctx.file)) add('media', 'YouTube needs a video file');
    if (s.tags.length > YT_MAX_TAGS) add('tags', `Use at most ${YT_MAX_TAGS} tags`);
    if (s.tags.join(',').length > 500) add('tags', 'YouTube tags are limited to 500 characters in total');
    if (s.thumbnailFileId) {
      const thumb = files.find((f) => String(f._id) === String(s.thumbnailFileId));
      if (!thumb) add('thumbnail', 'The thumbnail must be an image from the approved version');
      else if (!isImage(thumb)) add('thumbnail', 'The thumbnail must be an image');
    }
  } else if (platform === 'x') {
    if (!X_REPLY.includes(s.whoCanReply)) add('whoCanReply', `Who can reply must be one of: ${X_REPLY.join(', ')}`);
    if (caption.length > X_MAX_CHARS) add('caption', `X posts are limited to ${X_MAX_CHARS} characters (${caption.length} now)`);
  } else if (platform === 'linkedin') {
    if (s.carousel) {
      const images = files.filter(isImage);
      if (images.length < 2) add('carousel', 'A LinkedIn carousel needs at least 2 images in the approved version');
    }
    if (s.carouselName && String(s.carouselName).length > 100) add('carouselName', 'Carousel name is limited to 100 characters');
  }
  return errs;
}

/** Validate settings for a set of platforms; throws a 400 with field details. */
function validateAll(platforms, settingsByPlatform = {}, ctx = {}) {
  const out = {};
  const errors = [];
  for (const platform of [...new Set(platforms)]) {
    const s = withDefaults(platform, settingsByPlatform[platform], ctx);
    errors.push(...check(platform, s, ctx));
    out[platform] = s;
  }
  if (errors.length) {
    throw validationError(errors.map((e) => e.message).join('; '), errors);
  }
  return out;
}

/**
 * Map validated yv. settings to the Postiz settings object.
 * ctx: { postizIdentifier, thumbnail: { id, path } | null }
 */
function toPostizSettings(platform, s = {}, ctx = {}) {
  const ident = ctx.postizIdentifier || platform;
  if (platform === 'instagram') {
    const out = { __type: ident, post_type: s.format === 'story' ? 'story' : 'post' };
    if (s.format === 'reel') out.is_trial_reel = false;
    if (s.collaborators && s.collaborators.length) out.collaborators = s.collaborators.map((c) => ({ label: String(c).replace(/^@/, '') }));
    return out;
  }
  if (platform === 'youtube') {
    const out = {
      __type: 'youtube',
      title: String(s.title || '').trim(),
      type: s.visibility || 'public',
      selfDeclaredMadeForKids: s.madeForKids ? 'yes' : 'no',
      tags: (s.tags || []).map((t) => ({ value: String(t), label: String(t) })),
    };
    if (ctx.thumbnail) out.thumbnail = ctx.thumbnail;
    return out;
  }
  if (platform === 'x') return { __type: 'x', who_can_reply_post: s.whoCanReply || 'everyone' };
  if (platform === 'linkedin') {
    const out = { __type: ident, post_as_images_carousel: Boolean(s.carousel) };
    if (s.carousel && s.carouselName) out.carousel_name = String(s.carouselName);
    return out;
  }
  return { __type: ident };
}

/* ---- back-compat helpers (used by older call sites/tests) ---- */

function validateInstagram(s) {
  if (!s || !s.post_type) throw validationError('Instagram settings require post_type (post|story)');
  if (!['post', 'story'].includes(s.post_type)) throw validationError('Instagram post_type must be post or story');
}

function validateYouTube(s) {
  if (!s || !s.title || !s.type) throw validationError('YouTube settings require title and type (public|private|unlisted)');
  if (s.title.length < 2 || s.title.length > 100) throw validationError('YouTube title must be 2-100 chars');
  if (!['public', 'private', 'unlisted'].includes(s.type)) throw validationError('YouTube type must be public|private|unlisted');
}

function validate(platform, settings) {
  if (!settings || !settings.__type) throw validationError(`Missing __type for ${platform}`);
  if (platform === 'instagram') validateInstagram(settings);
  if (platform === 'youtube') validateYouTube(settings);
  if (platform === 'x' && !X_REPLY.includes(settings.who_can_reply_post)) throw validationError('X settings require who_can_reply_post');
}

/** Default Postiz settings for a channel (no composer input). */
function buildSettings(platform, ctx = {}) {
  let input = ctx.settings;
  if (!input && platform === 'youtube') {
    const title = String(ctx.title || 'New video').slice(0, 100).padEnd(2, '.');
    input = { title, visibility: 'public', madeForKids: false };
  }
  const s = withDefaults(platform, input || {}, { projectTitle: ctx.title, file: ctx.file });
  if (platform === 'youtube' && typeof s.madeForKids !== 'boolean') s.madeForKids = false;
  const settings = toPostizSettings(platform, s, ctx);
  validate(platform, settings);
  return settings;
}

module.exports = {
  IG_FORMATS,
  YT_VISIBILITY,
  X_REPLY,
  X_MAX_CHARS,
  withDefaults,
  check,
  validateAll,
  toPostizSettings,
  buildSettings,
  validate,
  validateInstagram,
  validateYouTube,
};
