#!/usr/bin/env bash
# Run each test file in its own Bun process to avoid mock.module() conflicts.
# Bun's mock.module() is process-global — mocks from one file bleed into others
# when all files run in a single process, causing import failures and segfaults.
set -uo pipefail

passed=0
failed=0
failures=()

for f in test/**/*.test.ts; do
  output=$(bun test "$f" 2>&1)
  if echo "$output" | grep -q ' 0 fail'; then
    ((passed++))
  else
    ((failed++))
    failures+=("$f")
    echo "FAIL: $f"
    # Print full output — module load failures don't emit '(fail)' lines,
    # so the prior grep hid the root cause in CI.
    echo "----- begin output -----"
    echo "$output"
    echo "----- end output -----"
  fi
done

echo ""
echo "=== Test Summary ==="
echo "Files passed: $passed"
echo "Files failed: $failed"

if [ ${#failures[@]} -gt 0 ]; then
  echo ""
  echo "Failed files:"
  for f in "${failures[@]}"; do
    echo "  - $f"
  done
  exit 1
fi

echo "All tests passed."
