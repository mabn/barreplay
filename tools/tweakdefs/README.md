# BAR tweakdefs scripts

Lua scripts meant to be passed to Beyond All Reason via the `tweakdefs`
modoption. They run inside `gamedata/unitdefs_post.lua` (before BAR's own
unit post-processing) with the global `UnitDefs` table in scope, so they can
modify existing unit defs or add entirely new ones.

## epic_reclaimer.lua

Adds `epicreclaimer` — a flying, reclaim-only unit:

- Epic Serpent (`armserpt3`) model at 50% scale. The engine can't rescale an
  `.s3o` from a unit def, but `ARMSERPT3.s3o` is exactly the base Serpent
  mesh scaled 2x, so the def points at `ARMSERP.s3o` — the same model at
  half the epic's size.
- Flies exactly like `coraca` (Advanced Construction Aircraft): the def is a
  deep copy of it, inheriting speed/acceleration/turnrate/cruise altitude.
- 10000 reclaim power; cannot build, assist, repair, resurrect, capture or
  terraform.
- Strategic icon: `air_t1_rez`; in-game name via the `i18n_en_humanname`
  customparam.
- Buildable from the T1 Aircraft Plants (`armap`/`corap`/`legap`) and the
  Advanced Aircraft Plants (`armaap`/`coraap`/`legaap`), or `/cheat` +
  `/give epicreclaimer`.

## Applying a tweak

Base64-encode the script (URL-safe) and set it as the modoption:

```sh
basenc --base64url -w0 epic_reclaimer.lua   # or: base64 -w0 file | tr '+/' '-_'
```

Then in a lobby: `!bset tweakdefs <encoded>` (or paste into the tweakdefs
field of a local skirmish's advanced options). Numbered slots
`tweakdefs1`..`tweakdefs9` work the same way. Errors are echoed to the
infolog with the decoded source, so check there if the unit doesn't appear.
