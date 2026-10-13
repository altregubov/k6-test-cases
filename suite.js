/**
 * Unified Warehouse REST API k6 v2.3.0 Concurrency, Race-Condition & Stress Suite (NFT.MD)
 *
 * Leverages k6 v2.3.0 native `--scenario` selection and `--once` execution flags:
 *   • Run a single scenario:
 *     ./k6 run --scenario f10_oversell_race suite.js
 *     ./k6 run --scenario f10_overdraft_race suite.js
 *     ./k6 run --scenario f10_cancel_race suite.js
 *   • Run multiple related scenarios together:
 *     ./k6 run --scenario f08_failed_order_flood,f08_unpaginated_orders_poll suite.js
 *     ./k6 run --scenario f10_deadlock_orders,f10_deadlock_cancels,f10_deadlock_topups suite.js
 *     ./k6 run --scenario br01_timing_existing,br01_timing_nonexistent suite.js
 *     ./k6 run --scenario br01_bcrypt_flood,br01_starvation_probe suite.js
 *   • Smoke-test any scenario with 1 VU & 1 iteration (`--once` + `--scenario` in k6 v2.3.0):
 *     ./k6 run --scenario f10_oversell_race --once suite.js
 */

import { check, sleep, fail } from 'k6';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';
import { uniqueName } from './lib/config.js';
import {
  requireAdminToken,
  provisionTestUser,
  provisionTestProduct,
  createOrder,
  updateOrderStatus,
  topUpUserBalance,
  updateProductStock,
  listAdminOrders,
  listUserOrders,
  listUserProducts,
  userLogin,
  deleteAdminUser,
  EXPECTED_2XX,
  EXPECTED_NON_5XX,
  EXPECTED_ORDER_RACE,
  EXPECTED_CANCEL_RACE,
  EXPECTED_LOGIN_401,
} from './lib/api.js';
import { safeJson } from './lib/assertions.js';

export const suite5xxErrors = new Counter('suite_5xx_errors');
export const oversell201 = new Counter('suite_oversell_201');
export const oversell422 = new Counter('suite_oversell_422');
export const overdraft201 = new Counter('suite_overdraft_201');
export const overdraft422 = new Counter('suite_overdraft_422');
export const cancel200 = new Counter('suite_cancel_200');
export const cancel422 = new Counter('suite_cancel_422');

