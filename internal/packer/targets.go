package packer

import (
	"sort"
	"strconv"
	"strings"
)

// The publishing destinations. A destination is an R2 bucket AND the worker
// that serves it: the pieces go to the bucket, and the catalog row that makes
// them findable goes to that worker's Durable Object (and, for the ingest
// daemon, the job queue and stream downloads it works off live there too).
//
// They are chosen together, by name, and cannot be named separately. A
// free-form index-URL flag alongside the bucket target made it possible to
// upload pieces to one destination and register the row in the other, which
// nothing downstream can detect: a catalog row happily points at a rid whose
// objects live in a bucket the reader cannot see, so the replay simply 404s
// with a perfectly healthy-looking listing. Both CLIs that publish
// (cmd/pack, cmd/bringest) resolve their target here.

// UploadTarget is one publishing destination.
type UploadTarget struct {
	// Name is the -upload value that selects it.
	Name string
	// IndexURL is the worker's base URL: the catalog PUT for every publisher,
	// plus the job queue and archived-stream reads for the ingest daemon.
	IndexURL string
	// What describes the destination in flag help ("the real bucket").
	What string
}

var uploadTargets = map[string]UploadTarget{
	"r2":    {Name: "r2", IndexURL: "https://replay.bartools.workers.dev", What: "the real bucket"},
	"local": {Name: "local", IndexURL: "http://127.0.0.1:5173", What: "the vite/wrangler dev simulator"},
}

// LookupTarget resolves an -upload value to its destination. The second result
// is false for anything not in the table, which is how both CLIs validate the
// flag — the table is the definition of a valid target, so adding one here
// makes it accepted, documented and usable everywhere at once.
func LookupTarget(name string) (UploadTarget, bool) {
	t, ok := uploadTargets[name]
	return t, ok
}

// TargetNames lists the valid targets in a stable order (map iteration is
// randomized, and usage text that reshuffles between runs is not usage text).
func TargetNames() []string {
	out := make([]string, 0, len(uploadTargets))
	for name := range uploadTargets {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// TargetHelp renders the destinations for a flag's usage string, naming the
// URL each one publishes to so `-help` answers "where does this actually go?"
// without a trip to the source.
func TargetHelp() string {
	parts := make([]string, 0, len(uploadTargets))
	for _, name := range TargetNames() {
		t := uploadTargets[name]
		parts = append(parts, strconv.Quote(name)+" ("+t.What+" + "+t.IndexURL+")")
	}
	return strings.Join(parts, " or ")
}

// TargetList renders just the names, for an error message.
func TargetList() string {
	names := TargetNames()
	quoted := make([]string, len(names))
	for i, n := range names {
		quoted[i] = strconv.Quote(n)
	}
	return strings.Join(quoted, " or ")
}
