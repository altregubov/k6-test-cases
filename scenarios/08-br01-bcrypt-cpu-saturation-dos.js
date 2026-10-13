/**
 * Scenario 08: BR-01b — Bcrypt Cost 12 CPU Saturation DoS & Goroutine Starvation Check
 *
 * Reference: NFT.MD (Finding BR-01: Timing Side-Channel & Bcrypt CPU Saturation)
 *
 * Test Case:
 *   • 50 concurrent login requests (`BcryptCost = 12` takes ~250–350ms CPU per hash)
 *     flood `POST /api/user/login` while authenticated clients concurrently call
 *     `GET /api/user/products` and `GET /api/user/orders`.
 *   • Assertions:
 *     - Checks whether CPU-intensive bcrypt hashing starves `/api/user/products` or
 *       `/api/user/orders` goroutines (`p(95) < 500ms` under concurrent login flood).
 *     - `0` `500`/`503` server errors.
 *
 * Usage (k6 v2.3.0):
 *   ./k6 run scenarios/08-br01-bcrypt-cpu-saturation-dos.js
 */

import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import {
  requireAdminToken,
  provisionTestUser,
  userLogin,
  listUserProducts,
  listUserOrders,
  deleteAdminUser,
  EXPECTED_LOGIN_401,
  EXPECTED_2XX,
} from '../lib/api.js';
import { checkPaginatedEnvelope, checkSuccessEnvelope } from '../lib/assertions.js';
import { createSummaryHandler } from '../lib/html-report.js';

const LOGIN_FLOOD_VUS = Number(__ENV.LOGIN_FLOOD_VUS || 50);
const LOGIN_FLOOD_ITERS = Number(__ENV.LOGIN_FLOOD_ITERS || 1);
const PROBE_VUS = Number(__ENV.PROBE_VUS || 5);
const PROBE_DURATION = __ENV.PROBE_DURATION || '5s';

export const bcryptLoginDuration = new Trend('br01_bcrypt_login_duration', true);
export const starvedProductsLatency = new Trend('br01_probe_products_duration', true);
export const starvedOrdersLatency = new Trend('br01_probe_orders_duration', true);
export const probeSuccessRate = new Rate('br01_probe_success_rate');
export const saturation5xxErrors = new Counter('br01_saturation_5xx_errors');

export const options = {
  scenarios: {
    bcrypt_login_flood: {
      executor: 'per-vu-iterations',
      exec: 'floodBcryptLogins',
      vus: LOGIN_FLOOD_VUS,
      iterations: LOGIN_FLOOD_ITERS,
      startTime: '0s',
      maxDuration: '60s',
    },
    catalog_and_orders_probe: {
      executor: 'constant-vus',
      exec: 'probeCatalogAndOrders',
      vus: PROBE_VUS,
      duration: PROBE_DURATION,
      startTime: '0s',
    },
  },
  thresholds: {
    br01_saturation_5xx_errors: ['count == 0'],
    br01_probe_success_rate: ['rate == 1.0'],
    br01_probe_products_duration: ['p(95) < 500'],
    br01_probe_orders_duration: ['p(95) < 500'],
  },
};

export function setup() {
  const adminToken = requireAdminToken();
  const user = provisionTestUser(adminToken, {
    prefix: 'k6_br01_dos_user',
    balance: 1000.0,
  });

  return {
    adminToken,
    user,
  };
}

export function floodBcryptLogins(data) {
  const res = userLogin(data.user.username, 'wrong_password_cpu_burn!', {
    responseCallback: EXPECTED_LOGIN_401,
  });

  bcryptLoginDuration.add(res.timings.duration);
  if (res.status >= 500) {
    saturation5xxErrors.add(1);
  }

  check(res, {
    'BR-01 login flood: returns 401 (no 5xx)': (r) => r.status === 401,
  });
}

export function probeCatalogAndOrders(data) {
  const prodRes = listUserProducts(data.user.token, 'page=1&page_size=20', {
    responseCallback: EXPECTED_2XX,
  });
  starvedProductsLatency.add(prodRes.timings.duration);
  if (prodRes.status >= 500) saturation5xxErrors.add(1);
  const prodOk = checkPaginatedEnvelope(prodRes, 'BR-01 probe GET /api/user/products');

  const ordersRes = listUserOrders(data.user.token, {
    responseCallback: EXPECTED_2XX,
  });
  starvedOrdersLatency.add(ordersRes.timings.duration);
  if (ordersRes.status >= 500) saturation5xxErrors.add(1);
  const ordersOk = checkSuccessEnvelope(ordersRes, 200, 'BR-01 probe GET /api/user/orders');

  probeSuccessRate.add(prodOk && ordersOk);
  sleep(0.1);
}

export default function (data) {
  probeCatalogAndOrders(data);
}

export function teardown(data) {
  if (data && data.adminToken && data.user && data.user.id) {
    deleteAdminUser(data.adminToken, data.user.id);
  }
}

export const handleSummary = createSummaryHandler({
  id: '08-br01-bcrypt-cpu-saturation-dos',
  title: '08 — BR-01b: Bcrypt Cost 12 CPU Saturation DoS & Goroutine Starvation',
  finding: 'NFT.MD • Finding BR-01: 50 Concurrent Bcrypt Logins vs. Catalog/Order Endpoints',
  description:
    '50 concurrent login requests (BcryptCost = 12, ~250-350ms CPU per hash) flood POST /api/user/login to verify whether login CPU saturation starves /api/user/products or /api/user/orders goroutines.',
  vus: LOGIN_FLOOD_VUS + PROBE_VUS,
});