export const options = {
  scenarios: {
    // 01: F-08 FAILED Order Flood & Unpaginated Orders Read Poll
    f08_failed_order_flood: {
      executor: 'constant-vus',
      exec: 'scenFailedOrderFlood',
      vus: 20,
      duration: __ENV.FLOOD_DURATION || '5s',
      startTime: '0s',
    },
    f08_unpaginated_orders_poll: {
      executor: 'constant-vus',
      exec: 'scenUnpaginatedOrdersPoll',
      vus: 4,
      duration: __ENV.FLOOD_DURATION || '5s',
      startTime: '0s',
    },
    // 02: F-10 Inventory Depletion Oversell Race (50 VUs vs Stock 5)
    f10_oversell_race: {
      executor: 'per-vu-iterations',
      exec: 'scenOversellRace',
      vus: 50,
      iterations: 1,
      startTime: '0s',
    },
    // 03: F-10 Balance Overdraft Double-Spend Race (50 VUs vs Balance $300 for $100 item)
    f10_overdraft_race: {
      executor: 'per-vu-iterations',
      exec: 'scenOverdraftRace',
      vus: 50,
      iterations: 1,
      startTime: '0s',
    },
    // 04: F-10 Concurrent Order Cancellation Race (20 VUs cancelling 1 PROCESSED order)
    f10_cancel_race: {
      executor: 'per-vu-iterations',
      exec: 'scenCancelRace',
      vus: 20,
      iterations: 1,
      startTime: '0s',
    },
    // 05: F-10 Cross-Transaction Deadlock Contention (Orders + Cancels + Top-Ups)
    f10_deadlock_orders: {
      executor: 'per-vu-iterations',
      exec: 'scenDeadlockOrders',
      vus: 20,
      iterations: 2,
      startTime: '0s',
    },
    f10_deadlock_cancels: {
      executor: 'per-vu-iterations',
      exec: 'scenDeadlockCancels',
      vus: 10,
      iterations: 2,
      startTime: '0s',
    },
    f10_deadlock_topups: {
      executor: 'per-vu-iterations',
      exec: 'scenDeadlockTopups',
      vus: 10,
      iterations: 2,
      startTime: '0s',
    },
    // 06: F-10 Lost-Update Race on PATCH /api/admin/products/{id}/stock
    f10_lost_update_orders: {
      executor: 'per-vu-iterations',
      exec: 'scenLostUpdateOrders',
      vus: 20,
      iterations: 2,
      startTime: '0s',
    },
    f10_lost_update_patch: {
      executor: 'per-vu-iterations',
      exec: 'scenLostUpdatePatch',
      vus: 2,
      iterations: 2,
      startTime: '0s',
    },
    // 07: BR-01a Timing Side-Channel Check
    br01_timing_existing: {
      executor: 'shared-iterations',
      exec: 'scenTimingExisting',
      vus: 3,
      iterations: 9,
      startTime: '0s',
    },
    br01_timing_nonexistent: {
      executor: 'shared-iterations',
      exec: 'scenTimingNonexistent',
      vus: 3,
      iterations: 9,
      startTime: '0s',
    },
    // 08: BR-01b Bcrypt Cost 12 CPU Saturation Flood + Probe
    br01_bcrypt_flood: {
      executor: 'per-vu-iterations',
      exec: 'scenBcryptFlood',
      vus: 50,
      iterations: 1,
      startTime: '0s',
    },
    br01_starvation_probe: {
      executor: 'constant-vus',
      exec: 'scenStarvationProbe',
      vus: 4,
      duration: '3s',
      startTime: '0s',
    },
  },
  thresholds: {
    suite_5xx_errors: ['count == 0'],
    'http_req_duration{scenario:f08_unpaginated_orders_poll}': ['p(95) < 500'],
    'http_req_failed{scenario:f10_oversell_race}': ['rate == 0'],
    'http_req_failed{scenario:f10_overdraft_race}': ['rate == 0'],
    'http_req_failed{scenario:f10_cancel_race}': ['rate == 0'],
    'http_req_failed{scenario:f10_deadlock_orders}': ['rate == 0'],
    'http_req_failed{scenario:f10_deadlock_cancels}': ['rate == 0'],
    'http_req_failed{scenario:f10_deadlock_topups}': ['rate == 0'],
    'http_req_waiting{scenario:br01_timing_existing}': ['med > 20'],
    'http_req_waiting{scenario:br01_timing_nonexistent}': ['med > 20'],
    'http_req_duration{scenario:br01_starvation_probe}': ['p(95) < 500'],
  },
};

