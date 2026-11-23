#!/bin/bash
# Converts each PDF, round-trips through libcdr, and reports pixel differences per page.
for f in "$@"; do
  n=$(basename "$f" .pdf)
  mkdir -p scratch/batch/$n
  if ! timeout 120 npx tsx bin/pdf2cdr.ts "$f" -o scratch/batch/$n/out.cdr > scratch/batch/$n/convert.log 2>&1; then
    echo "$n: CONVERT FAILED: $(tail -2 scratch/batch/$n/convert.log | tr '\n' ' ' | cut -c1-200)"; continue
  fi
  res=$(timeout 120 python3 test/verify.py "$f" scratch/batch/$n/out.cdr scratch/batch/$n 2>&1 | tail -1)
  echo "$n: $(head -1 scratch/batch/$n/convert.log | cut -c1-120) | $res"
done
