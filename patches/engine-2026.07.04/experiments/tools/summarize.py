#!/usr/bin/env python3
"""Aggregate whole-run bench files into min-of-N per binary and print the deltas."""
import re, sys, os
def read(f):
    t = open(f).read()
    g = lambda k: float(re.search(k + r'=(\d+(?:\.\d+)?)', t).group(1))
    return g('instructions'), g('cycles'), g('thread_cpu_ms')
def agg(files):
    rows = [read(f) for f in files if os.path.exists(f)]
    if not rows: return None
    cols = list(zip(*rows))
    return [(min(c), (max(c)-min(c))/min(c)*100) for c in cols], len(rows)
for label, sf, hf in (
    ("medium  (16p, 13:25, 24150 f)",
     ['bench_wholestock.txt','bench_medstock2.txt','bench_medstock3.txt'],
     ['bench_wholeh30.txt','bench_medh302.txt','bench_medh303.txt']),
    ("isthmus (8v8, 27:31, 49380 f)",
     ['bench_isthstock.txt','bench_isthstock2.txt','bench_isthstock3.txt'],
     ['bench_isthh30.txt','bench_isthh302.txt','bench_isthh303.txt']),
):
    s, ns = agg(sf) or (None, 0); h, nh = agg(hf) or (None, 0)
    if not s or not h: print(f"{label}: incomplete (stock n={ns}, h30 n={nh})"); continue
    print(f"\n{label}   stock n={ns}, +H30 n={nh}")
    for name, i in (("instructions", 0), ("cycles", 1), ("CPU in SimFrame", 2)):
        sv, ss = s[i]; hv, hs = h[i]
        unit = (lambda v: f"{v/1e9:8.1f}e9") if i < 2 else (lambda v: f"{v/1000:8.1f}s ")
        print(f"  {name:16s} {unit(sv)} -> {unit(hv)}  {(hv-sv)/sv*100:+6.1f}%"
              f"   (run-to-run spread: stock {ss:.1f}%, +H30 {hs:.1f}%)")
