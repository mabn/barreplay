#!/usr/bin/env python3
"""H30 (round 2): coarse exit-only presence grid over the tiled yardmap."""
import re, sys
R='/home/mabn/dev/recoil/'
h=R+'rts/Sim/Misc/YardmapStatusEffectsMap.h'
c=R+'rts/Sim/Misc/YardmapStatusEffectsMap.cpp'
m=R+'rts/Sim/MoveTypes/MoveMath/MoveMath.cpp'

s=open(h).read()
old_set = """	void SetFlags  (int x, int z, uint8_t flags) { GetMapState(x, z) |=  flags; }
	void ClearFlags(int x, int z, uint8_t flags) { GetMapState(x, z) &= ~flags; }
"""
new_set = """	// [barreplay H30] EXIT_ONLY squares are written only by factory yardmaps
	// (GroundBlockingObjectMap Add/RemoveGroundBlockingObject), so they are
	// sparse and spatially clustered, while RangeHasExitOnly scans a whole
	// footprint on every collision query. Maintain a coarse per-block count of
	// exit-only squares here so that scan can be rejected outright away from
	// factories. The count is a conservative superset of the fine map (a block
	// counts > 0 iff some square in it is exit-only), so rejecting on it
	// returns exactly what the full scan would have returned.
	void SetFlags(int x, int z, uint8_t flags) {
		const int cx = std::clamp(x, 0, mapDims.mapxm1);
		const int cz = std::clamp(z, 0, mapDims.mapym1);
		uint8_t& st = GetMapState(cx, cz);
		if ((flags & EXIT_ONLY) && !(st & EXIT_ONLY))
			++eoBlocks[EOBlockIdx(cx, cz)];
		st |= flags;
	}
	void ClearFlags(int x, int z, uint8_t flags) {
		const int cx = std::clamp(x, 0, mapDims.mapxm1);
		const int cz = std::clamp(z, 0, mapDims.mapym1);
		uint8_t& st = GetMapState(cx, cz);
		if ((flags & EXIT_ONLY) && (st & EXIT_ONLY))
			--eoBlocks[EOBlockIdx(cx, cz)];
		st &= ~flags;
	}

	// true when some square in [xmin,xmax]x[zmin,zmax] MAY be exit-only.
	// Conservative: never false while a real exit-only square is in range.
	bool RangeMayHaveExitOnly(int xmin, int xmax, int zmin, int zmax) const {
		const int bx0 = std::clamp(xmin, 0, mapDims.mapxm1) >> EO_BLOCK_SHIFT;
		const int bx1 = std::clamp(xmax, 0, mapDims.mapxm1) >> EO_BLOCK_SHIFT;
		const int bz0 = std::clamp(zmin, 0, mapDims.mapym1) >> EO_BLOCK_SHIFT;
		const int bz1 = std::clamp(zmax, 0, mapDims.mapym1) >> EO_BLOCK_SHIFT;
		for (int bz = bz0; bz <= bz1; ++bz) {
			const int row = bz * eoStride;
			for (int bx = bx0; bx <= bx1; ++bx)
				if (eoBlocks[row + bx] != 0) return true;
		}
		return false;
	}
"""
assert old_set in s, "SetFlags/ClearFlags anchor not found"
s=s.replace(old_set,new_set,1)

old_priv = """	int tileStride = 0; // tiles per map row, set by Init / PostLoad
"""
new_priv = """	int tileStride = 0; // tiles per map row, set by Init / PostLoad

	// [barreplay H30] coarse exit-only presence grid: one counter per
	// EO_BLOCK x EO_BLOCK square block. 16 keeps the grid ~1/256th of the map
	// (a few KB, permanently hot) while still being finer than the footprints
	// that query it. A tile (8x8) never straddles a block, which is what lets
	// ClearTile fix the count with a single subtraction.
	static constexpr int EO_BLOCK_SHIFT = 4;
	int EOBlockIdx(int cx, int cz) const {
		return (cz >> EO_BLOCK_SHIFT) * eoStride + (cx >> EO_BLOCK_SHIFT);
	}
	void RebuildExitOnlyBlocks();

	int eoStride = 0;
	std::vector<uint16_t> eoBlocks;
"""
assert old_priv in s
s=s.replace(old_priv,new_priv,1)
open(h,'w').write(s)

