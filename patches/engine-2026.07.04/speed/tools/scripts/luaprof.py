#!/usr/bin/env python3
"""luaprof.py <result.luaprof> [binary] — the Lua sampler's folded stacks as a
table of % of the MAIN core: by owner (the innermost gadget/widget file on the
stack, handler plumbing skipped), with the C function (Spring.*) it was in."""
import sys, re, collections, subprocess
f = sys.argv[1]; binary = sys.argv[2] if len(sys.argv) > 2 else None
hdr = open(f).readline()
m = dict(kv.split('=') for kv in hdr[1:].split())
inl, out = int(m['samples']), int(m['outside']); tot = inl + out
HANDLERS = ('LuaRules/gadgets.lua', 'LuaUI/barwidgets.lua', 'luaui/Include/widget_profiling.lua',
            'LuaGadgets/actions.lua', 'LuaUI/actions.lua', 'luarules/gadgets/include/')
syms = []
if binary:
    base = int(m['luaV_execute'], 16)
    nm = subprocess.run(['nm', '-C', binary], capture_output=True, text=True).stdout.splitlines()
    tab = []
    for l in nm:
        p = l.split(' ', 2)
        if len(p) == 3 and p[0] and p[1] in 'tTwW': tab.append((int(p[0], 16), p[2]))
    tab.sort()
    lv = [a for a, n in tab if n == 'luaV_execute(lua_State*, int)'][0]
    import bisect
    addrs = [a for a, _ in tab]
    def csym(h):
        a = int(h, 16) - base + lv
        i = bisect.bisect_right(addrs, a) - 1
        return tab[i][1].split('(')[0] if i >= 0 else h
else:
    csym = lambda h: h
def state(src):
    s = src.lower()
    if s.startswith('luaui') or 'widget' in s: return 'LuaUI (widgets)'
    if s.startswith('luarules') or s.startswith('luagadgets'): return 'LuaRules (gadgets)'
    return 'other'
own = collections.Counter(); ownC = collections.defaultdict(collections.Counter); st = collections.Counter()
recs = []; buf = ''
for line in open(f):
    if line.startswith('# luaV_execute='): continue
    buf += line.rstrip('\n')
    if re.search(r' \d+$', buf): recs.append(buf); buf = ''
    else: buf += ' '
for rec in recs:
    stack, n = rec.rsplit(' ', 1); n = int(n)
    fr = stack.split(';')
    lua = [x for x in fr if not x.startswith('C:') and x != '(truncated)']
    o = None
    for x in reversed(lua):
        src = x.rsplit(':', 1)[0]
        if not src.startswith(HANDLERS) and '/' in src: o = src; break
    if o is None: o = (lua[-1].rsplit(':', 1)[0] if lua else '?') + ' (handler)'
    if not ('/' in o): o = '(chunk loaded from a string)'
    own[o] += n; st[state(o)] += n
    leafC = fr[-1]
    ownC[o][csym(leafC[2:]) if leafC.startswith('C:') else '(Lua code)'] += n
print(f'main-core samples {tot}: in Lua {inl} ({inl/tot:.1%}), outside {out}')
print(f'{"% core":>7}  by Lua state'); [print(f'{v/tot:7.2%}  {k}') for k, v in st.most_common()]
print(f'{"% core":>7}  by owner  [top C functions it was in]')
for k, v in own.most_common(int(sys.argv[3]) if len(sys.argv) > 3 else 30):
    cs = ', '.join(f'{c} {w/tot:.2%}' for c, w in ownC[k].most_common(3))
    print(f'{v/tot:7.2%}  {k}  [{cs}]')
