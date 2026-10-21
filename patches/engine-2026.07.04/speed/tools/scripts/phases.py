import sys,collections
rules=[ # checked in order; a rule matches if ANY frame contains the pattern
 ('CUnitHandler::Update','units'),
 ('CUnitScriptEngine::Tick','unit-script anims (TickAllAnims, parallel section)'),
 ('CCobEngine::Tick','COB scripts'),
 ('CLosHandler::Update','LOS update (parallel section)'),
 ('CProjectileHandler::','projectiles + collisions'),
 ('QTPFS::','pathfinding (QTPFS)'),
 ('CBasicMapDamage::','map damage / terrain'),
 ('CFeatureHandler::','features'),
 ('CEventHandler::CollectGarbage','Lua GC'),
 ('CGame::Draw','draw + unsynced (headless)'),('CGame::UpdateUnsynced','draw + unsynced (headless)'),('CWorldDrawer','draw + unsynced (headless)'),
 ('CLuaHandle::','Lua callins (gadgets), not from units'),('IterateEventClientList','Lua callins (gadgets), not from units'),
 ('luaV_execute','Lua callins (gadgets), not from units'),('luaD_precall','Lua callins (gadgets), not from units'),('lua_','Lua callins (gadgets), not from units'),
 ('CUnit::','other unit events (kills, damage, explosions)'),('CGameHelper::','other unit events (kills, damage, explosions)'),('CWeapon','other unit events (kills, damage, explosions)'),
 ('CGame::SimFrame','SimFrame, other'),
 ('CGame::ClientReadNet','net/demo read (outside SimFrame)'),
]
isl=lambda f: f.startswith(('lua','CLuaHandle','CSyncedLuaHandle','CLuaRules','CLuaUnitScript'))
sub=collections.Counter(); subl=collections.Counter(); ph=collections.Counter(); phl=collections.Counter(); tot=0; unk=collections.Counter()
for l in open(sys.argv[1]):
    st,n=l.rsplit(' ',1); n=int(n); tot+=n
    fr=st.split(';'); haslua=any(isl(f) for f in fr)
    p='other (stack too short to place)'
    if any('BrParAir::' in f or 'GeneralMoveSystem::' in f for f in fr): p='units'
    else:
      for pat,name in rules:
        if any(pat in f for f in fr): p=name; break
    if p.startswith('other ('): unk[';'.join(x[:40] for x in fr[1:4])]+=n
    ph[p]+=n; phl[p]+=n*haslua
    if p=='units' and any('BrParAir::' in f or 'GeneralMoveSystem::' in f for f in fr):
        c='aircraft / general move-type loop (P1 when on)'; sub[c]+=n; subl[c]+=n*haslua
    elif p=='units':
        i=[j for j,f in enumerate(fr) if 'CUnitHandler::Update' in f][0]
        c=fr[i+1].split('(')[0][:60] if i+1<len(fr) else '(self: LTO-inlined unit/weapon code)'
        if 'WaitForFinished' in c: c='UpdateUnitWeapons for_mt (weapon vectors, parallel section)'
        if 'CStrafeAirMoveType' in c or 'CHoverAirMoveType' in c: c='aircraft / general move-type loop (P1 when on)'
        sub[c]+=n; subl[c]+=n*haslua
print(f'{"share":>6} {"of it Lua":>9}  phase')
for k,v in ph.most_common(): print(f'{v/tot:6.1%} {phl[k]/tot:9.1%}  {k}')
print('--- units, by callee:')
for k,v in sub.most_common(18): print(f'   {v/tot:6.1%} {subl[k]/tot:6.1%}  {k}')
print('unplaced:'); [print(f'   {v/tot:6.1%} {k}') for k,v in unk.most_common(6)]
