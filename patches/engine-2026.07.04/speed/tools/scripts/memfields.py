#!/usr/bin/env python3
"""memfields.py <perf.data> <binary> <pahole dir> [top]
Load-latency samples (perf mem / cpu/mem-loads,ldlat=N/P with -d) mapped to
the object pools they hit, and inside the unit and weapon pools to the class
FIELD at that offset (pahole layouts), weighted by sampled latency."""
import collections, re, subprocess, sys

data, binary, padir = sys.argv[1], sys.argv[2], sys.argv[3]
top = int(sys.argv[4]) if len(sys.argv) > 4 else 40

# pool symbols (file offsets in the PIE) and page sizes
syms = {}
for line in subprocess.run(["nm", "-S", "-C", binary], capture_output=True, text=True).stdout.splitlines():
    p = line.split()
    if len(p) >= 4 and p[3] in ("unitMemPool", "weaponMemPool", "projMemPool", "featureMemPool"):
        syms[p[3]] = (int(p[0], 16), int(p[1], 16))
PAGE = {"unitMemPool": 4496, "weaponMemPool": 768, "projMemPool": None, "featureMemPool": None}

def ptype_classes(path):
    """{class: [(offset, size, name, type)]} of each class's own top-level members (gdb ptype /o)"""
    out, cur = {}, None
    for line in open(path):
        m = re.search(r"type = class (\w+)", line)
        if m:
            cur = m.group(1); out[cur] = []; continue
        m = re.match(r"/\*\s+(\d+)(?::\s*\d+)?\s+\|\s+(\d+)\s+\*/(\s+)(.*)$", line)
        if m and cur and len(m.group(3)) == 4:
            text = m.group(4).strip()
            if text.endswith("{"):
                name = text.rstrip("{ ").split()[-1]          # nested type: its type name
            else:
                name = text.rstrip(";").split()[-1].lstrip("*&")
            out[cur].append((int(m.group(1)), int(m.group(2)), name, text))
    return out

C = ptype_classes(f"{padir}/ptype2.txt")
BUF = {"usMemBuffer": ("CObject", "CUnitScript", "CCobInstance"), "amtMemBuffer": ("CObject", "AMoveType", "AAirMoveType", "CStrafeAirMoveType", "CGroundMoveType"),
       "caiMemBuffer": ("CObject", "CCommandAI", "CMobileCAI")}

def lookup(classes, off):
    best = None
    for c in classes:
        for o, sz, n, t in C.get(c, []):
            if o <= off < o + max(sz, 1):
                best = (o, n, t)
    return best

def unitField(off):
    f = lookup(("CObject", "CWorldObject", "CSolidObject", "CUnit", "CBuilder"), off)
    if f and f[1].startswith(tuple(BUF)):
        buf = f[1].split("[")[0]
        inner = off - f[0]
        g = lookup(BUF[buf], inner)
        return f"{buf}+{inner} " + (g[1] if g else ("vptr" if inner < 8 else "?"))
    return f[1] if f else ("vptr" if off < 8 else "?")

def weaponField(off):
    f = lookup(("CObject", "CWeapon"), off)
    return f[1] if f else ("vptr" if off < 8 else "?")

# perf script: weight + data address + the mapping of the binary (to undo PIE)
res = subprocess.run(["perf", "script", "-i", data, "-F", "tid,weight,addr,sym", "--show-mmap-events"],
                     capture_output=True, text=True).stdout.splitlines()
base = None
tot = collections.Counter(); by = collections.Counter(); fld = collections.Counter(); fun = collections.Counter()
mainTid = None
for line in res:
    if "PERF_RECORD_MMAP" in line and binary.split("/")[-1] in line and base is None:
        m = re.search(r"\[(0x[0-9a-f]+)\((0x[0-9a-f]+)\) @ (0x[0-9a-f]+|0)", line)
        if m:
            base = int(m.group(1), 16) - int(m.group(3), 16)
        continue
    p = line.split()
    if len(p) < 3 or not p[0].isdigit():
        continue
    tid, w, addr = int(p[0]), int(p[1]), int(p[2], 16)
    sym = " ".join(p[3:])
    if mainTid is None:
        mainTid = tid
    key = "main" if tid == mainTid else "workers"
    tot[key] += w
    where = "other"
    if base is not None:
        for name, (a, size) in syms.items():
            if base + a <= addr < base + a + size:
                where = name
                off = addr - base - a
                pg = PAGE.get(name)
                if pg:
                    o = off % pg
                    lab = f"{name} +{o:4d} " + (unitField(o) if name == "unitMemPool" else weaponField(o))
                    fld[(key, lab)] += w
                break
    by[(key, where)] += w
    fun[(key, where, sym[:60])] += w

for k in ("main", "workers"):
    if not tot[k]:
        continue
    print(f"== {k}: total latency {tot[k]}")
    for (kk, w), v in sorted(by.items(), key=lambda x: -x[1]):
        if kk == k:
            print(f"  {100*v/tot[k]:5.1f}%  {w}")
    print(f"  -- top fields")
    for (kk, lab), v in sorted(fld.items(), key=lambda x: -x[1])[:top]:
        if kk == k:
            print(f"  {100*v/tot[k]:5.2f}%  {lab}")
    print(f"  -- top functions x pool")
    for (kk, w, s), v in sorted(fun.items(), key=lambda x: -x[1])[:top]:
        if kk == k:
            print(f"  {100*v/tot[k]:5.2f}%  {w:14s} {s}")
