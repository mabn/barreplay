// Package snapshot defines the data model for recorded BAR replay state and a
// pluggable Writer interface that owns the on-disk format.
//
// The rest of the tool (engine launch, stdout capture) only ever talks to this
// package through the Writer interface, so the persistence format can be swapped
// for a columnar/binary representation later without touching the capture or
// engine code. The implementation is the .brp compact binary (see brp.go); it
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
	// TargetID is the unit this one is currently constructing, assisting or
	// repairing (Spring.GetUnitIsBuilding); 0 = none.
	TargetID int32 `json:"target,omitempty"`
}

// TeamResource is one team's economy at a sampled frame: current metal/energy,
// their storage caps, and income per second. Metal and energy income are per
// game-second, exactly as the engine reports them (GetTeamResources' income
// accumulates over TEAM_SLOWUPDATE_RATE = 30 sim frames = 1 game-second).
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

// CommKind enumerates the things a player puts into a game besides orders:
// what they wrote, and what they drew on the map.
type CommKind string

const (
	// CommChat is a typed message. Dest names the channel it went to and Text
	// is what was said; the position fields are unused.
	CommChat CommKind = "chat"
	// CommPoint is a map marker dropped at X/Z; Text is its label (frequently
	// empty — the engine's middle-click marker carries none).
	CommPoint CommKind = "point"
	// CommLine is one drawn line segment, X/Z -> X2/Z2. Freehand drawing
	// arrives as a run of these (the engine emits at most one per 50 ms of
	// dragging), so they dominate a capture's comm count.
	CommLine CommKind = "line"
	// CommErase clears every mark anchored within CommEraseRadius of X/Z.
	CommErase CommKind = "erase"
)

// Chat destinations (Comm.Dest), as the engine's console formatting reveals
// them: DestAll is public, DestAlly the "Allies:" channel, DestSpec the
// "Spectators:" one, DestPrivate a whisper (the recipient is not recoverable
// from the console line, so it is not recorded), and DestLobby a message the
// autohost relayed in from the battleroom.
const (
	DestAll     = "all"
	DestAlly    = "ally"
	DestSpec    = "spec"
	DestPrivate = "private"
	DestLobby   = "lobby"
)

// CommEraseRadius is the world radius a CommErase clears, matching the engine's
// hardcoded CInMapDrawModel::EraseNear radius — a mark is erased when its
// ANCHOR (a point's position, a line's first end) lies inside it.
const CommEraseRadius = 100

// Comm is one thing a player wrote or drew, recorded at the exact frame it
// happened (independent of the periodic sampling interval).
//
// What a capture holds is what its recorder was allowed to perceive, exactly
// like unit visibility: the engine delivers chat only on channels the client
// receives, and fires the map-draw callin only for marks it may see (its own
// ally team's, or everyone's when spectating). A re-simulated demo is watched
// by a full-view spectator, so it records every side.
type Comm struct {
	Frame int32    `json:"frame"`
	Kind  CommKind `json:"kind"`
	// PlayerID is the author; -1 when the author could not be resolved to a
	// player in the roster (a battleroom relay, a player who left), in which
	// case Name carries whatever the engine printed.
	PlayerID int32  `json:"playerId"`
	Name     string `json:"name,omitempty"`
	Dest     string `json:"dest,omitempty"` // chat only
	// Text is the message body for CommChat and the marker label for
	// CommPoint; empty otherwise.
	Text string  `json:"text,omitempty"`
	X    float32 `json:"x,omitempty"`
	Z    float32 `json:"z,omitempty"`
	X2   float32 `json:"x2,omitempty"` // CommLine: the segment's other end
	Z2   float32 `json:"z2,omitempty"`
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

// RecorderInfo identifies the client that captured a live-game stream (the
// uploader widget's GAME preamble line): whose point of view the capture
// records. A spectator recorder sees everything; a playing recorder sees its
// own ally team plus whatever the engine listed as visible enemies.
type RecorderInfo struct {
	PlayerID  int32 `json:"playerId"`
	AllyTeam  int32 `json:"allyTeam"`
	Spectator bool  `json:"spectator,omitempty"`
}

// WidgetInfo identifies the widget build that produced a capture: which
// release (Version + Date, both constants the widget bumps together) and which
// bytes (Sha, the git SHA stamped into the copy players download — see
// worker/tools/sync-assets.mjs). A player's installed copy can be arbitrarily
// old, so a stream is the only place this can be learned; the catalog stores
// it per replay.
//
// Sha is empty for a widget taken straight from the repo rather than from the
// download — the stamp is applied when the file is published, and an unstamped
// copy reports nothing rather than an SHA it cannot vouch for. Version/Date
// are empty for captures predating the fields (Date) or the whole GAME line.
type WidgetInfo struct {
	Version string `json:"version,omitempty"`
	Sha     string `json:"sha,omitempty"`
	Date    string `json:"date,omitempty"`
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
	// Recorder is set for live-game captures (the uploader widget); nil for
	// the engine re-sim pipeline, which sees the whole game.
	Recorder *RecorderInfo `json:"recorder,omitempty"`
	// Widget is the build of the uploader widget that produced the capture,
	// from the stream's GAME line. Nil for the engine re-sim pipeline (whose
	// sampler is injected by this tool, so its build is the tool's own) and
	// for streams written before the widget reported it.
	Widget *WidgetInfo `json:"widget,omitempty"`
}

// Writer is the pluggable persistence boundary. Callers must call WriteMeta
// exactly once before any WriteFrame/WriteEvent/WriteComm, and Close exactly
// once at the end. Implementations need not be safe for concurrent use.
type Writer interface {
	WriteMeta(Meta) error
	WriteFrame(Frame) error
	WriteEvent(Event) error
	WriteComm(Comm) error
	Close() error
}
