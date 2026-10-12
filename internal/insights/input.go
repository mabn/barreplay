package insights

import (
	"fmt"

	"github.com/mabn/barreplay/snapshot"
)

// Input is everything Compute reads, independent of where it came from: a
// whole .brp at publish time, or the split pieces of an already-published
// replay (see viz.ReadStaticBundle), which carry less.
type Input struct {
	Meta   snapshot.Meta
	Events []snapshot.Event
	Comms  []snapshot.Comm
	// Frames walks every sampled frame in order. A frame's Resources may be
	// empty; Resources below then supplies them.
	Frames func(yield func(snapshot.Frame) error) error
	// Resources maps a sim frame to its team economy, for inputs whose
	// frames do not carry it (the published pieces keep it in .resources).
	Resources map[int32][]snapshot.TeamResource
	// HasTargets is whether frames carry build targets (TargetID). A v4
	// bundle does not, and reads every unit as targeting nothing.
	HasTargets bool
	// Bounds is the world extent of all sampled positions, or nil.
	Bounds *snapshot.BRPBounds
	// CostCoverage is CostFull when Meta.UnitDefs carries every def's cost,
	// CostArmy when only armed mobile defs have one (a replay rebuilt from
	// its published pieces).
	CostCoverage string
	// POV overrides the point of view derived from Meta.Recorder. A replay
	// rebuilt from its pieces has no recorder record, so its caller reads
	// the catalog row's view instead.
	POV string
	// TeamDied maps a team to the frame it was eliminated, from the capture's
	// own record (a v6 .brp's teamdied facts). Nil when the capture keeps no
	// facts; Compute then infers eliminations from the deaths.
	TeamDied map[int32]int32
	// ModOptions is the game's lobby settings (the demo startscript's
	// [modoptions], which the BAR API serves as gameSettings), nil when
	// unknown. They say whether it is a lava game, which picks the win
	// model (WinModels); a .brp does not store them.
	ModOptions map[string]string
}

const (
	CostFull = "full"
	CostArmy = "army"

	POVFull    = "full"
	POVAlly    = "ally"
	POVUnknown = "unknown"
)

// FromBRP builds an Input over a parsed .brp. Frames are decoded chunk by
// chunk as they are walked, so the whole replay is never held at once.
func FromBRP(f *snapshot.BRPFile) (Input, error) {
	events, err := f.Events()
	if err != nil {
		return Input{}, err
	}
	comms, err := f.Comms()
	if err != nil {
		return Input{}, err
	}
	facts, err := f.Facts()
	if err != nil {
		return Input{}, err
	}
	var died map[int32]int32
	if facts != nil {
		died = map[int32]int32{}
		for _, fc := range facts {
			if fc.Kind != snapshot.FactTeamDied {
				continue
			}
			var d snapshot.FactTeamDiedData
			if fc.Decode(&d) != nil {
				continue
			}
			if old, ok := died[d.Team]; !ok || d.Frame < old {
				died[d.Team] = d.Frame
			}
		}
	}
	return Input{
		Meta:   f.Meta,
		Events: events,
		Comms:  comms,
		Frames: func(yield func(snapshot.Frame) error) error {
			return chunkFrames(f, yield)
		},
		Bounds:       f.Bounds,
		HasTargets:   !f.Legacy,
		CostCoverage: CostFull,
		TeamDied:     died,
	}, nil
}

// pov is the point of view the capture was recorded from.
func (in Input) pov() string {
	if in.POV != "" {
		return in.POV
	}
	if r := in.Meta.Recorder; r != nil && !r.SawAll() {
		return POVAlly
	}
	return POVFull
}

// FromPieces builds an Input over a replay rebuilt from its published pieces
// (viz.ReadStaticBundle): the economy comes from .resources rather than the
// frames, and only armed mobile defs are priced. pov is the catalog row's view
// ("full", "ally"), or empty when the row does not say.
func FromPieces(f *snapshot.BRPFile, resources map[int32][]snapshot.TeamResource, pov string) (Input, error) {
	in, err := FromBRP(f)
	if err != nil {
		return Input{}, err
	}
	in.Resources = resources
	in.CostCoverage = CostArmy
	switch pov {
	case POVFull, POVAlly:
		in.POV = pov
	default:
		// Nothing records whose view it is; a replay with no recorder record
		// would otherwise read as full, which is the claim not to make.
		in.POV = POVUnknown
	}
	return in, nil
}

// decodeAhead is how many chunks are decoded ahead of the pass. Decoding is
// a third of a summary's work and the pass cannot use more than one core, so
// the chunks after the one being read decode on others meanwhile: the summary
// a reader is waiting for (POST /api/insights) is then bound by the pass alone.
const decodeAhead = 3

// chunkFrames yields every frame of f in order, decoding up to decodeAhead
// chunks ahead of the one being yielded.
func chunkFrames(f *snapshot.BRPFile, yield func(snapshot.Frame) error) error {
	// DecodeChunk caches the keyframes on first use; do that here, before
	// several goroutines could race to.
	if len(f.Chunks) > 0 {
		if _, err := f.Keyframes(); err != nil {
			return fmt.Errorf("insights: chunk 0: %w", err)
		}
	}
	type decoded struct {
		frames []snapshot.Frame
		err    error
	}
	done := make(chan struct{})
	defer close(done)
	results := make([]chan decoded, len(f.Chunks))
	for i := range results {
		results[i] = make(chan decoded, 1)
	}
	sem := make(chan struct{}, decodeAhead)
	go func() {
		for i := range f.Chunks {
			select {
			case sem <- struct{}{}:
			case <-done:
				return
			}
			go func(i int) {
				frames, err := f.DecodeChunk(i)
				results[i] <- decoded{frames, err}
			}(i)
		}
	}()
	for i := range f.Chunks {
		r := <-results[i]
		<-sem
		if r.err != nil {
			return fmt.Errorf("insights: chunk %d: %w", i, r.err)
		}
		for _, fr := range r.frames {
			if err := yield(fr); err != nil {
				return err
			}
		}
	}
	return nil
}
