/**
 * Upload service — handles storing profile photos and other user uploads.
 * Uses the same storage adapter as version files.
 */
const storage = require('../storage');
const User = require('../models/user.model');
const config = require('../config');

// Raster images only: an SVG avatar could carry script.
const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

async function uploadProfilePhoto(userId, buffer, filename, mimeType) {
  if (!AVATAR_TYPES.includes(mimeType)) {
    throw { status: 400, code: 'unsupported_image', message: 'Use a PNG, JPEG, WebP or GIF image' };
  }
  const { storageRef } = await storage.saveFile(buffer, {
    filename: filename || 'avatar.png',
    mimeType,
  });
  // NOT a public URL any more: avatars are served by the authenticated,
  // org-checked GET /users/:id/photo (Phase 1 item 7). ?v busts caches.
  const photoUrl = `${config.apiPrefix}/users/${userId}/photo?v=${storageRef.slice(0, 8)}`;
  await User.findByIdAndUpdate(userId, {
    photoUrl,
    profileImage: photoUrl,
    photoStorageRef: storageRef,
    photoMimeType: mimeType,
  });
  return photoUrl;
}

/**
 * Remove a user's profile photo.
 */
async function removeProfilePhoto(userId) {
  await User.findByIdAndUpdate(userId, {
    photoUrl: null,
    profileImage: null,
    photoStorageRef: null,
    photoMimeType: null,
  });
  return null;
}

module.exports = { uploadProfilePhoto, removeProfilePhoto };
