const { shout } = require('./lib/impl');
function greet(name) { return shout(`hello ${name}`); }
module.exports = { greet };
