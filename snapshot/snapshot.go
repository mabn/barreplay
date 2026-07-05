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
//
// Velocity is stored as three flat components (rather than a Vec3) so that an
// idle unit's zero velocity is omitted from the JSON — most units are stationary
// most of the time. BuildProgress is 1 for a finished unit and <1 while it is
// still under construction.
type UnitState struct {
	UnitID        int32   `json:"id"`
	DefID         int32   `json:"def"`
	Team          int32   `json:"team"`
	Pos           Vec3    `json:"pos"`
	Health        float32 `json:"hp"`
	MaxHealth     float32 `json:"maxHp"`
	VelX          float32 `json:"vx,omitempty"`
	VelY          float32 `json:"vy,omitempty"`
	VelZ          float32 `json:"vz,omitempty"`
	BuildProgress float32 `json:"build,omitempty"`
}

// TeamResource is one team's economy at a sampled frame: current metal/energy,
// their storage caps, and income per second. Metal and energy income are reported
// per game-second (the engine's per-frame income scaled by the 30 fps sim rate).
type TeamResource struct {
	Team          int32   `json:"team"`
	Metal         float32 `json:"metal"`
	Energy        float32 `json:"energy"`
	MetalStorage  float32 `json:"metalStorage"`
	EnergyStorage float32 `json:"energyStorage"`
	MetalIncome   float32 `json:"metalIncome"`  // per game-second
	EnergyIncome  float32 `json:"energyIncome"` // per game-second
}

// Frame is one periodic snapshot of the whole game: the position/health of every
// visible unit, plus each team's economy, at a given simulation frame.
type Frame struct {
	Frame     int32          `json:"frame"`
	TimeSec   float32        `json:"t"`
	Units     []UnitState    `json:"units"`
	Resources []TeamResource `json:"resources,omitempty"`
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
	Color      string `json:"color,omitempty"` // "#rrggbb", the team's in-game colour
}

// PlayerInfo describes a human/AI player in the replay, tied to the team it
// controls. The roster basics come from the engine's player list; the richer
// per-player metadata (flag, rank, OpenSkill "OS" rating, account id) comes from
// the demo startscript and is populated when available.
type PlayerInfo struct {
	PlayerID         int32   `json:"id"`
	Name             string  `json:"name"`
	Team             int32   `json:"team"`
	Spectator        bool    `json:"spectator,omitempty"`
	CountryCode      string  `json:"country,omitempty"` // ISO country code (flag)
	Rank             int32   `json:"rank,omitempty"`
	Skill            float32 `json:"skill,omitempty"`            // OpenSkill rating ("OS")
	SkillUncertainty float32 `json:"skillUncertainty,omitempty"` // OpenSkill sigma
	AccountID        string  `json:"accountId,omitempty"`
	Boss             bool    `json:"boss,omitempty"`
}

// UnitDef is a unit type's definition. Mods add and modify unit types, so the
// full table (not just an id->name mapping) is recorded to interpret a capture:
// the id space and stats depend on the exact game build the replay pins. All
// fields past Name are best-effort — a scope the engine build doesn't expose is
// simply omitted.
type UnitDef struct {
	DefID       int32   `json:"id"`
	Name        string  `json:"name"`
	HumanName   string  `json:"humanName,omitempty"`
	MetalCost   float32 `json:"metalCost,omitempty"`
	EnergyCost  float32 `json:"energyCost,omitempty"`
	BuildTime   float32 `json:"buildTime,omitempty"`
	MaxHealth   float32 `json:"maxHealth,omitempty"`
	Speed       float32 `json:"speed,omitempty"`
	XSize       int32   `json:"xsize,omitempty"`    // footprint width  (in 8-elmo squares)
	ZSize       int32   `json:"zsize,omitempty"`    // footprint depth  (in 8-elmo squares)
	IconType    string  `json:"iconType,omitempty"` // icontypes.lua key -> minimap/UI bitmap
	IsBuilder   bool    `json:"isBuilder,omitempty"`
	IsBuilding  bool    `json:"isBuilding,omitempty"`
	IsFactory   bool    `json:"isFactory,omitempty"`
	CanFly      bool    `json:"canFly,omitempty"`
	CanMove     bool    `json:"canMove,omitempty"`
	WeaponCount int32   `json:"weaponCount,omitempty"`
}

// Meta is written once at the start of a capture and describes the replay and
// the static data needed to interpret the frames: notably the full unit-def
// table (stable for the duration of a single game) and the player roster.
type Meta struct {
	GameID        string            `json:"gameId"`
	EngineVersion string            `json:"engineVersion"`
	GameVersion   string            `json:"gameVersion"`
	MapName       string            `json:"mapName"`
	StartUnix     int64             `json:"startUnix"`
	SampleEvery   int32             `json:"sampleEvery"` // frames between snapshots
	UnitDefs      map[int32]UnitDef `json:"unitDefs"`
	Teams         []TeamInfo        `json:"teams"`
	Players       []PlayerInfo      `json:"players,omitempty"`
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
