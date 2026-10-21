#!/usr/bin/env python3
"""absum.py <abt or trial output>...: per setting, the trials' wall/cycles/instructions,
their means, and the change of each setting against the first one."""
import sys, re, collections
for f in sys.argv[1:]:
    rows = collections.OrderedDict()
    for line in open(f):
        m = re.search(r'(?:t=(\S+)|^(\S+) t=(\S+))', line)
        b = re.search(r'cycles=(\d+) instructions=(\d+) thread_cpu_ms=([\d.]+) wall_ms=([\d.]+)', line)
        if not b: continue
        key = re.search(r'^pair \d+ t=(\S+)', line)
        if key: k = key.group(1)
        else:
            parts = line.split()
            k = parts[0] + ' ' + parts[1] + (' ' + parts[2] if parts[2].startswith('t2=') else '')
        rows.setdefault(k, []).append(tuple(float(x) for x in b.groups()))
    print(f'== {f}')
    base = None
    for k, v in rows.items():
        n = len(v)
        cyc = sum(x[0] for x in v) / n; ins = sum(x[1] for x in v) / n; wall = sum(x[3] for x in v) / n
        walls = ' / '.join(f'{x[3]/1000:.2f}' for x in v)
        if base is None: base = (wall, cyc, ins); d = ''
        else: d = f'  wall {100*(wall/base[0]-1):+.1f}%  cycles {100*(cyc/base[1]-1):+.1f}%  instr {100*(ins/base[2]-1):+.1f}%'
        print(f'  {k:40s} n={n} wall {walls} s (mean {wall/1000:.2f})  cycles {cyc/1e9:.2f}e9  instr {ins/1e9:.2f}e9  GHz {cyc/ (sum(x[2] for x in v)/n) /1e6:.2f}{d}')
