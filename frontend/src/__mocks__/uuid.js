// CJS shim so Jest can import uuid v14 (pure ESM) without transformation.
// Uses Node's built-in crypto.randomUUID for real UUID values.
const crypto = require('node:crypto');
module.exports = { v4: () => crypto.randomUUID() };
