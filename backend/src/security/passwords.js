const bcrypt = require("bcrypt");

// Keep password hashes at the same cost for public registration and trusted
// bootstrap operations.
const BCRYPT_ROUNDS = 12;

function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

module.exports = { BCRYPT_ROUNDS, hashPassword };
