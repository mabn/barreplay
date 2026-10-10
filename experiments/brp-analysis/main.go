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
	dealt, enemyHp, ally := map[int32]float64{}, map[int32]float64{}, map[int32]float64{}
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
			switch {
			case r.AttackerTeam < 0:
				unknownAttacker += float64(r.Damage)
			case allyOf[r.AttackerTeam] == allyOf[r.VictimTeam]:
				ally[r.AttackerTeam] += float64(r.Damage)
			default:
				dealt[r.AttackerTeam] += float64(r.Damage)
				enemyHp[r.AttackerTeam] += float64(r.Damage - r.Overkill)
			}
		}
	}
	fmt.Printf("damage: %d windows, %d hits, %.0f hp (%.0f paralyze, %.0f overkill), %s with no known attacker\n",
		len(dmg), hits, total, para, over, pct(int(unknownAttacker), int(total)))
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
		fmt.Println("damage dealt to enemies per team, widget vs engine teamstats (and widget less overkill; widget to allies):")
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
