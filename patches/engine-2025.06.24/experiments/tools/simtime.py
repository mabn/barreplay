import sys, re
# precise sim wall = t(game over) - t(first [barreplay] line) from infolog microsecond stamps
def ts(line):
    m = re.match(r'\[t=(\d+):(\d+):(\d+)\.(\d+)\]', line)
    if not m: return None
    h,mi,s,us = m.groups()
    return int(h)*3600 + int(mi)*60 + int(s) + int(us)/1e6
t0=t1=None
for ln in open(sys.argv[1], errors='ignore'):
    if t0 is None and '[barreplay]' in ln:
        t0 = ts(ln)
    if 'game over' in ln:
        t1 = ts(ln)
if t0 is None or t1 is None:
    print("NA"); sys.exit(1)
print(f"{t1-t0:.3f}")
