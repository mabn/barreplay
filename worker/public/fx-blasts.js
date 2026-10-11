// fx-blasts.js: the replay viewer's blast layer. Strong explosions that
// ended no track: the W rows (data.blasts, data.fxIndex.blasts).
//
// A plain script loaded before app.js, sharing its globals (data, viewW,
// viewH, center, scale, teamColor, w2s, FX_CLASS, ...). drawEffects in app.js
// calls drawBlasts once per overlay paint, only while effects are shown and the
// replay's effect records have loaded; see "effects" in app.js for what is on
// `data`.
//
// c        the overlay canvas's 2D context, in CSS pixels
// simFrame the fractional sim frame the units are interpolated to
// u        the displayed frame's units (null while its chunk streams in)
function drawBlasts(c, simFrame, u) {
}
