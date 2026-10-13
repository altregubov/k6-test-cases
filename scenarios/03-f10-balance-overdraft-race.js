/**
 * Scenario 03: F-10 — Balance Overdraft Race (Double-Spend Check)
 *
 * Reference: NFT.MD (Finding F-10: Balance Overdraft Race)
 *
 * Test Case:
 *   • 50 VUs vs. Balance for 3 Items:
 *     1 User with `balance: 300.00` fires 50 simultaneous `POST /api/user/orders`
 *     for a `$100.00` product with `stock_quantity: 100`.
 *   • Assertions:
 *     - `201 Created == 3`
 *     - `422 INSUFFICIENT_FUNDS == 47`
 *     - `0` `500` errors
 *     - Final `balance == 0.00` (never negative)
 *     - Final `stock_quantity == 97`
 *
 * Usage (k6 v2.3.0):
 *   ./k6 run scenarios/03-f10-balance-overdraft-race.js
 */

import { check } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate } from 'k6/metrics';
import { toCents } from '../lib/config.js';
import {
  requireAdminToken,
  provisionTestUser,
  provisionTestProduct,
  createOrder,
  fetchUserById,
  fetchProductById,
  deleteAdminUser,
  EXPECTED_ORDER_RACE,
} from '../lib/api.js';
import { safeJson } from '../lib/assertions.js';
import { createSummaryHandler } from '../lib/html-report.js';

const RACE_VUS = Number(__ENV.RACE_VUS || 50);
const INITIAL_BALANCE = 300.0;
const UNIT_PRICE = 100.0;
const INITIAL_STOCK = 100;
const AFFORDABLE_UNITS = 3;

export const overdraft201Created = new Counter('f10_overdraft_201_created');
export const overdraft422InsufficientFunds = new Counter('f10_overdraft_422_insufficient_funds');
export const overdraft5xxErrors = new Counter('f10_overdraft_5xx_errors');
export const overdraftUnexpectedStatus = new Counter('f10_overdraft_unexpected_status');
export const overdraftInvariantsOk = new Rate('f10_overdraft_invariants_ok');

export const options = {
  scenarios: {
    overdraft_race: {
      executor: 'per-vu-iterations',
      exec: 'attemptSpend',
      vus: RACE_VUS,
      iterations: 1,
      maxDuration: '30s',
    },
  },
  thresholds: {
    f10_overdraft_201_created: [`count == ${AFFORDABLE_UNITS}`],
    f10_overdraft_422_insufficient_funds: [`count == ${RACE_VUS - AFFORDABLE_UNITS}`],
    f10_overdraft_5xx_errors: ['count == 0'],
    f10_overdraft_unexpected_status: ['count == 0'],
    f10_overdraft_invariants_ok: ['rate == 1.0'],
  },
};

export function setup() {
  const adminToken = requireAdminToken();

  const product = provisionTestProduct(adminToken, {
    prefix: 'k6_f10_overdraft_prod',
    category: 'smartphone',
    manufacturer: 'Apple',
    price: UNIT_PRICE,
    stockQuantity: INITIAL_STOCK,
  });

  const user = provisionTestUser(adminToken, {
    prefix: 'k6_f10_overdraft_user',
    balance: INITIAL_BALANCE,
  });

  return {
    adminToken,
    user,
    product,
  };
}

export function attemptSpend(data) {
  const res = createOrder(data.user.token, data.product.id, 1, {
    responseCallback: EXPECTED_ORDER_RACE,
  });
  const body = safeJson(res);

  if (res.status === 201) {
    overdraft201Created.add(1);
    check(body, {
      'F-10 overdraft 201: status is PROCESSED': (b) => b && b.data && b.data.status === 'PROCESSED',
    });
  } else if (
    res.status === 422 &&
    body &&
    body.error &&
    body.error.code === 'INSUFFICIENT_FUNDS'
  ) {
    overdraft422InsufficientFunds.add(1);
  } else if (res.status >= 500) {
    overdraft5xxErrors.add(1);
  } else {
    overdraftUnexpectedStatus.add(1);
  }

  check(res, {
    'F-10 overdraft: no 500 error': (r) => r.status < 500,
    'F-10 overdraft: status is 201 or 422 INSUFFICIENT_FUNDS': (r) =>
      r.status === 201 || r.status === 422,
  });
}

export default function (data) {
  attemptSpend(data);
}

export function teardown(data) {
  const { adminToken, user, product } = data;

  const finalUser = fetchUserById(adminToken, user.id);
  const finalProduct = fetchProductById(adminToken, product.id);

  const actualBalanceCents = finalUser ? toCents(finalUser.balance) : -1;
  const actualStock = finalProduct ? finalProduct.stock_quantity : -1;
  const expectedStock = INITIAL_STOCK - AFFORDABLE_UNITS;

  const balanceOk = actualBalanceCents === 0;
  const stockOk = actualStock === expectedStock;
  overdraftInvariantsOk.add(balanceOk && stockOk);

  const passed = check(
    { actualBalanceCents, actualStock, expectedStock },
    {
      'F-10 Overdraft Invariant: final balance == 0.00 (never negative)': (s) =>
        s.actualBalanceCents === 0,
      'F-10 Overdraft Invariant: final stock_quantity == 97': (s) =>
        s.actualStock === s.expectedStock,
    }
  );

  if (!passed) {
    exec.test.fail(
      `F-10 Overdraft invariant violated: finalBalanceCents=${actualBalanceCents} (expected 0), finalStock=${actualStock} (expected ${expectedStock})`
    );
  }

  deleteAdminUser(adminToken, user.id);
}

export const handleSummary = createSummaryHandler({
  id: '03-f10-balance-overdraft-race',
  title: '03 — F-10: Balance Overdraft Race (Double-Spend Check)',
  finding: 'NFT.MD • Finding F-10: 50 VUs vs. Balance for 3 Items ($300 vs $100)',
  description:
    '1 User with balance: 300.00 fires 50 simultaneous POST /api/user/orders for a $100.00 product with stock_quantity: 100. Asserts 201 Created == 3, 422 INSUFFICIENT_FUNDS == 47, final balance == 0.00, and stock_quantity == 97.',
  vus: RACE_VUS,
});
