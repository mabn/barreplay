# Recording projectiles and explosions

Design notes for capturing **long-range projectiles** (nukes, anti-nukes, EMP,
tactical nukes, long-range plasma cannons and their rapid-fire and "mini"
variants, Junos, rocket artillery), **heavy beam weapons** (Pulsar,
Bulwark, Titan, Juggernaut, …) and **explosions** (where, how big, what
they hit) during a re-simulation, for the post-game report.

Status: **design, nothing implemented.** Every API claim below was checked
against the engine source (`~/dev/recoil`, tag 2026.07.04) and BAR's game
checkout (`~/dev/bar-full`). The weapon numbers come from a real capture's
runtime weapon table. Source references are given so each claim can be
re-checked when either one moves on.

## Summary

- **No engine patch is needed.** A widget can do all of it.
- **Explosions are the easy half.** LuaUI may register its own explosion
  watch list (`Script.SetWatchExplosion`, `rts/Lua/LuaUI.cpp:149`). The
  engine then calls `Explosion(weaponDefID, x, y, z, ownerID, projectileID)`
  for every explosion of a watched weapon. In full view every explosion
  counts as visible. BAR's widget handler doesn't forward this callin, but
  our widget already has handler access and installs callins itself. It
  hooks `UnitDamaged` the same way today.
- **Projectile births are the harder half.** The engine's `ProjectileCreated`
  never reaches LuaUI. Instead, the widget notices that a tracked weapon has
  just fired, because its `reloadFrame` changes. It then finds the new
  projectile with `GetProjectilesInSphere` around the weapon's muzzle.
  That is one cheap call per tracked launcher per frame.
- **Which weapons to track is decided from `WeaponDefs` at runtime, never
  from unit names.** Mods add and change units: the lava replay used below
  carries "Mini Ragnarok" with 1620 range, where the unit file says 1300. A
  name list would miss what it doesn't know and record stale numbers.
- **"Explosion strength" is in the weapon def:** radius, falloff, blast-wave
  speed, damage per armour class, impulse and crater size. The
  capture's `wdefs` fact already records a few of these, and extending it
  needs no codec change.
- **Beams come through the same explosion callin.** A `BeamLaser` with a
  `beamtime` fires one beam per frame for the whole beam time. Each frame
  the engine creates a beam segment from the muzzle to the hit point, then
  calls `Explosion` at the hit point with that segment's id. So one
  Pulsar shot is 45 explosions, each carrying a 45th of the damage. The
  widget folds them into one beam record per firing (§4.7).
- **Damage actually dealt is already recorded.** Every `H` hit carries the
  weapon, and the engine hands the hit callin the projectile id. Linking a
  blast to its hits answers "what was in the blast".

## 1. What the engine delivers to a widget

### Callins

| Callin | Reaches a widget? | Notes |
|---|---|---|
| `Explosion(weaponDefID, px, py, pz, attackerID, projectileID)` | **Yes, with setup**: `Script.SetWatchExplosion(wdid, true)` from LuaUI, plus a handler-level install (§4.2) | Only watched weapon defs. Unsynced handles get it only when `IsExplosionVisible` holds, which is always true in full view (`ExplosionGenerator.cpp:395`). The return value means "no graphics", so return nothing. Piece-projectile collisions (weaponDefID < 0) never call it. |
| `ProjectileCreated` / `ProjectileDestroyed` | **No.** | Only handles with a projectile watch list get them, and only synced code can create one (`Script.SetWatchProjectile` is registered in `LuaHandleSynced.cpp:496`, not in LuaUI). |
| `StockpileChanged(unitID, unitDefID, team, weaponNum, oldCount, newCount)` | **Yes** (BAR forwards it) | Fires when a stockpile unit finishes building one round, and when it fires (`Weapon.cpp:500`, before the projectile exists). Gives the nuke-ready timeline. |
| `UnitDamaged(..., weaponDefID, projectileID, attackerID, ...)` | **Yes** (already hooked for `H`) | The projectileID links a hit to a tracked projectile or explosion. |
| `GameFramePost(frame)` | **Yes** | Runs after the frame's unit and projectile updates (`Game.cpp:1813`). `GameFrame` runs before them (`Game.cpp:1778`). Birth detection belongs in `GameFramePost`, so a shot fired in frame N is found in frame N. |
| `Barrelfire(px, py, pz, weaponID, ownerID)` | Yes, via BAR's `gfx_explosion_lights.lua` | One per launch of a `Cannon` weapon dealing at least 20 damage, or a `LaserCannon` dealing at least 10. No projectile id. A cross-check, not a source (§4.1). |
| `VisibleExplosion(px, py, pz, weaponID, ownerID)` | Yes, via the same gadget | Impacts of eight weapon types, **but only while the owner is alive** (`if ownerID ~= nil`), and with no projectile id. `Explosion` replaces it. |
| `ProjectileCreatedReloadHB(projectileID, ownerID, weaponID)` | Yes, via BAR's `unit_healthbars_widget_forwarding.lua` | Births only for each unit type's **single** longest-reload weapon, and only if that reload is over 5 s. Misses anti-nukes (2 s), Ragnarok/Calamity (0.6–0.75 s) and the minis (0.4 s). Can't be the main mechanism. |

