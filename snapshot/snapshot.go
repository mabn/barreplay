// Package snapshot defines the data model for recorded BAR replay state and a
// pluggable Writer interface that owns the on-disk format.
//
// The rest of the tool (engine launch, stdout capture) only ever talks to this
// package through the Writer interface, so the persistence format can be swapped
// for a columnar/binary representation later without touching the capture or
// engine code. The v1 implementation is line-delimited JSON (see jsonl.go); it
// is intentionally simple and human-inspectable.
package snapshot

// Vec3 is a position in Recoil world coordinates (x/z are the ground plane,
// y is height). Units are engine "elmos".
type Vec3 struct {
	X float32 `json:"x"`
	Y float32 `json:"y"`
	Z float32 `json:"z"`
}

// UnitState is the sampled state of a single unit at one frame.
type UnitState struct {
	UnitID    int32   `json:"id"`
	DefID     int32   `json:"def"`
	Team      int32   `json:"team"`
	Pos       Vec3    `json:"pos"`
	Health    float32 `json:"hp"`
	MaxHealth float32 `json:"maxHp"`
}

// Frame is one periodic snapshot of the whole game: the position/health of every
// visible unit at a given simulation frame.
type Frame struct {
	Frame   int32       `json:"frame"`
	TimeSec float32     `json:"t"`
	Units   []UnitState `json:"units"`
}

// EventKind enumerates the discrete unit lifecycle events recorded between frames.
type EventKind string

const (
	EventCreated   EventKind = "created"
	EventFinished  EventKind = "finished"
	EventDestroyed EventKind = "destroyed"
)

// Event is a discrete unit lifecycle event, recorded at the exact frame it
// happened (independent of the periodic sampling interval).
type Event struct {
	Frame  int32     `json:"frame"`
	Kind   EventKind `json:"kind"`
	UnitID int32     `json:"id"`
	DefID  int32     `json:"def"`
	Team   int32     `json:"team"`
}

// TeamInfo describes a team present in the replay.
type TeamInfo struct {
	TeamID     int32  `json:"teamId"`
	AllyTeam   int32  `json:"allyTeam"`
	Side       string `json:"side,omitempty"`
	PlayerName string `json:"player,omitempty"`
}

// Meta is written once at the start of a capture and describes the replay and
// the static data needed to interpret the frames (notably the unit-def id -> name
// mapping, which is stable for the duration of a single game).
type Meta struct {
	GameID        string           `json:"gameId"`
	EngineVersion string           `json:"engineVersion"`
	GameVersion   string           `json:"gameVersion"`
	MapName       string           `json:"mapName"`
	StartUnix     int64            `json:"startUnix"`
	SampleEvery   int32            `json:"sampleEvery"` // frames between snapshots
	UnitDefs      map[int32]string `json:"unitDefs"`
	Teams         []TeamInfo       `json:"teams"`
}

// Writer is the pluggable persistence boundary. Callers must call WriteMeta
// exactly once before any WriteFrame/WriteEvent, and Close exactly once at the
// end. Implementations need not be safe for concurrent use.
type Writer interface {
	WriteMeta(Meta) error
	WriteFrame(Frame) error
	WriteEvent(Event) error
	Close() error
}
