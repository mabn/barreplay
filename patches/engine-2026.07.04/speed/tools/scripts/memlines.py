#!/usr/bin/env python3
"""memlines.py <perf.data> <binary> <pahole dir> [top]: main-thread load-latency
samples in the unit pool, by function and by 64-byte line of the unit object,
with the fields in each line: which loops read which lines together."""
import collections, re, subprocess, sys, importlib.util
data, binary, padir = sys.argv[1], sys.argv[2], sys.argv[3]
top = int(sys.argv[4]) if len(sys.argv) > 4 else 25
spec = importlib.util.spec_from_file_location("mf", "/home/mabn/dev/perf3/memfields.py")
# reuse the class layouts and field lookup without running memfields' main part
src = open("/home/mabn/dev/perf3/memfields.py").read().split("# perf script:")[0]
g = {"__name__": "mf", "sys": sys}
sys_argv = sys.argv; sys.argv = [sys.argv[0], data, binary, padir]
exec(compile(src, "memfields.py", "exec"), g)
sys.argv = sys_argv
syms, PAGE, unitField = g["syms"], g["PAGE"], g["unitField"]
ua, usz = syms["unitMemPool"]; pg = PAGE["unitMemPool"]
res = subprocess.run(["perf", "script", "-i", data, "-F", "tid,addr,weight,sym", "--show-mmap-events"], capture_output=True, text=True).stdout.splitlines()
base = None; mainTid = None
fl = collections.Counter(); fn = collections.Counter(); lf = collections.defaultdict(collections.Counter); tot = 0
for line in res:
    if "PERF_RECORD_MMAP" in line and binary.split("/")[-1] in line and base is None:
        m = re.search(r"\[(0x[0-9a-f]+)\((0x[0-9a-f]+)\) @ (0x[0-9a-f]+|0)", line)
        if m: base = int(m.group(1), 16) - int(m.group(3), 16)
        continue
    if "PERF_RECORD" in line: continue
    p = line.split(None, 3)
    if len(p) < 3 or not p[0].isdigit(): continue
    tid, addr, w = int(p[0]), int(p[1], 16), int(p[2]); sym = (p[3] if len(p) > 3 else "").split("(")[0].split("<")[0].strip()[:48]
    if mainTid is None: mainTid = tid
    if tid != mainTid or base is None: continue
    tot += w
    if not (base + ua <= addr < base + ua + usz): continue
    o = (addr - base - ua) % pg
    ln = o // 64
    fl[(sym, ln)] += w; fn[sym] += w; lf[ln][unitField(o)] += w
print(f"main-thread latency in the unit pool: {100*sum(fn.values())/tot:.1f}% of all its sampled latency")
for f, v in fn.most_common(top):
    lines = sorted(((ln, x) for (s, ln), x in fl.items() if s == f), key=lambda t: -t[1])[:8]
    print(f"{100*v/tot:5.2f}% {f:48s} lines: " + " ".join(f"{ln}({100*x/v:.0f}%)" for ln, x in lines))
print("-- lines (byte offset), their fields")
lw = collections.Counter({ln: sum(c.values()) for ln, c in lf.items()})
for ln, v in lw.most_common(top):
    print(f"{100*v/tot:5.2f}% line {ln:3d} (+{ln*64:4d}): " + ", ".join(f"{k}" for k, _ in lf[ln].most_common(6)))
