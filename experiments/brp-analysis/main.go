// brp-analysis prints a sanity report of a .brp's re-simulation analysis
// (.brp v6: event causes, G facts, D damage, S lives, V visibility), with the
// cross-checks that say whether the engine handed the widget what it hoped:
//
//	go run ./experiments/brp-analysis <file.brp>
//
// Things to look at: the share of deaths that name a killer (near zero means
// BAR's widget handler does not forward UnitDestroyed's attacker args), the
// overkill total (zero means UnitDamaged reads health before the hit), the
// teamstats fact being present (GetTeamStatsHistory works in a replay), and
// the widget's damage per team against the engine's own damageDealt.
package main

import (
	"fmt"
	"os"
	"sort"

	"github.com/mabn/barreplay/snapshot"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: brp-analysis <file.brp>")
		os.Exit(2)
	}
	if err := run(os.Args[1]); err != nil {
		fmt.Fprintln(os.Stderr, "brp-analysis:", err)
		os.Exit(1)
	}
}

func run(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	bf, err := snapshot.ParseBRP(f)
	if err != nil {
		return err
	}
	f2, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f2.Close()
	meta, frames, events, err := snapshot.ReadBRP(f2)
	if err != nil {
		return err
	}
	fmt.Printf("%s: .brp v%d, game %s, %d frames, %d events\n", path, bf.Version, meta.GameID, len(frames), len(events))

	// Unit-def extras (protocol 4 DEF fields).
	tech, coms, ranged := 0, 0, 0
	for _, d := range meta.UnitDefs {
		if d.TechLevel > 0 {
			tech++
		}
		if d.IsCommander {
			coms++
		}
		if d.MaxWeaponRange > 0 {
			ranged++
		}
	}
	fmt.Printf("unit defs: %d, with techLevel %d, commanders %d, with weapon range %d\n", len(meta.UnitDefs), tech, coms, ranged)

	// Event causes.
	var destroyed, withKiller, withWeapon, given int
	for _, e := range events {
		switch e.Kind {
		case snapshot.EventDestroyed:
			destroyed++
			if e.Cause != nil && e.Cause.UnitID >= 0 {
				withKiller++
			}
			if e.Cause != nil && e.Cause.WeaponDef >= 0 {
				withWeapon++
			}
		case snapshot.EventGiven:
			given++
		}
	}
	fmt.Printf("deaths: %d, naming a killer %d (%s), naming a weapon %d (%s); transfers (given): %d\n",
		destroyed, withKiller, pct(withKiller, destroyed), withWeapon, pct(withWeapon, destroyed), given)

	// Facts.
	facts, err := bf.Facts()
	if err != nil {
		return fmt.Errorf("facts: %w", err)
	}
	kinds := map[string]int{}
	var teamStats []snapshot.FactTeamStatsData
	var teamDeaths []int32 // frames teams died at
	weaponName := map[int32]string{}
	for _, ft := range facts {
		kinds[ft.Kind]++
		switch ft.Kind {
		case snapshot.FactEnd:
			var d snapshot.FactEndData
			if err := ft.Decode(&d); err == nil {
				fmt.Printf("game end at frame %d (%s), winning ally teams %v\n", d.Frame, clock(d.Frame), d.Winners)
			}
		case snapshot.FactTeamDied:
			var d snapshot.FactTeamDiedData
			if err := ft.Decode(&d); err == nil {
				fmt.Printf("team %d died at %s\n", d.Team, clock(d.Frame))
				teamDeaths = append(teamDeaths, d.Frame)
			}
		case snapshot.FactTeamStats:
			var d snapshot.FactTeamStatsData
			if err := ft.Decode(&d); err == nil {
				teamStats = append(teamStats, d)
			}
		case snapshot.FactWeaponDefs:
			var d snapshot.FactWeaponDefsData
			if err := ft.Decode(&d); err == nil {
				fmt.Printf("weapon table: %d weapon defs\n", len(d.Defs))
				for _, w := range d.Defs {
					weaponName[w.ID] = w.Name
				}
			}
		}
	}
	fmt.Printf("facts by kind: %v\n", kinds)
	if kinds[snapshot.FactTeamStats] == 0 {
		fmt.Println("  !! no teamstats fact: GetTeamStatsHistory gave nothing in this replay")
	}

	// Damage windows.
	dmg, err := bf.Damage()
	if err != nil {
		return fmt.Errorf("damage: %w", err)
	}
	// dealt counts what the engine's damageDealt counts: damage to a team
	// that is not an ally, by a named attacker. enemyHp is the same less
	// overkill — what actually came off health.
	allyOf := map[int32]int32{}
	for _, t := range meta.Teams {
		allyOf[t.TeamID] = t.AllyTeam
	}
	// The engine's history is a row every 16 game-seconds, so its last row
	// can stop short of the end of the game. statsEnd is that row's frame;
	// the comparison below counts widget damage up to it only.
	statsEnd := int32(-1)
	for _, ts := range teamStats {
		for i, name := range ts.Fields {
			if name == "frame" && len(ts.Rows) > 0 && i < len(ts.Rows[len(ts.Rows)-1]) {
				statsEnd = max(statsEnd, int32(ts.Rows[len(ts.Rows)-1][i]))
			}
		}
	}
	dealt, enemyHp, ally := map[int32]float64{}, map[int32]float64{}, map[int32]float64{}
	// allyRows: where each team's damage to its own side came from.
	type allyKey struct {
		team, victim, weapon int32
		atDeath              bool
	}
	allyRows := map[allyKey]float64{}
	unknownByWeapon := map[int32]float64{}
	var unknownAfterStats, unknownAtTeamDeath float64
	// nearTeamDeath: within 30 s after some team died, when the engine
	// blows up everything the team still had.
	nearTeamDeath := func(f int32) bool {
		for _, d := range teamDeaths {
			if f >= d-30 && f <= d+900 {
				return true
			}
		}
		return false
	}
	causes := map[string]float64{}
	var total, para, over, unknownAttacker float64
	hits := 0
	for _, w := range dmg {
		for _, r := range w.Rows {
			total += float64(r.Damage)
			para += float64(r.Paralyze)
			over += float64(r.Overkill)
			hits += int(r.Hits)
			if c := snapshot.DamageCauseName(r.WeaponDef); c != "" {
				causes[c] += float64(r.Damage)
			}
			if r.AttackerTeam < 0 {
				unknownAttacker += float64(r.Damage)
				unknownByWeapon[r.WeaponDef] += float64(r.Damage)
				if statsEnd >= 0 && w.Frame >= statsEnd {
					unknownAfterStats += float64(r.Damage)
				}
				if nearTeamDeath(w.Frame) {
					unknownAtTeamDeath += float64(r.Damage)
				}
				continue
			}
			if statsEnd >= 0 && w.Frame >= statsEnd {
				continue // after the engine's last stats row
			}
			switch {
			case allyOf[r.AttackerTeam] == allyOf[r.VictimTeam]:
				ally[r.AttackerTeam] += float64(r.Damage)
				allyRows[allyKey{r.AttackerTeam, r.VictimTeam, r.WeaponDef, nearTeamDeath(w.Frame)}] += float64(r.Damage)
			default:
				dealt[r.AttackerTeam] += float64(r.Damage)
				enemyHp[r.AttackerTeam] += float64(r.Damage - r.Overkill)
			}
		}
	}
	fmt.Printf("damage: %d windows, %d hits, %.0f hp (%.0f paralyze, %.0f overkill), %s with no known attacker\n",
		len(dmg), hits, total, para, over, pct(int(unknownAttacker), int(total)))
	if unknownAttacker > 0 {
		if statsEnd >= 0 {
			fmt.Printf("  no known attacker: %s of it after the engine's last stats row (%s)\n",
				pct(int(unknownAfterStats), int(unknownAttacker)), clock(statsEnd))
		}
		if len(teamDeaths) > 0 {
			fmt.Printf("  no known attacker: %s of it within 30 s after a team died\n",
				pct(int(unknownAtTeamDeath), int(unknownAttacker)))
		}
		ws := make([]int32, 0, len(unknownByWeapon))
		for w := range unknownByWeapon {
			ws = append(ws, w)
		}
		sort.Slice(ws, func(i, j int) bool { return unknownByWeapon[ws[i]] > unknownByWeapon[ws[j]] })
		fmt.Print("  no known attacker, by weapon:")
		for i := 0; i < len(ws) && i < 8; i++ {
			name := weaponName[ws[i]]
			if c := snapshot.DamageCauseName(ws[i]); c != "" {
				name = c
			} else if ws[i] < 0 {
				name = "unknown"
			} else if name == "" {
				name = fmt.Sprintf("#%d", ws[i])
			}
			fmt.Printf("  %s %.0f", name, unknownByWeapon[ws[i]])
		}
		fmt.Println()
	}
	if len(causes) > 0 {
		names := make([]string, 0, len(causes))
		for c := range causes {
			names = append(names, c)
		}
		sort.Slice(names, func(i, j int) bool { return causes[names[i]] > causes[names[j]] })
		fmt.Print("  dealt by the engine, not a weapon:")
		for _, c := range names {
			fmt.Printf("  %s %.0f (%s)", c, causes[c], pct(int(causes[c]), int(total)))
		}
		fmt.Println()
	}
	if total > 0 && over == 0 {
		fmt.Println("  !! zero overkill: UnitDamaged probably reads health before the hit lands")
	}

	// Widget damage vs the engine's own per-team damageDealt, which counts
	// only damage to enemies by a living attacker.
	if len(teamStats) > 0 {
		fmt.Printf("damage dealt to enemies per team up to %s, widget vs engine teamstats (and widget less overkill; widget to allies):\n", clock(statsEnd))
		for _, ts := range teamStats {
			col := -1
			for i, name := range ts.Fields {
				if name == "damageDealt" {
					col = i
				}
			}
			engine := 0.0
			if col >= 0 && len(ts.Rows) > 0 && col < len(ts.Rows[len(ts.Rows)-1]) {
				engine = ts.Rows[len(ts.Rows)-1][col]
			}
			fmt.Printf("  team %2d: widget %10.0f  engine %10.0f  (%s)  less overkill %10.0f  to allies %9.0f\n",
				ts.Team, dealt[ts.Team], engine, ratio(dealt[ts.Team], engine), enemyHp[ts.Team], ally[ts.Team])
		}
	}

	if len(allyRows) > 0 {
		fmt.Printf("ally map: %v\n", allyOf)
		keys := make([]allyKey, 0, len(allyRows))
		for k := range allyRows {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return allyRows[keys[i]] > allyRows[keys[j]] })
		fmt.Println("biggest damage to allies (attacker team -> victim team, weapon):")
		for i := 0; i < len(keys) && i < 10; i++ {
			k := keys[i]
			name := weaponName[k.weapon]
			if c := snapshot.DamageCauseName(k.weapon); c != "" {
				name = c
			}
			when := ""
			if k.atDeath {
				when = " (after a team died)"
			}
			fmt.Printf("  team %d -> team %d  %s  %.0f%s\n", k.team, k.victim, name, allyRows[k], when)
		}
	}

	// Kills inside one side: who killed what, when, with what. The chain
	// credit starts from these, so a surprising "to allies" figure is
	// explained (or not) here.
	var friendly []snapshot.Event
	for _, e := range events {
		if e.Kind == snapshot.EventDestroyed && e.Cause != nil && e.Cause.Team >= 0 &&
			allyOf[e.Cause.Team] == allyOf[e.Team] && e.Cause.UnitID != e.UnitID {
			friendly = append(friendly, e)
		}
	}
	if len(friendly) > 0 {
		fmt.Printf("kills inside one side: %d; the first 15:\n", len(friendly))
		defName := func(id int32) string {
			if d, ok := meta.UnitDefs[id]; ok {
				return d.Name
			}
			return fmt.Sprintf("#%d", id)
		}
		for i := 0; i < len(friendly) && i < 15; i++ {
			e := friendly[i]
			wn := weaponName[e.Cause.WeaponDef]
			if wn == "" {
				wn = fmt.Sprintf("#%d", e.Cause.WeaponDef)
			}
			fmt.Printf("  %s  team %d %s (unit %d) killed team %d %s (unit %d) with %s\n", clock(e.Frame),
				e.Cause.Team, defName(e.Cause.DefID), e.Cause.UnitID, e.Team, defName(e.DefID), e.UnitID, wn)
		}
	}

	// Lives.
	lives, err := bf.Lives()
	if err != nil {
		return fmt.Errorf("lives: %w", err)
	}
	alive, kills := 0, 0
	var maxXP float32
	for _, l := range lives {
		if l.Died < 0 {
			alive++
		}
		kills += int(l.Kills)
		if l.XP > maxXP {
			maxXP = l.XP
		}
	}
	fmt.Printf("lives: %d units (%d alive at the end), %d kills credited (deaths naming a killer: %d), top xp %.2f\n",
		len(lives), alive, kills, withKiller, maxXP)
	top := append([]snapshot.UnitLife(nil), lives...)
	sort.Slice(top, func(i, j int) bool { return top[i].Kills > top[j].Kills })
	for i := 0; i < len(top) && i < 5 && top[i].Kills > 0; i++ {
		l := top[i]
		fmt.Printf("  #%d unit %d %s (team %d): %d kills, %.0f dealt\n", i+1, l.UnitID, meta.UnitDefs[l.DefID].Name, l.Team, l.Kills, l.Dealt)
	}

	// Visibility.
	vis, err := bf.Visibility()
	if err != nil {
		return fmt.Errorf("visibility: %w", err)
	}
	full, rows := 0, 0
	var sides []int32
	for _, v := range vis {
		if v.Full {
			full++
		}
		rows += len(v.Units)
		sides = v.Allies
	}
	fmt.Printf("visibility: %d records (%d full restatements), %d unit rows, sides %v\n", len(vis), full, rows, sides)
	if len(vis) > 0 {
		// The share of units each side could see at the last full restatement.
		for i := len(vis) - 1; i >= 0; i-- {
			v := vis[i]
			if !v.Full || len(v.Units) == 0 {
				continue
			}
			fmt.Printf("  at %s (%d units):", clock(v.Frame), len(v.Units))
			for s := range v.Allies {
				los, radar := 0, 0
				for u := range v.Units {
					l, r := v.Sees(u, s)
					if l {
						los++
					}
					if r {
						radar++
					}
				}
				fmt.Printf("  side %d LOS %s radar %s", v.Allies[s], pct(los, len(v.Units)), pct(radar, len(v.Units)))
			}
			fmt.Println()
			break
		}
	}

	// The browser-facing part must be unchanged: every section, with sizes.
	fmt.Println("sections:")
	tags := make([]int, 0, len(bf.Sections))
	for t := range bf.Sections {
		tags = append(tags, int(t))
	}
	sort.Ints(tags)
	for _, t := range tags {
		fmt.Printf("  %c %10d bytes\n", t, len(bf.Sections[byte(t)]))
	}
	return nil
}

func pct(a, b int) string {
	if b == 0 {
		return "-"
	}
	return fmt.Sprintf("%.0f%%", 100*float64(a)/float64(b))
}

func ratio(a, b float64) string {
	if b == 0 {
		return "-"
	}
	return fmt.Sprintf("%.2fx", a/b)
}

func clock(frame int32) string {
	s := frame / 30
	return fmt.Sprintf("%d:%02d", s/60, s%60)
}
