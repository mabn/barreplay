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
}

const (
	CostFull = "full"
	CostArmy = "army"

	POVFull = "full"
	POVAlly = "ally"
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
	return Input{
		Meta:   f.Meta,
		Events: events,
		Comms:  comms,
		Frames: func(yield func(snapshot.Frame) error) error {
			for i := range f.Chunks {
				frames, err := f.DecodeChunk(i)
				if err != nil {
					return fmt.Errorf("insights: chunk %d: %w", i, err)
				}
				for _, fr := range frames {
					if err := yield(fr); err != nil {
						return err
					}
				}
			}
			return nil
		},
		Bounds:       f.Bounds,
		CostCoverage: CostFull,
	}, nil
}

// pov is the point of view the capture was recorded from.
func (in Input) pov() string {
	if in.POV != "" {
		return in.POV
	}
	if r := in.Meta.Recorder; r != nil && !r.Spectator {
		return POVAlly
	}
	return POVFull
}
