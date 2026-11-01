const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true },
    disabled: { type: Boolean, default: false },
    photoUrl: { type: String, default: null },
    profileImage: { type: String, default: null },
    // Stored avatar file (storage ref + type). Never exposed: clients use
    // photoUrl, an authenticated API route (GET /users/:id/photo).
    photoStorageRef: { type: String, default: null },
    photoMimeType: { type: String, default: null },
    // default organization membership will be created separately
  },
  { timestamps: true },
);

// Keep photoUrl and profileImage in sync — both are the same avatar URL
UserSchema.pre('save', function (next) {
  if (this.isModified('photoUrl') && this.photoUrl !== this.profileImage) {
    this.profileImage = this.photoUrl;
  } else if (this.isModified('profileImage') && this.profileImage !== this.photoUrl) {
    this.photoUrl = this.profileImage;
  }
  next();
});

/**
 * Public avatar URL: the authenticated, org-checked route. Legacy values that
 * pointed at the old public /uploads/<ref> static dir are rewritten on output.
 */
function avatarUrl(user) {
  const url = user.photoUrl || user.profileImage || null;
  if (!url || !url.startsWith('/uploads/')) return url;
  const ref = url.slice('/uploads/'.length);
  return `${require('../config').apiPrefix}/users/${user._id}/photo?v=${ref.slice(0, 8)}`;
}
UserSchema.statics.avatarUrl = avatarUrl;

UserSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.passwordHash;
  delete obj.photoStorageRef;
  delete obj.photoMimeType;
  const url = avatarUrl(obj);
  obj.photoUrl = url;
  obj.profileImage = url;
  // Ensure both aliases are present for frontend compatibility
  if (obj.photoUrl && !obj.profileImage) obj.profileImage = obj.photoUrl;
  if (obj.profileImage && !obj.photoUrl) obj.photoUrl = obj.profileImage;
  return obj;
};

const User = mongoose.model('User', UserSchema);
module.exports = User;
