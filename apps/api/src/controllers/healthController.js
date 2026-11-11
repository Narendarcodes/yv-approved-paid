const mongoose = require('mongoose');
const { agentStatus } = require('../agent/routing');

function agentStatusSafe() {
  try {
    return agentStatus();
  } catch {
    return null;
  }
}

function health(req, res) {
  const dbState = mongoose.connection.readyState; // 0 = disconnected, 1 = connected
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    db: { connected: dbState === 1, state: dbState },
    // Render hour budget + which deal agent serves calls (render | azure). Read-only.
    agent: agentStatusSafe(),
  });
}

module.exports = { health };
