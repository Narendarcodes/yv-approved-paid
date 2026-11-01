const local = require('./local');

/**
 * Storage adapter boundary. Add object-store drivers here and switch via
 * config.storage.driver without touching callers.
 */
const driver = process.env.STORAGE_DRIVER || 'local';

function saveFile(data, meta) {
  if (driver === 'local') return local.saveFile(data, meta);
  throw {
    status: 500,
    code: 'storage_unsupported',
    message: `Unsupported storage driver: ${driver}`,
  };
}

function getFile(storageRef) {
  if (driver === 'local') return local.getFile(storageRef);
  throw {
    status: 500,
    code: 'storage_unsupported',
    message: `Unsupported storage driver: ${driver}`,
  };
}

/** Absolute local path for streaming (local driver only), or null if invalid. */
function resolvePath(storageRef) {
  if (driver === 'local') return local.resolvePath(storageRef);
  throw {
    status: 500,
    code: 'storage_unsupported',
    message: `Unsupported storage driver: ${driver}`,
  };
}

module.exports = { saveFile, getFile, resolvePath, driver };