s=open(c).read()
s=s.replace("""	CR_IGNORED(tileStride),   // rebuilt from stateMap size on PostLoad""",
            """	CR_IGNORED(tileStride),   // rebuilt from stateMap size on PostLoad
	CR_IGNORED(eoStride),     // [barreplay H30] rebuilt from stateMap on PostLoad
	CR_IGNORED(eoBlocks),     // (a pure derivative of stateMap, never the truth)""",1)
old_clear = """void YardmapStatusEffectsMap::ClearTile(int tileId) {
	assert(tileId >= 0 && tileId < static_cast<int>(stateMap.size()));
	memset(&stateMap[tileId], 0, sizeof(Tile));
}"""
new_clear = """void YardmapStatusEffectsMap::ClearTile(int tileId) {
	assert(tileId >= 0 && tileId < static_cast<int>(stateMap.size()));

	// [barreplay H30] a tile spans 8x8 squares and a block 16x16, aligned, so
	// every square of a tile lives in ONE block: count what is being erased
	// and subtract it once.
	const Tile& tile = stateMap[tileId];
	int erased = 0;
	for (int i = 0; i < TILE_AREA; ++i)
		erased += ((tile.squares[i] & EXIT_ONLY) != 0);

	if (erased != 0) {
		const int tx = (tileId % tileStride) * TILE_SIZE;
		const int tz = (tileId / tileStride) * TILE_SIZE;
		eoBlocks[EOBlockIdx(tx, tz)] -= erased;
	}

	memset(&stateMap[tileId], 0, sizeof(Tile));
}

// [barreplay H30] recompute the coarse grid from the fine map.
void YardmapStatusEffectsMap::RebuildExitOnlyBlocks() {
	eoStride = ((mapDims.mapx - 1) >> EO_BLOCK_SHIFT) + 1;
	const int blocksZ = ((mapDims.mapy - 1) >> EO_BLOCK_SHIFT) + 1;
	eoBlocks.assign(eoStride * blocksZ, 0);

	for (int z = 0; z < mapDims.mapy; ++z) {
		for (int x = 0; x < mapDims.mapx; ++x) {
			if (GetMapState(x, z) & EXIT_ONLY)
				++eoBlocks[EOBlockIdx(x, z)];
		}
	}
}"""
assert old_clear in s
s=s.replace(old_clear,new_clear,1)
s=s.replace("""	stateMap.resize(tilesX * tilesZ); // value-initialises: squares are zeroed
}""","""	stateMap.resize(tilesX * tilesZ); // value-initialises: squares are zeroed

	RebuildExitOnlyBlocks();
}""",1)
s=s.replace("""void YardmapStatusEffectsMap::PostLoad() {
	tileStride = (mapDims.mapx + TILE_SIZE - 1) / TILE_SIZE;
}""","""void YardmapStatusEffectsMap::PostLoad() {
	tileStride = (mapDims.mapx + TILE_SIZE - 1) / TILE_SIZE;

	RebuildExitOnlyBlocks();
}""",1)
open(c,'w').write(s)

s=open(m).read()
old_range = """bool CMoveMath::RangeHasExitOnly(int xmin, int xmax, int zmin, int zmax, const ObjectCollisionMapHelper& object) {
	for (int z = zmin; z <= zmax; z += FOOTPRINT_ZSTEP) {"""
new_range = """bool CMoveMath::RangeHasExitOnly(int xmin, int xmax, int zmin, int zmax, const ObjectCollisionMapHelper& object) {
	// [barreplay H30] reject the scan outright when no block overlapping the
	// footprint holds an exit-only square (the common case: exit-only exists
	// only under factory yardmaps).
	if (!yardmapStatusEffectsMap.RangeMayHaveExitOnly(xmin, xmax, zmin, zmax))
		return false;

	for (int z = zmin; z <= zmax; z += FOOTPRINT_ZSTEP) {"""
assert old_range in s
s=s.replace(old_range,new_range,1)
open(m,'w').write(s)
print("H30 applied")
