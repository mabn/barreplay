#!/usr/bin/env python3
"""How many of BAR's COB functions are free of global effects (P4's
CobFunctionHarmless, rts/Sim/Weapons/BrPipeTarget.cpp): the same rules on
the same bytecode, over every .cob in a game checkout.

    python3 -I cobpurity.py <dir with .cob files>
"""
import os, re, struct, sys, collections

OPS = {
 0x10001000:('MOVE',2), 0x10002000:('TURN',2), 0x10003000:('SPIN',2), 0x10004000:('STOP_SPIN',2),
 0x10005000:('SHOW',1), 0x10006000:('HIDE',1), 0x10007000:('CACHE',1), 0x10008000:('DONT_CACHE',1),
 0x1000B000:('MOVE_NOW',2), 0x1000C000:('TURN_NOW',2), 0x1000D000:('SHADE',1), 0x1000E000:('DONT_SHADE',1),
 0x1000F000:('EMIT_SFX',1), 0x100A0000:('SCALE',1), 0x100A1000:('SCALE_NOW',1),
 0x10011000:('WAIT_TURN',2), 0x10012000:('WAIT_MOVE',2), 0x100A2000:('WAIT_SCALE',1), 0x10013000:('SLEEP',0),
 0x10021001:('PUSH_CONSTANT',1), 0x10021002:('PUSH_LOCAL_VAR',1), 0x10021004:('PUSH_STATIC',1),
 0x10022000:('CREATE_LOCAL_VAR',0), 0x10023002:('POP_LOCAL_VAR',1), 0x10023004:('POP_STATIC',1), 0x10024000:('POP_STACK',0),
 0x10031000:('ADD',0), 0x10032000:('SUB',0), 0x10033000:('MUL',0), 0x10034000:('DIV',0), 0x10034001:('MOD',0),
 0x10035000:('BITWISE_AND',0), 0x10036000:('BITWISE_OR',0), 0x10037000:('BITWISE_XOR',0), 0x10038000:('BITWISE_NOT',0),
 0x10041000:('RAND',0), 0x10042000:('GET_UNIT_VALUE',0), 0x10043000:('GET',0),
 0x10051000:('SET_LESS',0), 0x10052000:('SET_LESS_OR_EQUAL',0), 0x10053000:('SET_GREATER',0), 0x10054000:('SET_GREATER_OR_EQUAL',0),
 0x10055000:('SET_EQUAL',0), 0x10056000:('SET_NOT_EQUAL',0), 0x10057000:('LOGICAL_AND',0), 0x10058000:('LOGICAL_OR',0),
 0x10059000:('LOGICAL_XOR',0), 0x1005A000:('LOGICAL_NOT',0),
 0x10061000:('START',2), 0x10062000:('CALL',2), 0x10062001:('REAL_CALL',2), 0x10062002:('LUA_CALL',2), 0x10062004:('BATCH_LUA',2),
 0x10064000:('JUMP',1), 0x10065000:('RETURN',0), 0x10066000:('JUMP_NOT_EQUAL',1), 0x10067000:('SIGNAL',0), 0x10068000:('SET_SIGNAL_MASK',0),
 0x10071000:('EXPLODE',1), 0x10072000:('PLAY_SOUND',1), 0x10082000:('SET',0), 0x10083000:('ATTACH',0), 0x10084000:('DROP',0),
 0x10090000:('SIGNATURE_LUA',0),
}
HARMLESS, PIECES, HARMFUL = 1, 2, 3
PIECE_OPS = {'MOVE_NOW','TURN_NOW','SCALE_NOW','SHOW','HIDE'}
BAD_OPS = {'EMIT_SFX','GET_UNIT_VALUE','GET','LUA_CALL','BATCH_LUA','EXPLODE','SET','ATTACH','DROP','SIGNATURE_LUA'}

def parse(path):
    b = open(path,'rb').read()
    h = struct.unpack_from('<13i', b, 0)
    nscripts, totlen, codeoff = h[1], h[3], h[9]
    code = list(struct.unpack_from('<%di' % totlen, b, codeoff))
    offs = list(struct.unpack_from('<%di' % nscripts, b, h[6]))
    nameoffs = struct.unpack_from('<%di' % nscripts, b, h[7])
    names = [b[o:b.index(b'\0', o)].decode('latin1') for o in nameoffs]
    so = sorted(range(nscripts), key=lambda i: offs[i])
    lens = [0]*nscripts
    for k, i in enumerate(so):
        nxt = offs[so[k+1]] if k+1 < len(so) else totlen
        lens[i] = nxt - offs[i]
    return code, offs, lens, names

def analyze(code, offs, lens, names, fn, memo, why):
    if fn < 0 or fn >= len(names): return HARMFUL
    m = memo.get(fn)
    if m == 'visiting': why[fn] = 'recursion'; return HARMFUL
    if m is not None: return m
    memo[fn] = 'visiting'
    res = HARMLESS; pc = offs[fn]; end = pc + lens[fn]
    while pc < end and res != HARMFUL:
        op = code[pc]; pc += 1
        if op not in OPS: res = HARMFUL; why[fn] = 'unknown 0x%x' % op; break
        name, n = OPS[op]
        if name in ('CALL','REAL_CALL'):
            callee = code[pc]
            if names[callee].startswith('lua_'): res = HARMFUL; why[fn] = 'calls ' + names[callee]
            else:
                r = analyze(code, offs, lens, names, callee, memo, why)
                if r == HARMFUL: why[fn] = 'calls ' + names[callee] + ' (' + why.get(callee,'?') + ')'
                res = max(res, r)
        elif name in BAD_OPS: res = HARMFUL; why[fn] = name
        elif name in PIECE_OPS: res = max(res, PIECES)
        pc += n
    memo[fn] = res
    return res

def main():
    d = sys.argv[1]
    tally = collections.Counter(); whys = collections.Counter(); files = 0
    for root, _, fs in os.walk(d):
        for f in fs:
            if not f.lower().endswith('.cob'): continue
            files += 1
            code, offs, lens, names = parse(os.path.join(root, f))
            memo, why = {}, {}
            for i, nm in enumerate(names):
                key = re.sub(r'\d+$', 'N', nm)
                if key not in ('QueryWeaponN','AimFromWeaponN','QueryPrimary','QuerySecondary','QueryTertiary','AimFromPrimary','AimFromSecondary','AimFromTertiary','Activate','Deactivate','QueryNanoPiece','QueryBuildInfo','StartBuilding','StopBuilding','SetMaxReloadTime','SetSpeed','SetDirection'):
                    continue
                r = analyze(code, offs, lens, names, i, memo, why)
                tally[(key, r)] += 1
                if r == HARMFUL: whys[(key, why.get(i, '?'))] += 1
    print(files, 'cob files')
    keys = sorted({k for k, _ in tally})
    print('function | harmless | piece writes now | harmful')
    for k in keys:
        print(f"{k} | {tally[(k,HARMLESS)]} | {tally[(k,PIECES)]} | {tally[(k,HARMFUL)]}")
    print('\nwhy harmful (top):')
    for (k, w), v in whys.most_common(25): print(f"  {v:4d}  {k}: {w}")

if __name__ == '__main__':
    main()
