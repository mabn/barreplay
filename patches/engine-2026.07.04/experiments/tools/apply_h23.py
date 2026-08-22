#!/usr/bin/env python3
"""H23 (round 2): direct switch dispatch in TickAllAnims."""
p='/home/mabn/dev/recoil/rts/Sim/Units/Scripts/UnitScript.cpp'
s=open(p).read()
old = """	// tick-functions; these never change address
	static constexpr std::array<TickAnimFunc, ACount> TICK_ANIM_FUNCS = { &CUnitScript::TickTurnAnim, &CUnitScript::TickSpinAnim, &CUnitScript::TickMoveAnim, &CUnitScript::TickScaleAnim };

	const int tickRate = 1000 / deltaTime;

	// clear doneAnims here to preserve them for DumpState
	doneAnims.clear();

	for (auto& ai : anims) {
		LocalModelPiece& lmp = *pieces[ai.piece];
		const auto& currFunc = TICK_ANIM_FUNCS[ai.animType];
		if ((ai.done |= std::invoke(currFunc, this, tickRate, lmp, ai))) {"""
new = """	const int tickRate = 1000 / deltaTime;

	// clear doneAnims here to preserve them for DumpState
	doneAnims.clear();

	for (auto& ai : anims) {
		LocalModelPiece& lmp = *pieces[ai.piece];
		// [barreplay H23] direct switch instead of std::invoke on a
		// runtime-indexed member-function-pointer table: the target is a runtime
		// value (ai.animType), so the pointer call can never be devirtualized,
		// while this switch lets the compiler inline each small Tick*Anim body.
		// Same function per animType (the order the table had: Turn/Spin/Move/
		// Scale = 0/1/2/3), so results and side effects are bit-identical.
		bool finished = false;
		switch (ai.animType) {
			case ATurn:  finished = TickTurnAnim (tickRate, lmp, ai); break;
			case ASpin:  finished = TickSpinAnim (tickRate, lmp, ai); break;
			case AMove:  finished = TickMoveAnim (tickRate, lmp, ai); break;
			case AScale: finished = TickScaleAnim(tickRate, lmp, ai); break;
			default: assert(false); break;
		}
		if ((ai.done |= finished)) {"""
assert old in s, "TickAllAnims dispatch anchor"
s=s.replace(old,new,1)
open(p,'w').write(s)
print("H23 applied")
