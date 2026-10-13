#!/usr/bin/env bash
set -uo pipefail

export PATH="$PATH:$HOME/.nvm/versions/node/v24.21.0/bin:/usr/local/bin:/usr/bin:/bin"

K6_BIN="${K6_BIN:-./k6}"
TREND_STATS="min,avg,med,max,p(90),p(95),p(99)"
EXIT_CODE=0

mkdir -p reports

for script in scenarios/*.js; do
  echo "========================================================================"
  echo "▶ Running: $script"
  echo "========================================================================"
  if ! "$K6_BIN" run --summary-trend-stats="$TREND_STATS" "$script"; then
    echo "⚠ Scenario crossed thresholds or failed: $script"
    EXIT_CODE=1
  fi
  echo ""
done

if command -v node >/dev/null 2>&1; then
  node lib/build-dashboard.mjs
fi

echo "========================================================================"
echo "✅ All scenarios finished. HTML & JSON reports saved in ./reports/"
echo "   Master Dashboard: ./report.html (or ./reports/index.html)"
echo "========================================================================"
exit "$EXIT_CODE"
