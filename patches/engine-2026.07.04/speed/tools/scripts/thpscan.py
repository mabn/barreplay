# thpscan.py <pid>: for the mappings H71's collapser touches (rw-p anonymous or
# [heap], >= 16 MiB of whole 2 MiB ranges), count resident 4 KiB pages and the
# 2 MiB ranges holding at least one: what RSS would be if every such range
# collapsed into a huge page, against what it is.
import re, struct, sys
pid = sys.argv[1]
HP = 2 << 20
pm = open(f"/proc/{pid}/pagemap", "rb")
tot_res = tot_ranges = tot_full = 0
rows = []
for line in open(f"/proc/{pid}/maps"):
    p = line.split()
    a, b = (int(x, 16) for x in p[0].split("-"))
    perms, inode = p[1], int(p[4])
    path = p[5] if len(p) > 5 else ""
    if inode != 0 or perms != "rw-p" or (path and path != "[heap]"):
        continue
    beg = (a + HP - 1) & ~(HP - 1); end = b & ~(HP - 1)
    if end <= beg or end - beg < (16 << 20):
        continue
    res = ranges = full = 0
    for r in range(beg, end, HP):
        pm.seek((r >> 12) * 8)
        ents = struct.unpack("512Q", pm.read(512 * 8))
        n = sum(1 for e in ents if e >> 63)
        res += n
        if n:
            ranges += 1
            if n == 512: full += 1
    tot_res += res; tot_ranges += ranges; tot_full += full
    rows.append((ranges * 512 - res, b - a, res, ranges, full, path))
rows.sort(reverse=True)
mib = lambda pages: pages * 4096 / 2**20
print(f"collapsible mappings: resident {mib(tot_res):.0f} MiB in {tot_ranges} touched 2 MiB ranges "
      f"({tot_full} already full); if all collapsed: {tot_ranges*2} MiB, +{tot_ranges*2 - mib(tot_res):.0f} MiB")
for gap, size, res, ranges, full, path in rows[:12]:
    print(f"  map {size/2**20:8.0f} MiB  resident {mib(res):7.0f} MiB  touched {ranges*2:6d} MiB  gap +{mib(gap):6.0f} MiB {path}")
