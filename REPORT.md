# Warehouse REST API — Concurrency, Race Conditions & Stress Audit Report (Grafana k6 v2.3.0)

- **System Under Test:** `http://localhost:8080` (`warehouse-api` + `postgres:16-alpine`)
- **Load Generator:** `Grafana k6 v2.3.0 (commit/e088784614, go1.26.8, linux/amd64)`
- **Database Cleanup Extension:** Official `k6/x/sql` (`v1.2.0`) + `k6/x/sql/driver/postgres` (`v0.3.1`) auto-provisioned by k6 v2.3.0
- **Interactive HTML Reports:**
  - Master Dashboard: `report.html` / `reports/index.html`
  - Individual Scenario Reports: `reports/01-f08-failed-orders-flood-dos.html` … `reports/08-br01-bcrypt-cpu-saturation-dos.html`

---

## 1. Executive Summary Matrix (NFT.MD Suite)

| # | Scenario Script | NFT.MD Audit Finding / Area | Peak VUs | HTTP Reqs | RPS | `med` (ms) | `p(95)` (ms) | `p(99)` (ms) | `max` (ms) | Checks (✓ / ✗) | Thresholds | Verdict |
| :- | :--- | :--- | -: | -: | -: | -: | -: | -: | -: | :--- | :-: | :--- |
| `01` | `01-f08-failed-orders-flood-dos.js` | **F-08:** Unbounded `FAILED` Order Flooding & Pagination DoS | 24 | 6,472 | 591.11 | 30.89 | 42.76 | 53.73 | 228.59 | `32,487 / 0` | `4/4` | **WARN (Risk F-08: 2.1 MB/response)** |
| `02` | `02-f10-inventory-oversell-race.js` | **F-10:** Inventory Depletion Race (Overselling Check) | 50 | 57 | 84.32 | 80.59 | 122.97 | 229.63 | 232.28 | `107 / 0` | `5/5` | **PASS** |
| `03` | `03-f10-balance-overdraft-race.js` | **F-10:** Balance Overdraft Race (Double-Spend Check) | 50 | 57 | 84.90 | 77.79 | 119.62 | 230.26 | 233.42 | `105 / 0` | `5/5` | **PASS** |
| `04` | `04-f10-order-cancellation-race.js` | **F-10:** Concurrent Order Cancellation Race (Double-Refund Check) | 20 | 28 | 49.06 | 19.30 | 168.35 | 227.63 | 228.10 | `43 / 0` | `5/5` | **PASS** |
| `05` | `05-f10-cross-tx-deadlock.js` | **F-10:** Cross-Transaction Deadlock Detection (`40P01` / `40001`) | 40 | 158 | 4.99 | 2,005.12 | 19,185.67 | 21,470.99 | 23,012.71 | `108 / 133` | `1/5` | **FAIL (PostgreSQL `40P01` Deadlock)** |
| `06` | `06-f10-stock-lost-update-race.js` | **F-10:** Lost-Update Race on `PATCH /api/admin/products/{id}/stock` | 22 | 53 | 80.15 | 46.29 | 79.73 | 228.35 | 231.02 | `46 / 0` | `3/3` | **DETECTED (13 Units Wiped Out)** |
| `07` | `07-br01-login-timing-oracle.js` | **BR-01a:** Timing Side-Channel (`POST /api/user/login` Oracle) | 6 | 34 | 20.13 | 144.65 | 255.01 | 255.90 | 256.02 | `150 / 0` | `4/4` | **DETECTED (3.61× Timing Gap)** |
| `08` | `08-br01-bcrypt-cpu-saturation-dos.js` | **BR-01b:** Bcrypt Cost 12 CPU Saturation DoS (50 Concurrent Logins) | 55 | 436 | 77.79 | 1.98 | 1,732.94 | 1,795.44 | 1,802.41 | `1,769 / 0` | `4/4` | **PASS (Max Probe Spike 355.4ms)** |

---

## 2. Detailed Per-Scenario Audit Reports

### Scenario 01: `scenarios/01-f08-failed-orders-flood-dos.js`
- **Reference:** `NFT.MD` — **F-08: Unbounded `FAILED` Order Flooding & Pagination DoS**
- **Workload:**
  - `write_flood` (`20 VUs`, `constant-vus`): Rapidly submits invalid orders (`422 INSUFFICIENT_FUNDS` & `422 INSUFFICIENT_STOCK`).
  - `read_degradation` (`4 VUs`, `constant-vus`): Concurrently polls unpaginated `GET /api/admin/orders` and `GET /api/user/orders`.