### Read functions (`LuaSyncedRead`, callable from a widget)

All of them return nil for a projectile the caller may not see. In a
full-view re-sim that is none (`LuaUtils::IsProjectileVisible`, `LuaUtils.cpp:1927`).

| Function | Returns | Use |
|---|---|---|
| `GetAllProjectiles(exclWeapon?, exclPiece?)` | ids | Every synced projectile on the map. Thousands in a late game, so **not** for every frame. |
| `GetProjectilesInRectangle(x1, z1, x2, z2, …)` | ids | Area query. |
| `GetProjectilesInSphere(x, y, z, r, …)` | ids | **Birth detection**: around a muzzle, just after it fired. |
| `GetProjectileDefID(id)` | weaponDefID | Classify. |
| `GetProjectileOwnerID(id)` / `GetProjectileTeamID(id)` / `GetProjectileAllyTeamID(id)` | unit / team / ally team | Who fired. Team and ally team survive the owner's death. |
| `GetProjectilePosition(id)` | x, y, z | Launch point, path samples, "still alive?". |
| `GetProjectileVelocity(id)` | vx, vy, vz, speed | Elmos per frame. Launch velocity plus gravity gives the ballistic arc. |
| `GetProjectileGravity(id)` | g | Per-frame gravity for the arc (BAR artillery uses `myGravity`). |
| `GetProjectileDirection(id)` | dx, dy, dz | |
| `GetProjectileTarget(id)` | type, target | Type is `string.byte` of `'u'` (unit id), `'g'` (ground: `{x, y, z}`), `'f'` (feature) or `'p'` (**projectile**) (`LuaSyncedRead.cpp:7416`). An anti-nuke missile's target is `'p'` plus **the nuke's projectile id**, so the interception is linked exactly. |
| `GetProjectileIsIntercepted(id)` | bool | Set once an interceptor has engaged this projectile (`WeaponProjectile.cpp:129`): "an anti-nuke tried". |
| `GetProjectileTimeToLive(id)` | frames | Missiles and starburst rockets self-destruct when it runs out. |
| `GetProjectileDamages(id, tag)` | number | The projectile's own damage (a gadget may have changed it). |
| `GetProjectileType(id)` | isWeapon, isPiece | Filter out flying debris. |

Per-unit functions for launchers:

| Function | Use |
|---|---|
| `GetUnitWeaponState(u, w, "reloadFrame")` | The frame the weapon is next ready. **It changes exactly when the weapon fires** (`Weapon.cpp:502`): the birth trigger. Other useful states: `salvoLeft`, `nextSalvo`, `projectiles`, `range`, `projectileSpeed`, `reloadTime`. |
| `GetUnitWeaponVectors(u, w)` | Muzzle position and direction: where to look for the new projectile. |
| `GetUnitWeaponTarget(u, w)` | What the weapon is aiming at, including type 3 = a projectile for interceptors. |
| `GetUnitStockpile(u)` | Rounds in stock, rounds queued, build progress: nuke readiness. |

### Unit and weapon definitions (the `UnitDefs` / `WeaponDefs` tables in LuaUI)

- `UnitDefs[id].weapons`: the unit's weapon slots (`weaponDef` per slot).
  This maps a launcher's slot numbers to tracked weapon defs.
- `UnitDefs[id].deathExplosion` / `.selfDExplosion` are weapon-def **names**.
  `WeaponDefNames[name].id` resolves them. The capture already records both as
  ids (DEF `deathWeapon` / `selfdWeapon`).
- `UnitDefs[id].stockpileWeaponDef`: the stockpiled weapon's id.
- `Game.armorTypes`: armour-class names mapped both ways to the indices of
  `WeaponDefs[i].damages`.

## 2. What "explosion strength" is made of

All of it comes from the weapon def (`rts/Lua/LuaWeaponDefs.cpp`), read once at
startup. These are the fields worth recording:

