/**
 * Scenario 02: F-10 — Inventory Depletion Race (Overselling Check)
 *
 * Reference: NFT.MD (Finding F-10: Inventory Depletion Race)
 *
 * Test Case:
 *   • 50 VUs vs. Stock of 5:
 *     50 VUs simultaneously call `POST /api/user/orders` (`quantity: 1`) for a product
 *     with `stock_quantity: 5` and high user balance.
 *   • Assertions:
 *     - `201 Created == 5`
 *     - `422 INSUFFICIENT_STOCK == 45`
 *     - `0` `500` errors (no unhandled SQL `40001` serialization failures)
 *     - Final `stock_quantity == 0`
 *     - Final user balance debited exactly `5 * price`
 *
 * Usage (k6 v2.3.0):
 *   ./k6 run scenarios/02-f10-inventory-oversell-race.js
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
const INITIAL_STOCK = Number(__ENV.INITIAL_STOCK || 5);
const UNIT_PRICE = 100.0;
const INITIAL_BALANCE = 100000.0;

export const oversell201Created = new Counter('f10_oversell_201_created');
export const oversell422InsufficientStock = new Counter('f10_oversell_422_insufficient_stock');
export const oversell5xxErrors = new Counter('f10_oversell_5xx_errors');
export const oversellUnexpectedStatus = new Counter('f10_oversell_unexpected_status');
export const oversellInvariantsOk = new Rate('f10_oversell_invariants_ok');

export const options = {
  scenarios: {
    oversell_race: {
      executor: 'per-vu-iterations',
      exec: 'attemptPurchase',
      vus: RACE_VUS,
      iterations: 1,
      maxDuration: '30s',
    },
  },
  thresholds: {
    f10_oversell_201_created: [`count == ${INITIAL_STOCK}`],
    f10_oversell_422_insufficient_stock: [`count == ${RACE_VUS - INITIAL_STOCK}`],
    f10_oversell_5xx_errors: ['count == 0'],
    f10_oversell_unexpected_status: ['count == 0'],
    f10_oversell_invariants_ok: ['rate == 1.0'],
  },
};

export function setup() {
  const adminToken = requireAdminToken();

  const product = provisionTestProduct(adminToken, {
    prefix: 'k6_f10_oversell_prod',
    category: 'laptop',
    manufacturer: 'Apple',
    price: UNIT_PRICE,
    stockQuantity: INITIAL_STOCK,
  });

  const user = provisionTestUser(adminToken, {
    prefix: 'k6_f10_oversell_user',
    balance: INITIAL_BALANCE,
  });

  return {
    adminToken,
    user,
    product,
    initialStock: INITIAL_STOCK,
    unitPrice: UNIT_PRICE,
    initialBalance: INITIAL_BALANCE,
  };
}

export function attemptPurchase(data) {
  const res = createOrder(data.user.token, data.product.id, 1, {
    responseCallback: EXPECTED_ORDER_RACE,
  });
  const body = safeJson(res);

  if (res.status === 201) {
    oversell201Created.add(1);
    check(body, {
      'F-10 oversell 201: status is PROCESSED': (b) => b && b.data && b.data.status === 'PROCESSED',
    });
  } else if (
    res.status === 422 &&
    body &&
    body.error &&
    body.error.code === 'INSUFFICIENT_STOCK'
  ) {
    oversell422InsufficientStock.add(1);
  } else if (res.status >= 500) {
    oversell5xxErrors.add(1);
  } else {
    oversellUnexpectedStatus.add(1);
  }

  check(res, {
    'F-10 oversell: no 500 serialization failure': (r) => r.status < 500,
    'F-10 oversell: status is 201 or 422 INSUFFICIENT_STOCK': (r) =>
      r.status === 201 || r.status === 422,
  });
}

export default function (data) {
  attemptPurchase(data);
}

export function teardown(data) {
  const { adminToken, user, product, initialStock, unitPrice, initialBalance } = data;

  const finalProduct = fetchProductById(adminToken, product.id);
  const finalUser = fetchUserById(adminToken, user.id);

  const expectedBalanceCents = toCents(initialBalance) - initialStock * toCents(unitPrice);
  const actualBalanceCents = finalUser ? toCents(finalUser.balance) : -1;
  const actualStock = finalProduct ? finalProduct.stock_quantity : -1;

  const stockOk = actualStock === 0;
  const balanceOk = actualBalanceCents === expectedBalanceCents;
  oversellInvariantsOk.add(stockOk && balanceOk);

  const passed = check(
    { actualStock, actualBalanceCents, expectedBalanceCents },
    {
      'F-10 Oversell Invariant: final stock_quantity == 0 (never negative)': (s) =>
        s.actualStock === 0,
      'F-10 Oversell Invariant: user balance debited exactly 5 * price': (s) =>
        s.actualBalanceCents === s.expectedBalanceCents,
    }
  );

  if (!passed) {
    exec.test.fail(
      `F-10 Oversell invariant violated: finalStock=${actualStock} (expected 0), finalBalanceCents=${actualBalanceCents} (expected ${expectedBalanceCents})`
    );
  }

  deleteAdminUser(adminToken, user.id);
}

export const handleSummary = createSummaryHandler({
  id: '02-f10-inventory-oversell-race',
  title: '02 — F-10: Inventory Depletion Race (Overselling Check)',
  finding: 'NFT.MD • Finding F-10: 50 VUs vs. Stock of 5',
  description:
    '50 VUs simultaneously call POST /api/user/orders (quantity: 1) for a product with stock_quantity: 5 and high user balance. Asserts 201 Created == 5, 422 INSUFFICIENT_STOCK == 45, 0 5xx errors, final stock == 0, and balance debited 5 * price.',
  vus: RACE_VUS,
});
