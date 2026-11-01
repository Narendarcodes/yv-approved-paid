const fs = require('fs');
const mongoose = require('mongoose');
const userService = require('../services/user.service');
const User = require('../models/user.model');
const storage = require('../storage');
const access = require('../modules/access/index.cts');
const multer = require('multer');

// In-memory multer for profile photo uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB cap
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'), false);
  },
});

async function me(req, res, next) {
  try {
    const user = await userService.getMe(req.user._id);
    res.json({ data: user });
  } catch (err) {
    next(err);
  }
}

async function myOrganizations(req, res, next) {
  try {
    const orgs = await userService.listMyOrganizations(req.user._id);
    res.json({ data: orgs });
  } catch (err) {
    next(err);
  }
}

async function updateMe(req, res, next) {
  try {
    const user = await userService.updateProfile(req.user._id, req.body);
    res.json({ data: user });
  } catch (err) {
    next(err);
  }
}

async function uploadPhoto(req, res, next) {
  try {
    if (!req.file)
      return res.status(400).json({ error: { code: 'no_file', message: 'No image provided' } });
    const user = await userService.setProfilePhoto(
      req.user._id,
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
    );
    res.json({ data: user });
  } catch (err) {
    next(err);
  }
}

async function removePhoto(req, res, next) {
  try {
    const user = await userService.removeProfilePhoto(req.user._id);
    res.json({ data: user });
  } catch (err) {
    next(err);
  }
}

async function listMembers(req, res, next) {
  try {
    const { organizationId } = req.params;
    const members = await userService.listOrgMembers({ organizationId });
    res.json({ data: members });
  } catch (err) {
    next(err);
  }
}

async function updateMember(req, res, next) {
  try {
    const { organizationId, memberUserId } = req.params;
    const { disabled, role } = req.body; // validated by updateMemberSchema
    const userService = require('../services/user.service');
    const result = await userService.updateMember({
      organizationId,
      userId: memberUserId,
      role,
      disabled,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
}

const AVATAR_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/**
 * GET /users/:userId/photo - the avatar file, for the user themself or anyone
 * sharing an active organization with them; everyone else gets 404. Replaces
 * the public /uploads static mount (Phase 1 item 7). Same-site <img> requests
 * carry the auth cookie.
 */
async function photo(req, res, next) {
  try {
    const id = req.params.userId === 'me' ? String(req.user._id) : req.params.userId;
    const notFound = () =>
      res.status(404).json({ error: { code: 'photo_not_found', message: 'Photo not found' } });
    if (!mongoose.isValidObjectId(id)) return notFound();
    if (!(await access.sharesOrganization(req.user._id, id))) return notFound();
    const u = await User.findById(id).select('photoStorageRef photoMimeType photoUrl').lean();
    if (!u) return notFound();
    const legacy =
      u.photoUrl && u.photoUrl.startsWith('/uploads/')
        ? u.photoUrl.slice('/uploads/'.length)
        : null;
    const ref = u.photoStorageRef || legacy;
    const file = ref && storage.resolvePath(ref);
    if (!file || !fs.existsSync(file)) return notFound();
    const ext = require('path').extname(file).toLowerCase();
    const type = Object.values(AVATAR_MIME).includes(u.photoMimeType)
      ? u.photoMimeType
      : AVATAR_MIME[ext];
    res.set({
      'Content-Type': type || 'application/octet-stream',
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, max-age=300',
    });
    fs.createReadStream(file).on('error', next).pipe(res);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  photo,
  me,
  myOrganizations,
  updateMe,
  uploadPhoto,
  removePhoto,
  listMembers,
  updateMember,
  upload,
};
