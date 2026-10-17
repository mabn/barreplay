#!/usr/bin/env python3
"""hotlines.py <binary> <chains.txt> <frame-substring> [N] — source lines of the
leaf samples whose call chain contains <frame-substring>, as % of the main core."""
import sys,subprocess,collections,re
B, F, needle = sys.argv[1], sys.argv[2], sys.argv[3]; N = int(sys.argv[4]) if len(sys.argv) > 4 else 30
start={}
for l in subprocess.run(['nm','-C',B],capture_output=True,text=True).stdout.splitlines():
    p=l.split(' ',2)
    if len(p)==3 and p[0] and p[1] in 'tTwW': start.setdefault(p[2],int(p[0],16))
samples=[]; cur=None
for line in open(F):
    if not line.strip():
        if cur: samples.append(cur)
        cur=None; continue
    if cur is None: cur={'p':int(line.split()[0]),'fr':[]}
    else: cur['fr'].append(line.strip())
if cur: samples.append(cur)
tot=sum(s['p'] for s in samples); sub=0
per=collections.Counter()
rx=re.compile(r'^[0-9a-f]+\s+(.*)\+0x([0-9a-f]+)\s+\((.*)\)$')
for s in samples:
    if not any(needle in f for f in s['fr']): continue
    sub+=s['p']
    m=rx.match(s['fr'][0]) if s['fr'] else None
    if not m: continue
    sym=m.group(1).strip()
    if sym in start: per[start[sym]+int(m.group(2),16)]+=s['p']
print(f'{needle}: {sub/tot:.1%} of the main core')
addrs=sorted(per)
out=subprocess.run(['addr2line','-a','-i','-f','-C','-e',B]+[hex(a) for a in addrs],capture_output=True,text=True).stdout.split('\n')
blocks={};c=None
for line in out:
    if line.startswith('0x'): c=int(line,16); blocks[c]=[]
    elif c is not None and line: blocks[c].append(line)
lines=collections.Counter()
for a,b in blocks.items():
    f=b[0].split('(')[0]; loc=b[1].replace('/build/src/rts/','') if len(b)>1 else '?'
    lines[f'{loc}  {f}']+=per[a]
for k,v in lines.most_common(N): print(f'{v/tot:6.2%} {k[:120]}')
