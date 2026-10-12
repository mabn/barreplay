package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
)

// tableCats maps this tool's structure categories to the names
// internal/insights gives them (Series.BuildingCats).
var tableCats = map[string]string{catDef: "defence", catEco: "eco", catMex: "mex", catBld: "other"}

// writeTable writes internal/insights' legacy building table from a .brp
// run's defcat.json and defcost.json: every structure's category and metal
// cost by def name. A replay rebuilt from its published pieces prices only
// its armed mobile units, and the win line reads its standing buildings
// through this table, exactly as the study that fitted the line did.
func writeTable(dir, out string) {
	cats, costs := loadTables(dir)
	names := make([]string, 0, len(cats))
	for n, c := range cats {
		if _, ok := tableCats[c]; ok && costs[n] > 0 {
			names = append(names, n)
		}
	}
	sort.Strings(names)
	var sb strings.Builder
	sb.WriteString("{\n")
	for i, n := range names {
		k, _ := json.Marshal(n)
		fmt.Fprintf(&sb, "%s:[%q,%g]", k, tableCats[cats[n]], costs[n])
		if i < len(names)-1 {
			sb.WriteString(",")
		}
		sb.WriteString("\n")
	}
	sb.WriteString("}\n")
	if err := os.WriteFile(out, []byte(sb.String()), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(len(names), "structures")
}
