#!/usr/bin/env python3
"""P5's static rule for COB functions (rts/Sim/Units/Scripts/BrCobPar.cpp): a
thread tick may run on a worker when every function it can be executing (the
call stack, and what those call) uses only own-unit operations, and every
unit-value read is a constant id on the read-only list.

    python3 -I p5safe.py <dir with .cob files> [script:function ...]

With no functions: totals per function name over all scripts. With
script:function pairs (as the measurement build prints them): each one's
verdict and the first unsafe operation found.
"""
import os, re, struct, sys, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cobpurity import OPS, parse

# operations a worker may run: own script state, own pieces and anims,
# scheduling (deferred), reads (GET with a listed id)
SAFE = {'PUSH_CONSTANT','PUSH_LOCAL_VAR','PUSH_STATIC','CREATE_LOCAL_VAR','POP_LOCAL_VAR','POP_STATIC','POP_STACK',
        'ADD','SUB','MUL','DIV','MOD','BITWISE_AND','BITWISE_OR','BITWISE_XOR','BITWISE_NOT',
        'SET_LESS','SET_LESS_OR_EQUAL','SET_GREATER','SET_GREATER_OR_EQUAL','SET_EQUAL','SET_NOT_EQUAL',
        'LOGICAL_AND','LOGICAL_OR','LOGICAL_XOR','LOGICAL_NOT','JUMP','JUMP_NOT_EQUAL','RETURN',
        'SLEEP','WAIT_TURN','WAIT_MOVE','WAIT_SCALE','TURN','MOVE','SPIN','STOP_SPIN','SCALE',
        'TURN_NOW','MOVE_NOW','SCALE_NOW','HIDE','SIGNAL','SET_SIGNAL_MASK','CACHE','DONT_CACHE','SHADE','DONT_SHADE',
        # serial points: the tick waits for every earlier tick, then does it in place
        'START','RAND'}
# SetUnitVal ids that write only the unit's own flags nothing else reads during the tick
SET_IDS = {5, 6}
# GetUnitVal ids that only read (UnitScript.cpp): no logging, no writes
READ_IDS = set(range(1, 19)) | {20, 28, 29, 32, 34, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 82, 83, 84,
            85, 86, 87, 88, 89, 90, 91, 93, 94, 95, 96, 97, 100, 131, 132, 133, 134, 135, 136} | set(range(110, 120))
# (pops, pushes) for the backward search of a GET's id
EFFECT = {'PUSH_CONSTANT':(0,1),'PUSH_LOCAL_VAR':(0,1),'PUSH_STATIC':(0,1),'POP_LOCAL_VAR':(1,0),'POP_STATIC':(1,0),'POP_STACK':(1,0),
          'ADD':(2,1),'SUB':(2,1),'MUL':(2,1),'DIV':(2,1),'MOD':(2,1),'BITWISE_AND':(2,1),'BITWISE_OR':(2,1),'BITWISE_XOR':(2,1),
          'BITWISE_NOT':(1,1),'SET_LESS':(2,1),'SET_LESS_OR_EQUAL':(2,1),'SET_GREATER':(2,1),'SET_GREATER_OR_EQUAL':(2,1),
          'SET_EQUAL':(2,1),'SET_NOT_EQUAL':(2,1),'LOGICAL_AND':(2,1),'LOGICAL_OR':(2,1),'LOGICAL_XOR':(2,1),'LOGICAL_NOT':(1,1),
          'GET_UNIT_VALUE':(1,1),'GET':(5,1),'RAND':(2,1)}

def decode(code, beg, end):
    ins = []; pc = beg
    while pc < end:
        op = code[pc]; name, n = OPS.get(op, ('?', 0))
        ins.append((pc, name, code[pc+1:pc+1+n])); pc += 1 + n
    return ins

def get_id(ins, j, targets, depth):
    """The constant pushed for the value <depth> deep under instruction j's pops, or None."""
    need = depth
    for i in range(j - 1, -1, -1):
        pc, name, opnds = ins[i]
        if ins[i + 1][0] in targets: return None
        if name not in EFFECT: return None
        pops, pushes = EFFECT[name]
        if pushes >= need:
            return opnds[0] if (name == 'PUSH_CONSTANT' and pushes == 1) else None
        need = need - pushes + pops
    return None

def analyze(code, offs, lens, names, fn, memo, why):
    if fn in memo:
        return memo[fn] if memo[fn] != 'visiting' else False
    memo[fn] = 'visiting'
    ins = decode(code, offs[fn], offs[fn] + lens[fn])
    targets = {o[0] for _, nm, o in ins if nm in ('JUMP', 'JUMP_NOT_EQUAL')}
    ok = True
    for j, (pc, name, opnds) in enumerate(ins):
        if name in ('CALL', 'REAL_CALL'):
            c = opnds[0]
            if names[c].startswith('lua_') or not analyze(code, offs, lens, names, c, memo, why):
                ok = False; why[fn] = 'calls ' + names[c] + ('' if names[c].startswith('lua_') else ' (' + why.get(c, '?') + ')'); break
        elif name == 'SET':
            v = get_id(ins, j, targets, 2)
            if v is None or v not in SET_IDS:
                ok = False; why[fn] = 'SET id %s' % v; break
        elif name in ('GET', 'GET_UNIT_VALUE'):
            v = get_id(ins, j, targets, 5 if name == 'GET' else 1)
            if v is None or v not in READ_IDS:
                ok = False; why[fn] = '%s id %s' % (name, v); break
        elif name not in SAFE:
            ok = False; why[fn] = name; break
    memo[fn] = ok
    return ok

def main():
    d = sys.argv[1]; want = sys.argv[2:]
    files = {}
    for root, _, fs in os.walk(d):
        for f in fs:
            if f.lower().endswith('.cob'): files[f.lower()[:-4]] = os.path.join(root, f)
    if want:
        for w in want:
            s, fn = w.split(':', 1)
            p = files.get(s.lower().split('/')[-1].replace('.cob', ''))
            if not p: print(w, 'no such script'); continue
            code, offs, lens, names = parse(p); memo, why = {}, {}
            if fn not in names: print(w, 'no such function'); continue
            i = names.index(fn); ok = analyze(code, offs, lens, names, i, memo, why)
            print(f"{w}: {'parallel' if ok else 'serial: ' + why.get(i, '?')}")
        return
    tally = collections.Counter(); reasons = collections.Counter()
    for p in files.values():
        code, offs, lens, names = parse(p); memo, why = {}, {}
        for i, nm in enumerate(names):
            ok = analyze(code, offs, lens, names, i, memo, why)
            tally[ok] += 1
            if not ok: reasons[re.sub(r' \(.*', '', why.get(i, '?'))] += 1
    print('functions: parallel %d, serial %d' % (tally[True], tally[False]))
    for r, v in reasons.most_common(15): print(f'  {v:5d}  {r}')

main()
