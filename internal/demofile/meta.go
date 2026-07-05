package demofile

import "github.com/mabn/barreplay/snapshot"

// BaseMeta converts a parsed demo's header + startscript into the authoritative
// base capture metadata: game id, engine/game versions, map name, start time,
// and the player roster. The startscript is the only source of per-player
// attributes (country flag, ladder rank, OpenSkill rating + uncertainty,
// account id, boss) — the engine's live player list does not carry them.
//
// The caller fills the run-specific SampleEvery; the unit-def and team tables
// are discovered from the widget stream by internal/capture and merged there.
func BaseMeta(d *Demo) snapshot.Meta {
	m := snapshot.Meta{
		GameID:        d.Header.GameID,
		EngineVersion: d.Header.EngineVersion,
		GameVersion:   d.Startscript.GameType,
		MapName:       d.Startscript.MapName,
		StartUnix:     int64(d.Header.UnixTime),
		UnitDefs:      map[int32]snapshot.UnitDef{},
	}
	for _, p := range d.Startscript.Players {
		m.Players = append(m.Players, snapshot.PlayerInfo{
			PlayerID:         int32(p.Index),
			Name:             p.Name,
			Team:             int32(p.Team),
			Spectator:        p.Spectator,
			CountryCode:      p.CountryCode,
			Rank:             int32(p.Rank),
			Skill:            float32(p.Skill),
			SkillUncertainty: float32(p.SkillUncertainty),
			AccountID:        p.AccountID,
			Boss:             p.Boss,
		})
	}
	return m
}
