/**
 * Thin Postiz Public API client (carried over from the postiz-absorption
 * branch, extended with list/analytics). No Postiz code is vendored here;
 * this only speaks the documented public REST API:
 *   https://docs.postiz.com/public-api
 *
 * Base URL:  cloud        https://api.postiz.com/public/v1
 *            self-hosted  https://<domain>/api/public/v1
 * Auth:      Authorization: <apiKey>
 *
 * Every function takes an optional `opts` ({ apiUrl, apiKey, fetch }) so tests
 * can inject a fake fetch without touching global state.
 */
const config = require('../../config');

function resolveOpts(opts = {}) {
  const apiUrl = (opts.apiUrl || config.postiz.apiUrl || '').replace(/\/$/, '');
  const apiKey = opts.apiKey || config.postiz.apiKey || '';
  const fetchImpl = opts.fetch || globalThis.fetch;
  return { apiUrl, apiKey, fetchImpl };
}

function isConfigured(opts = {}) {
  const { apiUrl, apiKey } = resolveOpts(opts);
  return Boolean(apiUrl && apiKey);
}

function assertConfigured({ apiUrl, apiKey }) {
  if (!apiUrl || !apiKey) {
    throw {
      status: 503,
      code: 'postiz_not_configured',
      message: 'Postiz is not configured. Set POSTIZ_API_URL and POSTIZ_API_KEY.',
    };
  }
}

function mapError(status, bodyText, fallbackMessage) {
  let body = null;
  try {
    body = JSON.parse(bodyText);
  } catch (_) {
    body = null;
  }
  const message = (body && (body.message || body.error)) || fallbackMessage || `Postiz error ${status}`;
  if (status === 401) return { status: 502, code: 'postiz_auth_failed', message: 'Postiz rejected the API key' };
  if (status === 403) return { status: 502, code: 'postiz_forbidden', message };
  if (status === 404) return { status: 404, code: 'postiz_not_found', message };
  if (status === 429) return { status: 429, code: 'postiz_rate_limited', message: 'Postiz rate limit exceeded. Try again later.' };
  if (status === 413) return { status: 400, code: 'postiz_payload_too_large', message: 'Postiz payload too large' };
  if (status >= 400 && status < 500) return { status, code: 'postiz_validation_error', message: String(message) };
  return { status: 502, code: 'postiz_upstream_error', message: String(message) };
}

async function request(path, { method = 'GET', body, headers, raw } = {}, opts = {}) {
  const { apiUrl, apiKey, fetchImpl } = resolveOpts(opts);
  assertConfigured({ apiUrl, apiKey });
  const url = `${apiUrl}${path}`;
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: raw ? { Authorization: apiKey, ...(headers || {}) } : { Authorization: apiKey, 'Content-Type': 'application/json', ...(headers || {}) },
      body: raw ? body : body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw { status: 502, code: 'postiz_unreachable', message: `Could not reach Postiz: ${err.message || err}` };
  }
  const text = await res.text();
  if (!res.ok) throw mapError(res.status, text, `Postiz request failed: ${method} ${path}`);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}

/** GET /integrations - connected social channels in the Postiz workspace. */
async function listIntegrations(opts = {}) {
  const data = await request(`/integrations${opts.group ? `?group=${encodeURIComponent(opts.group)}` : ''}`, {}, opts);
  if (Array.isArray(data)) return data;
  return (data && (data.integrations || data.data)) || [];
}

/** POST /upload (multipart) - returns { id, path } usable in a post's image array. */
async function uploadFile({ buffer, filename, mimeType }, opts = {}) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), filename || 'file');
  return request('/upload', { method: 'POST', body: form, raw: true }, opts);
}

/** POST /posts - create/schedule. Returns [{ postId, integration }]. */
async function createPost(payload, opts = {}) {
  if (!payload || !payload.type || !Array.isArray(payload.posts) || !payload.posts.length) {
    throw { status: 400, code: 'validation_error', message: 'Missing required post fields: type, posts' };
  }
  const data = await request('/posts', { method: 'POST', body: payload }, opts);
  if (Array.isArray(data)) return data;
  return (data && (data.posts || data.data)) || [];
}

/** DELETE /posts/:id - 404 means already deleted and is safe to ignore. */
async function deletePost(postId, opts = {}) {
  if (!postId) throw { status: 400, code: 'validation_error', message: 'postId required' };
  try {
    await request(`/posts/${encodeURIComponent(postId)}`, { method: 'DELETE' }, opts);
  } catch (err) {
    if (err && err.status === 404) return;
    throw err;
  }
}

/** GET /posts?startDate&endDate - posts in a window with state + releaseURL. */
async function listPosts({ startDate, endDate }, opts = {}) {
  const qs = `startDate=${encodeURIComponent(new Date(startDate).toISOString())}&endDate=${encodeURIComponent(new Date(endDate).toISOString())}`;
  const data = await request(`/posts?${qs}`, {}, opts);
  if (Array.isArray(data)) return data;
  return (data && data.posts) || [];
}

/** GET /analytics/post/:postId?date=N - [{ label, data:[{ total, date }] }]. */
async function getPostAnalytics(postId, days = 7, opts = {}) {
  const data = await request(`/analytics/post/${encodeURIComponent(postId)}?date=${days}`, {}, opts);
  return Array.isArray(data) ? data : [];
}

/** GET /is-connected - is the API key valid? -> boolean. */
async function isConnected(opts = {}) {
  const data = await request('/is-connected', {}, opts);
  return Boolean(data && data.connected);
}

/**
 * GET /social/:identifier[?refresh=<integrationId>] - OAuth URL to connect a
 * new channel (or re-authorise an expired one when `refresh` is given).
 */
async function getConnectUrl(identifier, { refresh } = {}, opts = {}) {
  if (!identifier) throw { status: 400, code: 'validation_error', message: 'identifier required' };
  const qs = refresh ? `?refresh=${encodeURIComponent(refresh)}` : '';
  const data = await request(`/social/${encodeURIComponent(identifier)}${qs}`, {}, opts);
  const url = data && (data.url || data.redirect);
  if (!url) throw { status: 502, code: 'postiz_upstream_error', message: 'Postiz did not return an OAuth URL' };
  return url;
}

/** GET /find-slot/:integrationId -> Date of the next free slot (or null). */
async function findSlot(integrationId, opts = {}) {
  const data = await request(`/find-slot/${encodeURIComponent(integrationId)}`, {}, opts);
  const d = data && data.date ? new Date(data.date) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

/** POST /upload-from-url { url } - same response shape as /upload. */
async function uploadFromUrl(url, opts = {}) {
  return request('/upload-from-url', { method: 'POST', body: { url } }, opts);
}

/** GET /analytics/:integrationId?date=N - platform (channel) analytics series. */
async function getPlatformAnalytics(integrationId, days = 7, opts = {}) {
  const data = await request(`/analytics/${encodeURIComponent(integrationId)}?date=${days}`, {}, opts);
  return Array.isArray(data) ? data : [];
}

/** PUT /posts/:id/status { status: draft|schedule }. */
async function changePostStatus(postId, status, opts = {}) {
  return request(`/posts/${encodeURIComponent(postId)}/status`, { method: 'PUT', body: { status } }, opts);
}

module.exports = {
  isConfigured,
  isConnected,
  getConnectUrl,
  findSlot,
  uploadFromUrl,
  getPlatformAnalytics,
  changePostStatus,
  listIntegrations,
  uploadFile,
  createPost,
  deletePost,
  listPosts,
  getPostAnalytics,
  _mapError: mapError,
};
