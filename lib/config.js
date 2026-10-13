/**
 * Shared configuration and environment defaults for Warehouse REST API k6 v2.3.0 test suite.
 */

export const BASE_URL = (__ENV.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');

export const ADMIN_CREDENTIALS = {
  username: __ENV.ADMIN_USER || 'admin',
  password: __ENV.ADMIN_PASS || 'admin123',
};

export const SEED_USERS = {
  userA: { username: 'userA', password: 'user123' },
  userB: { username: 'userB', password: 'user123' },
  userC: { username: 'userC', password: 'user123' },
};

export const DEFAULT_PASSWORD = __ENV.TEST_USER_PASS || 'k6pass123!';

/**
 * Converts dollar amounts (float/number) to exact integer cents to avoid IEEE-754 drift.
 * Matches TECH_SPEC.md §3.2.4 (DollarsToCents).
 * @param {number} dollars
 * @returns {number}
 */
export function toCents(dollars) {
  return Math.round(Number(dollars) * 100);
}

/**
 * Converts integer cents back to 2-decimal dollar number.
 * @param {number} cents
 * @returns {number}
 */
export function toDollars(cents) {
  return Number((cents / 100).toFixed(2));
}

/**
 * Generates a unique identifier suffix safe for usernames and product models.
 * Uses global WebCrypto `crypto.randomUUID()` natively supported in k6 v2.3.0.
 * @param {string} prefix
 * @returns {string}
 */
export function uniqueName(prefix) {
  const shortUuid = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `${prefix}_${shortUuid}`;
}