- **Observed Metrics:**
  - `f08_failed_orders_recorded_422`: **6,180 `FAILED` orders** inserted in 10 seconds (`564.8/s`) at **$0.00 balance cost** and **0 stock depletion** (`f08_zero_cost_invariant_ok = 100%`).
  - `f08_orders_payload_bytes`: Single unpaginated response payload grew from `78 B` to **2.10 MB**, generating **285 MB** of network RX across 4 polling VUs in 10 seconds.
  - `f08_admin_orders_poll_duration`: `med = 24.12 ms`, `p(95) = 44.50 ms`.
  - `f08_user_orders_poll_duration`: `med = 18.95 ms`, `p(95) = 38.12 ms`.
- **Verdict:** **ARCHITECTURAL RISK CONFIRMED (F-08)** — An authenticated buyer with zero purchasing power can infinitely append `FAILED` rows to `orders`, causing linear payload and memory amplification on unpaginated order listing endpoints.

---

### Scenario 02: `scenarios/02-f10-inventory-oversell-race.js`
- **Reference:** `NFT.MD` — **F-10: Inventory Depletion Race (Overselling Check)**
- **Workload:** `50 VUs` (`per-vu-iterations`, 1 iteration/VU) simultaneously ordering 1 unit of a product with `stock_quantity = 5` and `balance = $100,000.00`.
- **Observed Metrics:**
  - `f10_oversell_201_created`: **`5`** (Threshold `count == 5` ✓)
  - `f10_oversell_422_insufficient_stock`: **`45`** (Threshold `count == 45` ✓)
  - `f10_oversell_5xx_errors`: **`0`** (Threshold `count == 0` ✓)
  - Post-test database invariants (`f10_oversell_invariants_ok = 100%`): Final `stock_quantity == 0` and user balance debited by exactly `5 × $100.00 = $500.00`.
- **Verdict:** **PASS** — Atomic row locking prevents inventory overselling.

---

### Scenario 03: `scenarios/03-f10-balance-overdraft-race.js`
- **Reference:** `NFT.MD` — **F-10: Balance Overdraft Race (Double-Spend Check)**
- **Workload:** `50 VUs` (`per-vu-iterations`, 1 iteration/VU) sharing a single user account (`balance = $300.00`) simultaneously ordering a `$100.00` product (`stock_quantity = 100`).
- **Observed Metrics:**
  - `f10_overdraft_201_created`: **`3`** (Threshold `count == 3` ✓)
  - `f10_overdraft_422_insufficient_funds`: **`47`** (Threshold `count == 47` ✓)
  - `f10_overdraft_5xx_errors`: **`0`** (Threshold `count == 0` ✓)
  - Post-test database invariants (`f10_overdraft_invariants_ok = 100%`): Final `balance == $0.00` (never negative) and `stock_quantity == 97`.
- **Verdict:** **PASS** — Atomic balance locking prevents account overdraft / double-spending.

---

### Scenario 04: `scenarios/04-f10-order-cancellation-race.js`
- **Reference:** `NFT.MD` — **F-10: Concurrent Order Cancellation Race (Double-Refund Check)**
- **Workload:** `20 VUs` (`per-vu-iterations`, 1 iteration/VU) simultaneously sending `PATCH /api/admin/orders/{id}/status` (`{"status": "CANCELLED"}`) for the same `PROCESSED` order.
- **Observed Metrics:**
  - `f10_cancel_200_ok`: **`1`** (Threshold `count == 1` ✓)
  - `f10_cancel_422_invalid_status`: **`19`** (Threshold `count == 19` ✓)
  - `f10_cancel_5xx_errors`: **`0`** (Threshold `count == 0` ✓)
  - Post-test database invariants (`f10_cancel_invariants_ok = 100%`): Customer balance refunded once (`$0.00 -> $100.00`) and product stock restored once (`9 -> 10`).
- **Verdict:** **PASS** — Terminal status guard inside the cancellation transaction prevents double-refunds.

---

### Scenario 05: `scenarios/05-f10-cross-tx-deadlock.js`
- **Reference:** `NFT.MD` — **F-10: Cross-Transaction Deadlock Detection (`40P01` / `40001`)**
- **Workload:** 3 concurrent scenarios targeting the **same `user_id` and `product_id`**:
  - `scenario_a_create_orders` (`20 VUs`, 3 iterations/VU): `POST /api/user/orders`
  - `scenario_b_cancel_orders` (`10 VUs`, 3 iterations/VU): `PATCH /api/admin/orders/{id}/status`
  - `scenario_c_topup_balance` (`10 VUs`, 3 iterations/VU): `POST /api/admin/users/{id}/balance/top-up`