export function setup() {
  const adminToken = requireAdminToken();
  const createdUserIds = [];

  const trackUser = (u) => {
    createdUserIds.push(u.id);
    return u;
  };

  // F-08 Flood fixtures
  const f08Product = provisionTestProduct(adminToken, {
    prefix: 'k6_suite_f08_prod',
    price: 500.0,
    stockQuantity: 2,
  });
  const f08User = trackUser(
    provisionTestUser(adminToken, { prefix: 'k6_suite_f08_user', balance: 10.0 })
  );

  // F-10 Oversell fixtures (Stock = 5)
  const oversellProduct = provisionTestProduct(adminToken, {
    prefix: 'k6_suite_oversell_prod',
    price: 100.0,
    stockQuantity: 5,
  });
  const oversellUser = trackUser(
    provisionTestUser(adminToken, { prefix: 'k6_suite_oversell_user', balance: 50000.0 })
  );

  // F-10 Overdraft fixtures (Balance = 300, Price = 100)
  const overdraftProduct = provisionTestProduct(adminToken, {
    prefix: 'k6_suite_overdraft_prod',
    price: 100.0,
    stockQuantity: 100,
  });
  const overdraftUser = trackUser(
    provisionTestUser(adminToken, { prefix: 'k6_suite_overdraft_user', balance: 300.0 })
  );

  // F-10 Cancel Race fixtures (1 PROCESSED order)
  const cancelProduct = provisionTestProduct(adminToken, {
    prefix: 'k6_suite_cancel_prod',
    price: 100.0,
    stockQuantity: 10,
  });
  const cancelUser = trackUser(
    provisionTestUser(adminToken, { prefix: 'k6_suite_cancel_user', balance: 100.0 })
  );
  const cancelOrderRes = createOrder(cancelUser.token, cancelProduct.id, 1);
  const cancelOrderBody = safeJson(cancelOrderRes);
  if (cancelOrderRes.status !== 201 || !cancelOrderBody?.data?.order_id) {
    fail('Suite setup failed: could not create order for cancel race');
  }

  // F-10 Deadlock fixtures
  const deadlockProduct = provisionTestProduct(adminToken, {
    prefix: 'k6_suite_deadlock_prod',
    price: 10.0,
    stockQuantity: 2000,
  });
  const deadlockUser = trackUser(
    provisionTestUser(adminToken, { prefix: 'k6_suite_deadlock_user', balance: 50000.0 })
  );
  const deadlockOrderIds = [];
  for (let i = 0; i < 20; i++) {
    const r = createOrder(deadlockUser.token, deadlockProduct.id, 1);
    const b = safeJson(r);
    if (r.status === 201 && b?.data?.order_id) {
      deadlockOrderIds.push(b.data.order_id);
    }
  }

  // F-10 Lost-Update & BR-01 fixtures
  const lostUpdateProduct = provisionTestProduct(adminToken, {
    prefix: 'k6_suite_lostupd_prod',
    price: 10.0,
    stockQuantity: 50,
  });
  const lostUpdateUser = trackUser(
    provisionTestUser(adminToken, { prefix: 'k6_suite_lostupd_user', balance: 50000.0 })
  );

  return {
    adminToken,
    createdUserIds,
    f08: { user: f08User, product: f08Product },
    oversell: { user: oversellUser, product: oversellProduct },
    overdraft: { user: overdraftUser, product: overdraftProduct },
    cancel: {
      user: cancelUser,
      product: cancelProduct,
      orderId: cancelOrderBody.data.order_id,
    },
    deadlock: {
      user: deadlockUser,
      product: deadlockProduct,
      orderIds: deadlockOrderIds,
    },
    lostUpdate: { user: lostUpdateUser, product: lostUpdateProduct },
  };
}

export function scenFailedOrderFlood(data) {
  const res = createOrder(data.f08.user.token, data.f08.product.id, 1, {
    responseCallback: EXPECTED_NON_5XX,
  });
  if (res.status >= 500) suite5xxErrors.add(1);
  check(res, { 'F-08 flood returns 422': (r) => r.status === 422 });
}

export function scenUnpaginatedOrdersPoll(data) {
  const uRes = listUserOrders(data.f08.user.token, { responseCallback: EXPECTED_2XX });
  const aRes = listAdminOrders(data.adminToken, { responseCallback: EXPECTED_2XX });
  if (uRes.status >= 500 || aRes.status >= 500) suite5xxErrors.add(1);
  check(uRes, { 'F-08 user orders 200': (r) => r.status === 200 });
  check(aRes, { 'F-08 admin orders 200': (r) => r.status === 200 });
  sleep(0.2);
}

export function scenOversellRace(data) {
  const res = createOrder(data.oversell.user.token, data.oversell.product.id, 1, {
    responseCallback: EXPECTED_ORDER_RACE,
  });
  if (res.status === 201) oversell201.add(1);
  else if (res.status === 422) oversell422.add(1);
  else if (res.status >= 500) suite5xxErrors.add(1);

  check(res, { 'F-10 oversell status is 201 or 422': (r) => r.status === 201 || r.status === 422 });
}

export function scenOverdraftRace(data) {
  const res = createOrder(data.overdraft.user.token, data.overdraft.product.id, 1, {
    responseCallback: EXPECTED_ORDER_RACE,
  });
  if (res.status === 201) overdraft201.add(1);
  else if (res.status === 422) overdraft422.add(1);
  else if (res.status >= 500) suite5xxErrors.add(1);

  check(res, {
    'F-10 overdraft status is 201 or 422': (r) => r.status === 201 || r.status === 422,
  });
}

