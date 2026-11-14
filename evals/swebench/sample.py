"""Draws a reproducible random subset of SWE-bench Verified.

    uv run --python 3.11 --with datasets python sample.py <count> <seed> <out.json>

The sample is uniform over all 500 instances, so its pass rate estimates Warren's rate on the
whole set (with the uncertainty of a small sample), not on hand-picked easy cases.
"""
import json
import random
import sys

from datasets import load_dataset

count, seed, out = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
rows = list(load_dataset("princeton-nlp/SWE-bench_Verified", split="test"))
rows.sort(key=lambda r: r["instance_id"])
picked = random.Random(seed).sample(rows, count)
fields = ["instance_id", "repo", "base_commit", "problem_statement", "test_patch", "version", "difficulty"]
with open(out, "w") as f:
    json.dump([{k: r.get(k) for k in fields} for r in picked], f, indent=2)
print(f"{len(picked)} of {len(rows)} instances (seed {seed}) -> {out}")
for r in picked:
    print(f"  {r['instance_id']:40} {r.get('difficulty') or ''}")
