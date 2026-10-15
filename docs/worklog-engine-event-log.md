# Work log: engine-side explosion and damage log (patch 0004)

Branch `claude/engine-projectile-callins`. Newest entries at the bottom.

## Goal

BAR's 2026.10.13 release (game builds test-31614 on) sandboxes user widgets.
The re-sim widget lost three things it used to get through the REAL widget
handler:

- the `Explosion` callin (projectile ids; ownerless explosions; LightningCannon
  and DGun hits). The fallback, BAR's `VisibleExplosionBatch`, has no
  projectile id and leaves those out;
- `UnitDamaged`'s full arguments (projectile id, attacker, attacker def/team) —
  BAR's handler forwards only the first five;
- disabling BAR's default widget suite (not projectile data; out of scope here).

Goal: a patched engine (2026.07.04 series) that hands the same information to
a widget WITHOUT going through the widget handler.

## Findings

- 2026-10-15: BAR's sandbox (`luaui/barwidgets.lua` `CreateSandboxedSystem`,
  BAR master 24d6817) builds the user widget's `Spring` as `copyTable(Spring)`
  with only CreateDir/SendCommands/SetConfigString/ExtractModArchiveFile/
  Start/Restart/Reload/GiveOrder* replaced. So a NEW `Spring.*` function the
  engine registers reaches a sandboxed widget unchanged. `Script` is copied
  too, but a callin still needs the handler to deliver it — so the data has
  to be PULLED by the widget, not pushed as a callin.
- `spectatorfullview 1` is not on the sandbox's refused-command list, so the
  re-sim widget still gets full read (needed by the gate below).
- Newer BAR builds (test-31620, test-31630) still pin engine 2026.07.04, so the
  patch goes on top of the existing 2026.07.04 series.
- `CEventHandler::Explosion` stops at the first full-read client returning
  true (that suppresses the graphics). Lua handles are ordered 100 (LuaRules)
  and up, so a recorder must be ordered BELOW 100 to see every explosion —
  including ones a gadget claims.
- `CUnit::DoDamage` fires `UnitDamaged` right after `ApplyDamage`, so the
  unit's health read in the event is the post-hit health the widget used to
  read in its callin. LuaUI is order 2000; ordering the damage recorder at
  1999 makes its reading match what LuaUI saw (after gadgets' UnitDamaged).

## Design

- `rts/Lua/LuaEngineEventLog.{h,cpp}`: two unsynced `CEventClient`s owned by
  one recorder — explosions at order -100 (before every Lua handle), damage at
  order 1999 (just before LuaUI). They only append plain numbers to vectors;
  they read no synced state they do not already get handed and change none,
  and `Explosion` returns false, so the sim and the graphics are untouched.
- Off by default: registered with the event handler only while a Lua handle
  has switched them on, so a stock game pays nothing.
- Lua (unsynced read, so LuaUI and every unsynced handle):
  - `Spring.SetEngineEventLog(explosions, damage)` -> switches each on/off.
  - `Spring.GetLoggedExplosions([table])` -> table, count (flat, stride 10).
  - `Spring.GetLoggedDamage([table])` -> table, count (flat, stride 16).
  Both drain the buffer. Both return nothing unless the CALLER has full read
  (a spectator in full view; every replay re-sim), so a playing client cannot
  use them to see enemy fire.

## Log

- 2026-10-15: branch created; Docker + p7zip installed (via a passwordless
  apt-get/docker sudo rule the user added); Recoil 2026.07.04 and BAR master
  cloned into the scratchpad; findings above.