export function scenCancelRace(data) {
  const res = updateOrderStatus(data.adminToken, data.cancel.orderId, 'CANCELLED', {
    responseCallback: EXPECTED_CANCEL_RACE,
  });
  if (res.status === 200) cancel200.add(1);
  else if (res.status === 422) cancel422.add(1);
  else if (res.status >= 500) suite5xxErrors.add(1);

  check(res, { 'F-10 cancel status is 200 or 422': (r) => r.status === 200 || r.status === 422 });
}

export function scenDeadlockOrders(data) {
  const res = createOrder(data.deadlock.user.token, data.deadlock.product.id, 1, {
    responseCallback: EXPECTED_NON_5XX,
  });
  if (res.status >= 500) suite5xxErrors.add(1);
  check(res, { 'F-10 deadlock order < 500': (r) => r.status < 500 });
}

export function scenDeadlockCancels(data) {
  const idx = exec.scenario.iterationInTest % data.deadlock.orderIds.length;
  const res = updateOrderStatus(data.adminToken, data.deadlock.orderIds[idx], 'CANCELLED', {
    responseCallback: EXPECTED_NON_5XX,
  });
  if (res.status >= 500) suite5xxErrors.add(1);
  check(res, { 'F-10 deadlock cancel < 500': (r) => r.status < 500 });
}

export function scenDeadlockTopups(data) {
  const res = topUpUserBalance(data.adminToken, data.deadlock.user.id, 10.0, {
    responseCallback: EXPECTED_NON_5XX,
  });
  if (res.status >= 500) suite5xxErrors.add(1);
  check(res, { 'F-10 deadlock topup < 500': (r) => r.status < 500 });
}

export function scenLostUpdateOrders(data) {
  const res = createOrder(data.lostUpdate.user.token, data.lostUpdate.product.id, 1, {
    responseCallback: EXPECTED_NON_5XX,
  });
  if (res.status >= 500) suite5xxErrors.add(1);
}

export function scenLostUpdatePatch(data) {
  const res = updateProductStock(data.adminToken, data.lostUpdate.product.id, 50, {
    responseCallback: EXPECTED_NON_5XX,
  });
  if (res.status >= 500) suite5xxErrors.add(1);
}

export function scenTimingExisting(data) {
  const res = userLogin(data.lostUpdate.user.username, 'wrong_pass_timing!', {
    responseCallback: EXPECTED_LOGIN_401,
  });
  if (res.status >= 500) suite5xxErrors.add(1);
  check(res, { 'BR-01 existing user 401': (r) => r.status === 401 });
}

export function scenTimingNonexistent() {
  const res = userLogin(uniqueName('ghost_user'), 'wrong_pass_timing!', {
    responseCallback: EXPECTED_LOGIN_401,
  });
  if (res.status >= 500) suite5xxErrors.add(1);
  check(res, { 'BR-01 nonexistent user 401': (r) => r.status === 401 });
}

export function scenBcryptFlood(data) {
  const res = userLogin(data.lostUpdate.user.username, 'wrong_pass_flood!', {
    responseCallback: EXPECTED_LOGIN_401,
  });
  if (res.status >= 500) suite5xxErrors.add(1);
}

export function scenStarvationProbe(data) {
  const res = listUserProducts(data.lostUpdate.user.token, 'page=1&page_size=10', {
    responseCallback: EXPECTED_2XX,
  });
  if (res.status >= 500) suite5xxErrors.add(1);
  sleep(0.1);
}

export default function (data) {
  scenOversellRace(data);
}

export function teardown(data) {
  if (data && data.adminToken && Array.isArray(data.createdUserIds)) {
    for (const uid of data.createdUserIds) {
      deleteAdminUser(data.adminToken, uid);
    }
  }
}

import { createSummaryHandler } from './lib/html-report.js';
export const handleSummary = createSummaryHandler({
  id: 'suite',
  title: 'Unified NFT.MD Concurrency, Race-Condition & Stress Suite',
  finding: 'NFT.MD • Combined Multi-Scenario Execution (F-08, F-10, BR-01)',
  description:
    'Unified execution of all NFT.MD scenarios in a single k6 test run.',
});
