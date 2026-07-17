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

`epic_reclaimer.min.lua` is the same script hand-minified to one line
(~1.5 KB base64 instead of ~6 KB) for paths with tight message limits; it is
kept in behavioral lockstep with the full version (same stub test runs both).

## Applying a tweak

Base64-encode the script (URL-safe) and set it as the modoption:

```sh
basenc --base64url -w0 epic_reclaimer.min.lua   # or: base64 -w0 file | tr '+/' '-_'
```

Prefer pasting the encoded string into the **lobby's tweakdefs field**
(advanced options UI) — the lobby batches long values. Sending it as a
single `!bset tweakdefs <encoded>` chat line can silently truncate it
(flood protection / message length caps), which decodes to Lua that ends
mid-statement and fails with `'<something>' expected near '<eof>'`.
Numbered slots `tweakdefs1`..`tweakdefs9` run as separate chunks, sorted by
index. The game echoes each decoded tweak to the infolog before running
it — if the unit doesn't appear, check there that the source arrived
complete and error-free.
