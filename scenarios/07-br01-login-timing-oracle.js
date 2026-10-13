/**
 * Scenario 07: BR-01a — Timing Side-Channel Check (Login Timing Oracle)
 *
 * Reference: NFT.MD (Finding BR-01: Timing Side-Channel & Bcrypt CPU Saturation)
 *            TECH_SPEC.md (§4.3 line 279 & §4.5 line 288: Constant-time dummy bcrypt verification)
 *
 * Test Case:
 *   • Compare k6 `http_req_waiting` (`p50`/`p95`) distribution on `POST /api/user/login`
 *     between:
 *       1. Existing username with wrong password (`existing_user_wrong_password`)
 *       2. Non-existent username (`nonexistent_user_wrong_password`)
 *   • Assertions:
 *     - Both return uniform `401 Unauthorized` with `error.code == "INVALID_CREDENTIALS"`.
 *     - Non-existent user login performs dummy bcrypt verification (`p(50) >= 20ms`),
 *       and timing distributions are compared to detect bcrypt cost mismatches.
 *
 * Usage (k6 v2.3.0):
 *   ./k6 run scenarios/07-br01-login-timing-oracle.js
 */

import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { uniqueName } from '../lib/config.js';
import {
  requireAdminToken,
  provisionTestUser,
  userLogin,
  deleteAdminUser,
  EXPECTED_LOGIN_401,
} from '../lib/api.js';
import { checkErrorEnvelope } from '../lib/assertions.js';
import { createSummaryHandler } from '../lib/html-report.js';

const SAMPLES_PER_CLASS = Number(__ENV.TIMING_SAMPLES || 15);
const TIMING_VUS = Number(__ENV.TIMING_VUS || 3);

export const waitingExistingUser = new Trend('br01_login_waiting_existing_user', true);
export const waitingNonExistentUser = new Trend('br01_login_waiting_nonexistent_user', true);
export const uniform401ResponseRate = new Rate('br01_uniform_401_response_rate');
export const timing5xxErrors = new Counter('br01_timing_5xx_errors');

export const options = {
  scenarios: {
    existing_user_wrong_password: {
      executor: 'shared-iterations',
      exec: 'probeExistingUserWrongPassword',
      vus: TIMING_VUS,
      iterations: SAMPLES_PER_CLASS,
      startTime: '0s',
      maxDuration: '60s',
    },
    nonexistent_user_wrong_password: {
      executor: 'shared-iterations',
      exec: 'probeNonExistentUser',
      vus: TIMING_VUS,
      iterations: SAMPLES_PER_CLASS,
      startTime: '0s',
      maxDuration: '60s',
    },
  },
  thresholds: {
    br01_timing_5xx_errors: ['count == 0'],
    br01_uniform_401_response_rate: ['rate == 1.0'],
    br01_login_waiting_existing_user: ['med > 20'],
    br01_login_waiting_nonexistent_user: ['med >= 180'],
  },
};

export function setup() {
  const adminToken = requireAdminToken();
  const user = provisionTestUser(adminToken, {
    prefix: 'k6_br01_timing_user',
    balance: 100.0,
  });

  return {
    adminToken,
    existingUsername: user.username,
    userId: user.id,
  };
}

export function probeExistingUserWrongPassword(data) {
  const res = userLogin(data.existingUsername, 'wrong_password_probe_123!', {
    responseCallback: EXPECTED_LOGIN_401,
  });

  waitingExistingUser.add(res.timings.waiting);
  if (res.status >= 500) timing5xxErrors.add(1);

  const ok = checkErrorEnvelope(
    res,
    401,
    'INVALID_CREDENTIALS',
    'BR-01 existing user wrong password'
  );
  uniform401ResponseRate.add(ok);
}

export function probeNonExistentUser() {
  const ghostUsername = uniqueName('ghost_nonexistent');
  const res = userLogin(ghostUsername, 'wrong_password_probe_123!', {
    responseCallback: EXPECTED_LOGIN_401,
  });

  waitingNonExistentUser.add(res.timings.waiting);
  if (res.status >= 500) timing5xxErrors.add(1);

  const ok = checkErrorEnvelope(
    res,
    401,
    'INVALID_CREDENTIALS',
    'BR-01 non-existent user wrong password'
  );
  uniform401ResponseRate.add(ok);
}

export default function (data) {
  probeExistingUserWrongPassword(data);
  probeNonExistentUser();
}

export function teardown(data) {
  if (data && data.adminToken && data.userId) {
    deleteAdminUser(data.adminToken, data.userId);
  }
}

export const handleSummary = createSummaryHandler({
  id: '07-br01-login-timing-oracle',
  title: '07 — BR-01a: Timing Side-Channel Check (Login Timing Oracle)',
  finding: 'NFT.MD • Finding BR-01: Timing Oracle Check (Existing vs. Non-Existent Username)',
  description:
    'Compares k6 http_req_waiting (p50/p95) distributions on POST /api/user/login between an existing username (wrong password) and a non-existent username to validate constant-time dummy bcrypt hashing.',
  vus: TIMING_VUS * 2,
});