| Field | Meaning |
|---|---|
| `damages[i]` | Damage to armour class `i` (`Game.armorTypes`); `damages[0]` is the default class. AA weapons deal about 1 to ground classes, which is how they are told apart. |
| `damageAreaOfEffect` | Blast **radius** in elmos. Note: the unit files' `areaofeffect` is a **diameter**, and the engine halves it. armsilo's file says 1280; the runtime says 640. |
| `edgeEffectiveness` | Damage falloff toward the rim. |
| `explosionSpeed` | How fast the blast wave expands. Units far from the centre take their damage **frames later**. |
| `damages.impulseFactor` / `impulseBoost` | Knockback. |
| `craterAreaOfEffect`, `damages.craterMult` / `craterBoost` | Terrain deformation. |
| `damages.paralyzeDamageTime`, `paralyzer` | EMP: seconds of stun per paralyze damage. |
| `interceptor`, `targetable`, `coverageRange`, `interceptSolo` | Anti-nuke pairing. Interceptor and targetable are bitmasks that must overlap. **`coverageRange` is the protected radius**, so "the target was inside the Citadel's umbrella" is answerable. |
| `stockpile`, `stockpileTime` | Built rounds, and the seconds to build one. |
| `range`, `reload`, `salvoSize`, `salvoDelay`, `projectiles` | Reach and rate of fire. A Starfall `starfire` salvo is 63 shells. |
| `projectilespeed`, `myGravity`, `highTrajectory`, `flightTime`, `weaponAcceleration`, `turnRate`, `trajectoryHeight` | Flight shape, for drawing arcs. |
| `type` | `Cannon`, `MissileLauncher`, `StarburstLauncher`, `AircraftBomb`, … |
| `customParams` | BAR's own semantics (below). |

The engine's damage at distance `d` from a unit's collision-volume surface, for
radius `R` and edge effectiveness `e` (`rts/Game/GameHelper.cpp:131-170`):

```
mod    = 1                              if e == 1 or d < 1
       = (R − d) / (R − d·e)            otherwise   (0 at d = R; e→1 flattens it)
damage = damages[armorClass(unit)] · mod
delay  = d / explosionSpeed frames      (when d is beyond the immediate-damage distance)
```

**BAR customParams that change what a weapon does**, seen on the target units:

| customParam | Meaning | Where |
|---|---|---|
| `nuclear=1` | A nuke-class warhead | armsilo, corsilo, legsilo, **cortron** (tactical) |
| `stockpilelimit=N` | Stock cap | nukes 10, anti-nukes and Junos 20, EMP and tactical 10 |
| `junotype=base`, `nofire=true` | Juno. The pulse deals 1 damage. Its real effect, destroying radars, jammers, mines and small scouts in range, is done by **BAR's gadget** (`unit_juno_damage.lua` via `Spring.DestroyUnit`, or `unit_juno_rework_damage.lua` under the `junorework` mod option) | armjuno, corjuno, legjuno |
| `cluster_def`, `cluster_number` | Splits into sub-munitions on impact. The gadget `unit_custom_weapons_cluster.lua` spawns them with `Spring.SpawnProjectile` | leglrpc (6× `cluster_munition`), legelrpcmech, Corinth |
| `area_onhit_*` | Leaves a burning area that deals damage over time (`unit_area_timed_damage.lua`) | legperdition napalm (120 per tick, radius 150, 15 s) |
| `overrange_distance`, `projectile_destruction_method=descend` | The gadget `unit_projectile_overrange.lua` **deletes** rockets that fly past this distance | armmerl, corvroc, corhrk |
| `shield_aoe_penetration=true` | The blast ignores shields | nukes, EMP, tactical, Juno |
| `bogus=1` | A **dummy** weapon (silos' `nuclear_launch`: range 0, damage 0), never a real projectile | all silos, legstarfall's `energycharger` |

## 3. The target weapons, as the engine had them at runtime

From the `wdefs` fact of a real re-sim: replay
`5a21cb6aab426f7cc932f75394775218` (8v8 on Supreme Isthmus, lava, extra and
scav units on). The capture holds 2041 unit defs and 2919 weapon defs.
`aoe` is the radius (`damageAreaOfEffect`). The extra columns (stockpile,
interceptor, edge) come from the unit files, because the current `wdefs`
fact doesn't record them (§6).

| Class | Unit (def) | Weapon | Type | Range | Reload s | Damage | AoE r | Notes |
|---|---|---|---|---|---|---|---|---|
| Nuke | Armageddon (armsilo) | nuclear_missile | Starburst | 72000 | 30 | 12500 | 640 | stockpile, targetable, edge 0.45 |
| Nuke | Apocalypse (corsilo) | crblmssl | Starburst | 72000 | 30 | 15000 | 960 | |
| Nuke | Supernova (legsilo) | legicbm | Starburst | 72000 | 30 | 15000 | 960 | |
| Nuke (mobile) | Seadragon, Desolator (subs) | sdmssl, crblmssl | Starburst | 72000 | 30 | 9500/11500 | 640/960 | |
| Nuke (mod) | Nuclear ICBM Launcher (\*siloexp) | as silo | Starburst | 72000 | 30 | 1 000 000 | 1600 | costs 16M metal: present in the def table, effectively never built |
| Anti-nuke | Citadel (armamd), Prevailer (corfmd), Aegis (legabm), Rampart (legrampart) | amd/fmd_rocket | Starburst | 72000 | 2 | 1500 | 210 | interceptor, stockpile 20 |
| Anti-nuke (mobile) | Umbrella (armscab), Saviour (cormabm), Hera (legavantinuke) | \*_weapon | Starburst | 72000 | 2 | 500 | 210 | also the carriers Haven, Oasis, Hecate |
| EMP | Paralyzer (armemp) | armemp_weapon | Starburst | 3650 | 2 | 50000 (paralyze) | 156 | stockpile, edge 1 (no falloff) |
| EMP (unit) | Thor (armthor) | empmissile | Starburst | 1050 | 3 | 80000 (paralyze) | 98 | not stockpiled |
| Tactical nuke | Catalyst (cortron) | cortron_weapon | Starburst | 2250 | 2 | 4000 | 190 | `nuclear=1`, stockpile |
| Tactical (napalm) | Perdition (legperdition) | napalmmissile | Cannon | 2300 | 2 | 1200 | 212.5 | stockpile, burning area 15 s |
| LRPC | Basilica (armbrtha) | lrpc | Cannon | 4650 | 13.2 | 1625 | 67.5 | |
| LRPC | Basilisk (corint) | lrpc | Cannon | 4950 | 16 | 2000 | 78.5 | also Leviathan (corslrpc), mobile |
| LRPC | Olympus (leglrpc) | lrpc | Cannon | 4800 | 18 | 600 | 67.5 | + 6 `cluster_munition` sub-shells |
| Rapid LRPC | Ragnarok (armvulc) | rflrpc | Cannon | 5750 | 0.6 | 1625 | 67.5 | cost 700k in this game (`noEndgameLrpc`) |
| Rapid LRPC | Calamity (corbuzz) | rflrpc | Cannon | 6100 | 0.733 | 2000 | 78.5 | cost 680k here |
| Volley LRPC | Starfall (legstarfall) | starfire | Cannon | 6100 | 14 | 600 | 128 | 63-shell salvo |
| Mini (mod) | **Mini Ragnarok** (armminivulc) | armminivulc_weapon | Cannon | 1620 | 0.4 | 420 | 22.4 | unit file says range 1300 |
| Mini (mod) | **Mini Calamity** (corminibuzz) | corminibuzz_weapon | Cannon | 1810 | 0.4 | 375 | 22.4 | file: 1450 |
| Mini (mod) | **Mini Starfall** (legministarfall) | starfire | Cannon | 1750 | 7 | 125 | 27.5 | file: 1400 |
| Juno | Juno (armjuno, corjuno, legjuno) | juno_pulse | Starburst | 32000 | 2 | 1 | 700 | stockpile, effect by gadget |
| Rocket vehicle | Ambassador (armmerl), Boreas (legavroc) | armtruck_rocket | Starburst | 1300 | 18 | 2000 | 80 | overrange 1495 |
| Rocket vehicle | Negotiator (corvroc) | cortruck_rocket | Starburst | 1310 | 15 | 1700 | 75 | |
| T2 rocket bot | Arbiter (corhrk) | corhrk_rocket | Starburst | 1210 | 8 | 850 | 35 | |
| T2 rocket bot | Thanatos (leghrk) | rocket_barrage | Missile | 1200 | 8 | 150 | 48 | |
| T2 rocket bot | Recluse (armsptk) | adv_rocket | Missile | 575 | 3.73 | 200 | 45 | Armada's nearest equivalent (spider), well under the others' range |
| Artillery ship | Corinth (leganavyartyship) | leg_mobile_cluster_lrpc_cannon | Cannon | 2100 | 8.4 | 350 | 75 | cluster |
| T3 artillery | Astraeus (legelrpcmech) | shocker_low | Cannon | 3100 | 14.4 | 600 | 75 | cluster |

**Heavy beams.** All are `BeamLaser`. Damage is per **shot**, and the engine
spreads it over `beamtime · 30` frames (`BeamLaser.cpp:104-110`). Beam time
comes from the unit files.

| Unit (def) | Weapon | Range | Reload s | Damage / shot | Beam time | AoE r | Notes |
|---|---|---|---|---|---|---|---|
| **Pulsar** (armanni), T2 defence | ata | 1400 | 9.9 | 10800 | 1.5 s (45 frames) | 8 | `largebeamlaser` |
| Epic Pulsar (armannit3) | ata | 1800 | 15 | 48000 | | 8 | |
| **Bulwark** (cordoom), T2 defence | atadr | 950 | 6 | 4500 | 0.3 s | 6 | plus two short beams (650 and 370 range) |
| Epic Bulwark (cordoomt3) | armagmheat | 1350 | 4 | 7500 | | 36 | |
| **Titan** (armbanth), T3 | tehlazerofdewm | 800 | 7.5 | 6000 | 1.05 s | 7 | Apex Titan (mod): 1150 range, 21000 |
| **Juggernaut** (corkorg), T3 | corkorg_laser | 900 | 4 | 5500 | 0.6 s | 36 | also cratering (72) |
| Adjudicator (coresuppt3) | laser | 900 | 4 | 5500 | | 36 | |
| Thermite (corthermite), T3 | thermite_laser | 900 | 4 | 2000 | 0.6 s | 36 | |
| Siegebreaker (corsiegebreaker), T2 | dreadovercharge | 910 | 8 | 4000 | 1 s | 30 | a sweeping beam (the Siegebreaker's sweep-fire stage) |
| Starlight (armmanni), T2 tank | atam | 950 | 4.7 | 2500 | 0.3 s | 6 | mobile Pulsar |
| Liquifier (armanavaldefturret) | armada_tachyon_emitter | 950 | 4.7 | 2500 | | 6 | naval |
| Armada Commander lvl 8–10 | longgun | 600 | 8 | 60000 (**paralyze**) | 0.15 s | 30 | an EMP beam |

Behemoth (corjugg) is not here: its beams are short (435 and 550 range, 75
and 150 damage). Its heavy weapon is a `DGun` fireball, a flying projectile.
Legion's railguns (Arquebus, Daedalus, Trident) and the Sharpshooter are
`LaserCannon`. Despite the name, that is a fast **flying bolt**, so they
belong on the projectile path (§4.3) if wanted.

How often these actually fire, as a lower bound: impacts that **damaged a
unit** (distinct shooter and frame pairs in `H`) in four cached re-sims.
Misses aren't in `H`, so real launch counts are higher:

| Game | Weapon: impacts with damage |
|---|---|
| 36 min | Thanatos 1425, Juno 746, Arbiter 118, Ambassador 50, Astraeus 11 (+34 cluster), Negotiator 29 |
| 22 min | Mini Ragnarok 361, Thanatos 157, Basilisk 16, Basilica 14 |
| 39 min | Calamity 146, Basilisk 19 |
| 12.7 min | Mini Starfall 555, Perdition 73 |

So a busy game launches a few thousand to perhaps 20k tracked projectiles.
Each needs a record of a few dozen bytes, which is small next to the frames.

In the 12.6-minute lava game above, no artillery fired at all. Its biggest
damage was **death explosions**: commanders (275k), advanced metal makers
(150k + 51k self-destruct), fusions (150k + 146k + 54k). The explosions half
is not optional decoration.

## 4. Recording design (re-sim widget)

### 4.1 Choosing what to track: classify at `Initialize`, from `WeaponDefs`

```lua
-- one pass over WeaponDefs; the result is a class per weapon def, or nil
local function classify(wd)
  local cp  = wd.customParams or {}
  local dmg = wd.damages and wd.damages[0] or 0
  if cp.bogus then return nil end                         -- silo dummies, energy chargers
  if (wd.interceptor or 0) ~= 0 then return "antinuke" end
  if cp.junotype then return "juno" end
  if cp.nuclear then
    return (wd.range >= 10000) and "nuke" or "tactical"
  end
  if wd.type == "BeamLaser" or wd.type == "LightningCannon" then
    -- dmg is the whole shot; the engine divides it over the beam's frames
    return (dmg >= 2000 and wd.range >= 600) and "beam" or nil  -- Pulsar, Bulwark, Titan, Juggernaut…
  end
  if wd.paralyzer and dmg >= 5000 then return "emp" end   -- armemp, armthor
  if wd.stockpile and wd.range >= 1500 then return "tactical" end  -- legperdition
  if dmg <= 1 then return nil end                          -- AA and utility
  if wd.type == "Cannon" and wd.range >= 1500 then return "artillery" end   -- LRPC, rapid, minis
  if (wd.type == "StarburstLauncher" or wd.type == "MissileLauncher")
     and wd.range >= 1000 then return "rocket" end
  return nil
end
```

The thresholds become one substituted switch per class (like `__DAMAGE__`).
Two adjustments to keep in mind:

- At `range >= 1500`, `artillery` also catches the Cerberus (1650), the Black
  Prince and Black Hydra (T3 ships), the Epoch and the Corinth. All are long
  guns, which is arguably right.
- `rocket` at `>= 1000` catches the Medusa (1000) and the T3 bosses' rockets.
  Raise it to 1150 to keep only the rocket trucks and the T2 rocket bots.

The classification is **data**, recorded per weapon in the `wdefs` fact, so a
reader can re-cut it later without a new re-sim.

### 4.2 Installing `Explosion` in LuaUI

BAR's handler only defines top-level callins it knows. `Explosion` isn't among
them, but `widgetHandler:UpdateCallIn(name)` assigns `_G[name]` for **any**
callin outside its "flex" list, provided `self[name .. "List"]` exists
(`luaui/barwidgets.lua:1075-1101`). That is the same handler access our widget
already uses for `UnitDamaged`:

```lua
local wh = widget.widgetHandler
wh.ExplosionList = wh.ExplosionList or {}     -- UpdateCallIn reads #self.ExplosionList
wh.Explosion = function(self, weaponDefID, px, py, pz, ownerID, projectileID)
  pcall(recordExplosion, weaponDefID, px, py, pz, ownerID, projectileID)
  -- return nothing: a true return would suppress the engine's own graphics
end
wh:UpdateCallIn("Explosion")                  -- sets _G.Explosion and calls Script.UpdateCallIn
for wdid in pairs(watched) do Script.SetWatchExplosion(wdid, true) end
```

**Watched set** = every tracked weapon def (§4.1), plus every
`cluster_def` sub-munition they name, plus every unit's `deathExplosion` /
`selfDExplosion` def. Death explosions are the commander, reactor and
metal-maker blasts.

Caveat: the watch mask belongs to the whole LuaUI handle, so another widget
calling `SetWatchExplosion(id, false)` would switch ours off. The re-sim
disables every other widget, so nothing else is running.

### 4.3 Finding each new projectile

A **launcher registry**: on `UnitFinished`, `UnitGiven` and `UnitTaken`, any
unit with a tracked weapon slot is added with its slot numbers. It is removed
on `UnitDestroyed`. Then in **`GameFramePost`**, for each registered launcher
slot:

1. `rf = GetUnitWeaponState(u, w, "reloadFrame")`. If it **differs** from the
   last reading, the weapon fired this frame. Open a **capture window** lasting
   `salvoSize · salvoDelay + 2` frames, which is 63 shells' worth for Starfall.
2. While a window is open, run `GetProjectilesInSphere(mx, my, mz, r)` around
   the muzzle from `GetUnitWeaponVectors(u, w)`, with `r = max(64, 3 ·
   projectileSpeed)` because the shell has had one projectile update.
3. Keep ids whose `GetProjectileOwnerID` is `u`, whose `GetProjectileDefID`
   is the slot's def, and which aren't already known. Each starts a record:
   - birth frame, id, weapon, owner unit, team;
   - launch position and velocity, and the target (`GetProjectileTarget`:
     unit, ground point or projectile).

Cost: one `GetUnitWeaponState` call per tracked launcher per frame, plus a
sphere query only on frames a weapon fires. A late game with a hundred
launchers costs about 100 cheap calls a frame.

`StockpileChanged` isn't needed for births, because a stockpile weapon's
`reloadFrame` changes too. Record it anyway, as a stockpile fact
(`{"k":"stock","f":…,"u":…,"w":…,"n":newCount}`). That gives "the
Armageddon had 3 nukes ready at 24:10" and the race between nukes built and
anti-nukes built.

Alternatives considered:
- **`GetAllProjectiles` every frame:** simplest, but its cost is every
  projectile on the map, every frame. Rejected.
- **BAR's forwarded `Barrelfire` and `ProjectileCreatedReloadHB`:** free,
  but they cover only some weapon types and depend on BAR's gadgets staying
  as they are. Useful as a check in the harness, not as the mechanism.

### 4.4 In flight

- **Strategic classes** (nuke, antinuke, emp, tactical, juno): only a handful
  per game, and their path is the story, since starburst missiles climb, turn
  and dive. Sample `GetProjectilePosition` every 10 frames into a short
  polyline. Also take `GetProjectileIsIntercepted`, which turns true when an
  anti-nuke engages.
- **Ballistic classes** (artillery): store no samples. The arc follows from
  the launch position, velocity and `GetProjectileGravity`, so a reader
  recomputes it.
- **Rockets:** an optional coarse sample (every 15 frames). They are
  numerous, and their path is close to an arc.

### 4.5 Death of a projectile

- **Normally, `Explosion` with the projectile's id.** This gives the exact frame and
  position, and closes the record with `end = "exploded"`.
- **The fallback is a sweep every 15 frames** over open records: an id whose
  `GetProjectilePosition` returns nil without an explosion closes as
  `"vanished"`. This happens when a gadget deletes it (the overrange leash,
  the cluster split) or a shield absorbs it, if no explosion was reported.
- **Interception:** the anti-nuke's own record has target type `'p'` and the
  nuke's id. When the nuke's explosion comes at the anti-nuke's death frame,
  in the air (y well above the ground at x, z), both records close with
  `intercepted` set on the nuke. A nuke that reached the ground with
  `IsIntercepted` true is **"an anti-nuke tried and missed"**.
- **Id reuse:** the engine recycles projectile ids, so a record is keyed by
  (id, birth frame) and must be closed before a new birth reuses the id. A
  new birth on an open id closes the old one as `"vanished"`.
- **Still flying at game over:** flushed with `end = "unfinished"`.

### 4.6 Explosions

Every `Explosion` call for a watched def writes one blast record:

```
frame, weaponDefID, x, y, z, owner unit (may be nil), projectileID (−1 for death explosions), projectile record index (if tracked)
```

"Strength" comes from the weapon def (§2) through `weaponDefID`, so it isn't
repeated per blast. "What was in it" comes from the existing `H` hits, linked
one of two ways:

- **Exactly:** hits whose callin projectileID equals the blast's. This needs
  the projectile id in `H`, which today stores only a flag that one existed.
  The cheapest form is a column holding the tracked-projectile index for
  hits from tracked projectiles, `0xFFFF` otherwise. It is a new trailing
  column, detected by the bytes left, as `E`'s cause columns were.
- **By matching, with no format change:** hits with the same weapon def,
  within the blast radius of (x, z), from the blast frame to
  `frame + R / explosionSpeed + 1`. Death explosions have no projectile, so
  they always use this. Their hits name the dying unit as attacker, or no one.

Metal destroyed = hits whose `hpAfter <= 0`, priced by victim def. Blasts
with a metal owner join `internal/combat`'s chain crediting ("a chain of
exploding reactors goes to whoever killed the first").

### 4.7 Beams (Pulsar, Bulwark, Titan, Juggernaut, …)

**How the engine fires a beam** (`rts/Sim/Weapons/BeamLaser.cpp`):

- **A shot is a salvo of one beam per frame.** Unless the weapon has
  `beamburst`, firing starts `beamtime · 30` frames of beams (45 for the
  Pulsar). Each carries `1 / that` of the shot's damage (lines 104-110).
- **Every frame, the beam is traced from the muzzle** (`FireInternal`,
  312-443). A shield can bend it into several segments. Each segment
  becomes a short-lived beam projectile: position = segment start, end =
  hit point, lifetime = `beamLaserTTL`.
- **If the beam ended on something** (a unit, a feature, the ground or a
  shield) before its full length, the engine calls `helper->Explosion` at
  the hit point, with `projectileID` = the last segment's id.
  - The damage also falls with distance:
    `max(minIntensity, 1 − length / (2 · range))` × the frame's share.
  - **A beam ending in empty air explodes nowhere**, so that frame produces
    no callin.
- **A sweep-fire beam** (the Siegebreaker's overcharge) moves its aim each
  frame, so its hit points trace a line across the ground.

**Recording.** The pieces already exist; beams need their own aggregation,
because one Pulsar shot is 45 explosion callins:

1. **Firing is detected like any tracked weapon:** the `reloadFrame`
   change (§4.3). It opens a **beam record**:
   - the owner and weapon;
   - the first frame;
   - the muzzle (`GetUnitWeaponVectors`);
   - what it aims at (`GetUnitWeaponTarget`).
2. **Each watched `Explosion` from that owner and weapon** while the
   record is open appends a hit point: frame, x, y, z, and the segment's
   id, which links the frame's `H` hits. `GetProjectilePosition(segment)`
   gives the segment's start. It differs from the muzzle only when a
   shield bent the beam.
3. **The record closes** `beamtime · 30 + 2` frames after it opened, or when
   the weapon fires again.
4. **It is stored as one `R` record** of class `beam`, never as per-frame
   `B` blasts:
   - first and last frame, muzzle, and the number of frames that hit
     something;
   - the hit points thinned to the first, the last, every 5th, and any
     that jumped more than 64 elmos. A sweep keeps its shape; a beam held
     on one target costs a handful of points.

Damage dealt is the `H` hits of that weapon from that owner in the record's
frame range, or exactly by segment id if the `H` projectile column (§4.6)
is added. That gives "this Pulsar shot did 10.8k damage and killed 2.4k
metal", and how often a Titan's laser hits a unit rather than the ground.

Volume: a Pulsar makes 4–5 explosion callins a second while firing, and
writes one small record per 9.9 s shot. Cheap.

## 5. Formats

### Stream (`.brepstream`, protocol bump)

Two new record tags, both buffered per sample like `H`:

- **`R` projectiles**, written when a record closes:
  - `u32 id`, `u16 weapon`, `u16 owner`, `u8 team`, `u8 class`
  - `u32 birthFrame`, `u32 endFrame`, `u8 endKind` (exploded, vanished, intercepted, unfinished)
  - `i16 x0, y0, z0` (launch), `f32 vx, vy, vz` (launch velocity), `f32 gravity`
  - `u8 targetType`, then `i16 tx, ty, tz` or `u32 targetId`
  - `i16 x1, y1, z1` (end), `u8 flags` (bit 0: was intercepted)
  - `u16 nPath` followed by `i16 x, y, z` points (strategic classes only)
  - for class `beam`: launch = the muzzle, velocity and gravity 0, end =
    the last hit point, and each path point is a thinned hit point with a
    `u16` frame offset in front of it (§4.7).
- **`B` blasts:** one per `Explosion` call (except beam frames, which fold
  into their `R` record), columnar like `H`:
  - `u16 df`, `u16 weapon`, `i16 x, y, z`, `u16 owner`, `u8 ownerTeam`
  - `u32 projectile` (`0xFFFFFFFF` = none)

The stockpile timeline needs no new record type: it is the `stock` fact.

### `.brp` (v6, compatible)

Two new **analysis sections, `R` and `B`** (both tags are free; `snapshot/brp.go`
and `analysis.go` use `M K F X E C J G D S H U V`). They are written last,
listed in the section layout, and omitted when empty. Readers already skip
unknown tags, so the viewer and older code are unaffected.

### `wdefs` fact: extend it

The fact is verbatim JSON, so new keys reach the `.brp` with no codec
change. Today it records `id, name, description, type, range, reload,
damage, paralyzer, aoe`. Add:
- `edge` (edgeEffectiveness), `expSpeed`, `crater`, `impulse`;
- `damages` (the full armour-class array, plus a one-time `armorTypes` name
  list);
- `stockpile`, `stockpileTime`, `interceptor`, `targetable`, `coverage`;
- `salvo`, `salvoDelay`, `projectiles`, `speed`, `gravity`, `highTrajectory`,
  `flightTime`;
- the BAR customParams from §2 (`nuclear`, `junotype`, `cluster_def` and
  `cluster_number`, `area_onhit_*`, `overrange_distance`, `bogus`,
  `stockpilelimit`);
- the widget's own `class` (§4.1).

## 6. What the report can then say

- **Nuke card**, per launch:
  - silo and player, launch time, flight time, launch-to-impact distance;
  - whether it was intercepted, by which anti-nuke and where, or reached the
    ground with "an anti-nuke tried";
  - whether the target was inside an enemy anti-nuke's `coverageRange` at
    launch;
  - units in the blast, metal destroyed, the commander killed.
- **Artillery sky:** every tracked shell as an arc from launch to end, faded
  by time. Per gun: shots, hits and metal destroyed, so accuracy and value
  for money ("the Mini Calamities killed 41k metal with 3,100 shells").
- **Stockpile race:** nukes ready against anti-nuke rounds ready, per side,
  over time.
- **EMP and Juno:** units paralysed and for how long (hits with
  `paralyzer`), or units the Juno removed (destroyed events at the
  pulse's frame inside its radius).
- **Biggest blasts:** the top explosions by metal destroyed, death explosions
  included, so "the fusion chain at 18:40" becomes a card of its own.
- **Beam card:** per Pulsar, Bulwark, Titan or Juggernaut:
  - shots fired, and the share that hit a unit rather than the ground;
  - metal destroyed per shot, and the best shot;
  - in the viewer, each beam drawn as a line from muzzle to hit point for
    its duration.

## 7. The uploader widget (player captures)

Everything above is the re-sim's. In a playing client, projectile reads
return nil outside the player's ally team's sight (`IsProjectileVisible`),
and `Explosion` fires only for blasts the engine predicts that ally team
can see. So a player's capture would hold their own side's launches and
whatever the enemy fired into their line of sight. That's still worth
recording, but it isn't the report, and it should wait.

## 8. To verify when implementing

- **The `Explosion` install (§4.2) in a real re-sim.** The harness stubs
  Spring and can't prove the engine calls it.
- **Birth-capture miss rate:** compare births found against `Barrelfire`
  (Cannon weapons) and `ProjectileCreatedReloadHB` (long-reload weapons) for
  one game.
- **Starfall's 63-shell salvo:** whether all 63 land inside the capture
  window, and whether `salvoLeft` beats a fixed window.
- **Juno:** whether `DestroyUnit` kills show up as destroyed events with a
  cause, and which.
- **Re-sim speed:** overhead with every class on, on the large benchmark
  replay (see `patches/engine-2026.07.04/RESULTS.md` for the baselines). The
  output must stay byte-identical with the switches off.
- **Beams:**
  - that `reloadFrame` changes once, at the start of the salvo;
  - that the per-frame callins carry the owner;
  - what a shield-bent beam looks like.
- **`LightningCannon`** (none of the heavy beams use it): read
  `LightningCannon.cpp` before relying on the beam rule for it.
