# Warehouse REST API — Grafana k6 v2.3.0 Test Suite (`NFT.MD`)

Automated concurrency, race-condition, lock-contention, and cryptographic stress test suite for the **Warehouse REST API Testbench**, built for **Grafana k6 v2.3.0** according to `NFT.MD`, `TECH_SPEC.md`, `CLIENT_SPEC.md`, and `swagger.json`.

---

## 1. Repository Structure

```text
├── k6                                              # Grafana k6 v2.3.0 binary (linux/amd64)
├── lib/
│   ├── config.js                                   # Base URL, credentials, exact-cent helpers, UUID generator
│   ├── api.js                                      # Typed client for all 14 Swagger endpoints + fixture provisioning
│   ├── assertions.js                               # SuccessEnvelope, PaginatedEnvelope, and ErrorEnvelope checks
│   ├── db.js                                       # Automatic PostgreSQL hard cleanup via k6/x/sql in teardown()
│   └── html-report.js                              # Self-contained HTML & JSON summary generator (handleSummary)
├── scenarios/
│   ├── 01-f08-failed-orders-flood-dos.js           # F-08: Unbounded FAILED order flood + unpaginated GET /orders DoS
│   ├── 02-f10-inventory-oversell-race.js           # F-10: 50 VUs vs. Stock of 5 (Overselling check)
│   ├── 03-f10-balance-overdraft-race.js            # F-10: 50 VUs vs. Balance $300 for $100 item (Double-spend check)
│   ├── 04-f10-order-cancellation-race.js           # F-10: 20 Admin VUs cancelling same PROCESSED order (Double-refund)
│   ├── 05-f10-cross-tx-deadlock.js                 # F-10: Multi-actor lock contention (Orders + Cancels + Top-Ups)
│   ├── 06-f10-stock-lost-update-race.js            # F-10: Concurrent PATCH /stock vs. POST /orders lost-update race
│   ├── 07-br01-login-timing-oracle.js              # BR-01a: Timing side-channel on POST /api/user/login
│   └── 08-br01-bcrypt-cpu-saturation-dos.js        # BR-01b: 50 VUs Bcrypt cost-12 flood vs. catalog/orders probe
├── suite.js                                        # Unified multi-scenario runner (--scenario & --once support)
├── report.html                                     # Master interactive HTML dashboard (root view)
├── reports/
│   ├── index.html                                  # Master interactive HTML dashboard
│   ├── 01-f08-failed-orders-flood-dos.{html,json}
│   └── ... (01..08 HTML & JSON reports)
└── REPORT.md                                       # Complete Markdown audit report
```

---

## 2. Fixture Lifecycle & Automatic Database Cleanup

1. **Isolated Provisioning (`setup()`):**
   - Logs in as administrator (`POST /api/admin/login`).
   - Provisions a dedicated test product (`POST /api/admin/products` with `model: "k6_<scenario>_<uuid>"`) and dedicated test user (`POST /api/admin/users` with `username: "k6_<scenario>_<uuid>"`).
   - Pre-authenticates the test user once in `setup()` (`POST /api/user/login`) and distributes the Bearer JWT across all VUs so `BcryptCost = 12` hashing does not skew transaction race timing.
2. **Two-Stage Cleanup (`teardown()`):**
   - **Stage 1 (REST API Soft-Delete):** Calls `DELETE /api/admin/users/{id}` (`deleted_at = NOW()`).
   - **Stage 2 (Automatic PostgreSQL Hard Purge via `k6/x/sql`):** Uses k6 v2.3.0 automatic extension resolution (`k6/x/sql` + `k6/x/sql/driver/postgres` in `lib/db.js`) to physically delete `k6_%` and `ghost_%` records from `orders`, `products`, and `users` in foreign-key order while leaving initial seed data (`admin`, `userA`, `userB`, `userC`, and the 5 seed products) untouched.
   - Set `SKIP_DB_PURGE=1` to retain test rows in PostgreSQL after a run for manual inspection.

---

## 3. Running the Scenarios (`k6 v2.3.0`)

```bash
# Run individual NFT.MD scenarios (each automatically generates reports/<id>.html and reports/<id>.json)
./k6 run scenarios/01-f08-failed-orders-flood-dos.js
./k6 run scenarios/02-f10-inventory-oversell-race.js
./k6 run scenarios/03-f10-balance-overdraft-race.js
./k6 run scenarios/04-f10-order-cancellation-race.js
./k6 run scenarios/05-f10-cross-tx-deadlock.js
./k6 run scenarios/06-f10-stock-lost-update-race.js
./k6 run scenarios/07-br01-login-timing-oracle.js
./k6 run scenarios/08-br01-bcrypt-cpu-saturation-dos.js

# Run selected scenarios from the unified suite.js using k6 v2.3.0 --scenario flag
./k6 run --scenario f10_oversell_race suite.js
./k6 run --scenario f10_deadlock_orders,f10_deadlock_cancels,f10_deadlock_topups suite.js

# Smoke-test a scenario with 1 VU and 1 iteration using k6 v2.3.0 --once flag
./k6 run --scenario f10_oversell_race --once suite.js
```