- **Observed Metrics & Evidence:**
  - PostgreSQL Server Log captured repeated **`ERROR: deadlock detected (SQLSTATE 40P01)`**:
    ```text
    ERROR: deadlock detected
    DETAIL: Process 37209 waits for ShareLock on transaction 17437; blocked by process 37202.
            Process 37202 waits for ShareLock on transaction 17439; blocked by process 37209.
            Process 37209: SELECT id, category, manufacturer, model, price, stock_quantity FROM products WHERE id = $1 FOR UPDATE
            Process 37202: SELECT balance FROM users WHERE id = $1 FOR UPDATE
    ```
  - `warehouse-api` emitted **HTTP `500 Internal Server Error`** responses (`latency_ms: 1002.5 ms .. 5017.0 ms`) and dropped active client connections with `EOF` (`p(95) = 19,185.67 ms`).
- **Verdict:** **FAIL (Vulnerability F-10 Confirmed)** — Inconsistent lock acquisition ordering across `users` and `products` between order creation, order cancellation, and balance top-up causes PostgreSQL `40P01` deadlocks under multi-actor contention.

---

### Scenario 06: `scenarios/06-f10-stock-lost-update-race.js`
- **Reference:** `NFT.MD` — **F-10: Lost-Update Race on `PATCH /api/admin/products/{id}/stock`**
- **Workload:** `20 VUs` purchasing units (`POST /api/user/orders`, 40 total orders) while `2 VUs` concurrently execute `PATCH /api/admin/products/{id}/stock` (`{"stock_quantity": 50}`, 6 updates).
- **Observed Metrics:**
  - `f10_lost_update_purchases_201`: **`40`** confirmed orders (`201 Created`).
  - `f10_lost_update_admin_patches_200`: **`6`** stock updates (`200 OK`).
  - `f10_lost_update_overwritten_units`: **`13`** units (`InitialStock = 50`, `ProcessedOrderUnits = 40`, `FinalStock = 23` instead of `10`).
- **Verdict:** **ANOMALY CONFIRMED (F-10 Lost-Update)** — Absolute stock assignment (`SET stock_quantity = $1`) overwrites concurrent order decrements (`stock_quantity = stock_quantity - quantity`), corrupting inventory accounting.

---

### Scenario 07: `scenarios/07-br01-login-timing-oracle.js`
- **Reference:** `NFT.MD` — **BR-01: Timing Side-Channel (Timing Oracle Check)**
- **Workload:** Compares `http_req_waiting` (`p50`/`p95`) on `POST /api/user/login` across 15 samples for an existing username (wrong password) vs. 15 samples for non-existent usernames.
- **Observed Metrics:**
  - `br01_login_waiting_existing_user`: `min = 221.75 ms`, **`med = 228.59 ms`**, `p(95) = 255.47 ms`, `max = 255.98 ms`.
  - `br01_login_waiting_nonexistent_user`: `min = 58.11 ms`, **`med = 63.30 ms`**, `p(95) = 68.02 ms`, `max = 68.39 ms`.
- **Verdict:** **VULNERABILITY CONFIRMED (BR-01 Timing Oracle)** — Although a dummy bcrypt hash is executed on non-existent usernames, its work factor (~cost 10, `~63 ms`) is **3.61× faster** than real user password hashes (`BcryptCost = 12`, `~229 ms`), creating disjoint latency distributions that allow trivial username enumeration.

---

### Scenario 08: `scenarios/08-br01-bcrypt-cpu-saturation-dos.js`
- **Reference:** `NFT.MD` — **BR-01: Bcrypt Cost 12 CPU Saturation DoS**
- **Workload:** `50 VUs` concurrently firing `POST /api/user/login` (`BcryptCost = 12`) while `5 VUs` continuously probe `GET /api/user/products` and `GET /api/user/orders` for 5 seconds.
- **Observed Metrics:**
  - `br01_bcrypt_login_duration`: `min = 1,351.2 ms`, **`med = 1,732.9 ms`**, `p(95) = 1,796.1 ms`, `max = 1,802.4 ms`.
  - `br01_probe_products_duration`: `med = 2.05 ms`, `avg = 20.14 ms`, **`p(95) = 118.42 ms`**, `max = 355.42 ms`.
  - `br01_probe_orders_duration`: `med = 1.12 ms`, `avg = 16.85 ms`, **`p(95) = 124.28 ms`**, `max = 298.15 ms`.
  - `br01_saturation_5xx_errors`: **`0`**.
- **Verdict:** **PASS (`p(95) < 500 ms`)** — Go's scheduler kept catalog and order endpoints responsive (`p95 ~118–124 ms`) with zero `5xx` errors, though unthrottled login floods caused a ~30× increase in `p(95)` latency and tail spikes up to `355.42 ms`.
