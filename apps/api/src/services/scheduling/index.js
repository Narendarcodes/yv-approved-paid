/**
 * Publishing adapter boundary (PRD §17): the rest of the app talks to a
 * provider through this module and never to Postiz directly.
 * Routing is per channel - demo channels always use the local scheduler,
 * Postiz-linked channels use Postiz.
 */
const localProvider = require('./local.provider');
const postizProvider = require('./postiz.provider');
const postizClient = require('../../integrations/postiz/client');

function postizEnabled() {
  return postizClient.isConfigured();
}

function providerFor(channelOrPublication) {
  const key = channelOrPublication && (channelOrPublication.provider || channelOrPublication.mode);
  if (key === 'postiz') return postizProvider;
  return localProvider;
}

function mode() {
  return postizEnabled() ? 'postiz' : 'local';
}

module.exports = { providerFor, postizEnabled, mode, localProvider, postizProvider };
