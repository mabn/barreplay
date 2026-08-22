// Package engine locates the Recoil headless engine, provisions the content a
// replay needs (hybrid: reuse what's installed, download the rest via
// pr-downloader), injects the snapshot widget, and launches a replay.
//
// The engine must match the version the replay was recorded with or the
// deterministic re-simulation desyncs; callers pass the replay's engineVersion.
package engine

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/mabn/barreplay/assets"
)

// pr-downloader defaults to springrts.com for both rapid (games/mods) and the
// HTTP map search, but that host has little/no BAR content. Point both at BAR's
// infrastructure unless the caller overrides them (via -rapid-repo or pre-set
// PRD_RAPID_REPO_MASTER / PRD_HTTP_SEARCH_URL). Games come from the rapid repo;
// maps come from the springfiles-compatible search endpoint.
const (
	barRapidRepoMaster = "https://repos.beyondallreason.dev/repos.gz"
	barMapSearchURL    = "https://files-cdn.beyondallreason.dev/find"
)

// Config describes where BAR content lives and how to launch the engine.
type Config struct {
	// DataDir is the BAR/Spring data directory (contains engine/, games/, maps/,
	// and is used as --write-dir). Required.
	DataDir string
	// EngineBinary, if set, overrides auto-location of spring-headless.
	EngineBinary string
	// PRDownloaderBinary, if set, overrides auto-location of pr-downloader.
	PRDownloaderBinary string
	// SampleEvery is the widget sampling interval in sim frames (default 30).
	SampleEvery int
	// SkipProvision disables all pr-downloader calls (assume content present).
	SkipProvision bool
	// ForceProvision re-runs pr-downloader even for content already recorded in the
	// provisioned-content cache (see EnsureContent).
	ForceProvision bool
	// GameOverride / MapOverride force the pr-downloader game/map identifiers
	// instead of deriving them from the replay (the rapid-tag mapping is
	// best-effort; these are the escape hatch).
	GameOverride string
	MapOverride  string
	// RapidRepoMaster overrides the pr-downloader rapid master repo URL. Empty
	// uses barRapidRepoMaster.
	RapidRepoMaster string
	// SnapshotStreamPath is the absolute path the widget writes its BRSNAP stream
	// to (substituted into the Lua). Required for a real run; the tool reads this
	// file back through capture after the engine exits.
	SnapshotStreamPath string
	// Profile makes the widget enable the engine's internal time profiler
	// ("debug 1 0": collection on, overlay drawer off), unlocking the fine-grained
	// Sim::* sub-scope records and per-heartbeat PROFD samples. Small overhead.
	Profile bool
	// DisableWidgets makes the snapshot widget turn off BAR's default widget suite
	// at the first sim frame (unsynced-only overhead; cannot affect the replay).
	DisableWidgets bool
	// ThrottleDraw lowers the engine's draw pacing to ~1 fps for the run via the
	// MinDrawFPS/MinSimDrawBalance springsettings (injected through a
	// barreplay-owned config file; the user's springsettings.cfg is not touched).
	ThrottleDraw bool
	// WorkerThreads, when non-nil, overrides the engine's WorkerThreadCount
	// springsetting for this run (-1 = auto, 0/1 = no worker threads). It only
	// changes local task scheduling, so it cannot desync the replay. Nil leaves
	// the user's/engine's own setting in effect.
	WorkerThreads *int
}

// Engine is a resolved, launch-ready engine.
type Engine struct {
	cfg           Config
	headlessPath  string
	prdPath       string
	engineCfgPath string // set by WriteEngineConfig; passed to the engine as --config
	pid           int    // set by Run; see Pid
}

func headlessName() string {
	if runtime.GOOS == "windows" {
		return "spring-headless.exe"
	}
	return "spring-headless"
}

func prdName() string {
	if runtime.GOOS == "windows" {
		return "pr-downloader.exe"
	}
	return "pr-downloader"
}

// Locate resolves the headless engine (and pr-downloader when provisioning is
// enabled) for the given recorded engine version. It searches, in order: an
// explicit override, then <DataDir>/engine/<version>/, then <DataDir>/engine/*,
// then $PATH.
func Locate(cfg Config, engineVersion string) (*Engine, error) {
	if cfg.DataDir == "" {
		return nil, fmt.Errorf("engine: DataDir is required")
	}
	if cfg.SampleEvery <= 0 {
		cfg.SampleEvery = 30
	}
	// Absolute from here on. Run pins the engine's working directory to DataDir
	// (the widget can only write a relative path, resolved against the
	// write-dir), so a relative DataDir would be re-resolved against ITSELF by
	// the child: `-data .bardata` made exec look for .bardata/.bardata/engine/…
	// and fail with a "no such file or directory" naming a path that plainly
	// exists, because the existence check here runs against the parent's cwd.
	// The same doubling hit the --write-dir argument.
	absData, err := filepath.Abs(cfg.DataDir)
	if err != nil {
		return nil, fmt.Errorf("engine: resolve data dir %q: %w", cfg.DataDir, err)
	}
	cfg.DataDir = absData
	e := &Engine{cfg: cfg}

	e.headlessPath, err = findBinary(cfg.EngineBinary, cfg.DataDir, engineVersion, headlessName())
	if err != nil {
		return nil, fmt.Errorf("engine: locate %s: %w", headlessName(), err)
	}
	// findBinary falls back to any engine dir / $PATH, which is right for an
	// install that suffixes the version ("<ver> bar") but wrong when the build
	// simply is not there: the re-sim is deterministic only against the engine
	// the demo was recorded on, so running the wrong one desyncs within seconds
	// and yields a capture that looks fine and describes a game that never
	// happened. Refuse instead. An explicit -engine is the operator's call, so
	// it only warns.
	if engineVersion != "" {
		banner, verr := engineBannerVersion(e.headlessPath)
		got, parsed := parseEngineVersion(banner)
		switch {
		case verr != nil:
			fmt.Fprintf(os.Stderr, "engine: warning: could not check %s version (%v); assuming it matches %s\n",
				e.headlessPath, verr, engineVersion)
		case !parsed:
			// An unfamiliar banner is not evidence of a mismatch.
			fmt.Fprintf(os.Stderr, "engine: warning: no version in %s --version output; assuming it matches %s\n",
				e.headlessPath, engineVersion)
		case engineVersionMatches(got, engineVersion):
			// Match.
		case cfg.EngineBinary != "":
			fmt.Fprintf(os.Stderr, "engine: WARNING: -engine %s is %s but the demo needs %s; the re-sim will desync\n",
				e.headlessPath, got, engineVersion)
		default:
			return nil, fmt.Errorf("engine: %s is %s but this replay needs exactly %s — "+
				"re-simulating on a different build desyncs and produces a capture of a game that never happened; "+
				"install it under %s (provisioning does this automatically unless -no-provision is set)",
				e.headlessPath, got, engineVersion,
				filepath.Join(cfg.DataDir, "engine", engineVersion))
		}
	}
	if !cfg.SkipProvision {
		// pr-downloader usually sits beside the engine binary.
		if p, perr := findBinary(cfg.PRDownloaderBinary, cfg.DataDir, engineVersion, prdName()); perr == nil {
			e.prdPath = p
		}
	}
	return e, nil
}

// findBinary applies the search order described on Locate. Every path it
// returns is absolute — see the note in Locate: the child runs with its
// working directory set to DataDir, so a relative binary path would be
// resolved against that instead of the cwd this function checked it under.
func findBinary(override, dataDir, version, name string) (string, error) {
	if override != "" {
		if fileExists(override) {
			return filepath.Abs(override)
		}
		return "", fmt.Errorf("override %q not found", override)
	}
	candidates := []string{
		filepath.Join(dataDir, "engine", version, name),
	}
	// Any engine subdir (some installs suffix the version, e.g. "<ver> bar").
	if entries, err := os.ReadDir(filepath.Join(dataDir, "engine")); err == nil {
		for _, ent := range entries {
			if ent.IsDir() {
				candidates = append(candidates, filepath.Join(dataDir, "engine", ent.Name(), name))
			}
		}
	}
	for _, c := range candidates {
		if fileExists(c) {
			return filepath.Abs(c)
		}
	}
	if p, err := exec.LookPath(name); err == nil {
		return filepath.Abs(p)
	}
	return "", fmt.Errorf("not found under %s/engine or $PATH", dataDir)
}

func fileExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && !fi.IsDir()
}

// EnsureContent downloads the game and map if provisioning is enabled and a
// pr-downloader binary was found. Missing content is fetched into DataDir. This is
// best-effort: on real installs the content is usually already present (the demo's
// engine/game/map came from a normal client), so this is a no-op. Errors from
// pr-downloader are returned so the caller can decide whether to proceed.
func (e *Engine) EnsureContent(ctx context.Context, gameVersion, mapName string) error {
	if e.cfg.SkipProvision {
		return nil
	}
	if e.prdPath == "" {
		fmt.Fprintln(os.Stderr, "engine: pr-downloader not found; skipping provisioning (assuming game/map are installed)")
		return nil
	}

	// Resolve the game to its precise rapid tag + package md5. A replay pins one exact
	// build; resolving to "byar:git:<sha>" makes pr-downloader fetch that build and not
	// the moving byar:test (which would leave the engine unable to find the dependent
	// archive). The md5 lets us check whether the package is already installed.
	game := e.cfg.GameOverride
	var gameMD5 string
	if game == "" {
		game = gameVersion
		if tag, md5, ok := e.resolveRapidGameTag(ctx, gameVersion); ok {
			fmt.Fprintf(os.Stderr, "engine: resolved game %q -> rapid tag %s\n", gameVersion, tag)
			game, gameMD5 = tag, md5
		} else {
			fmt.Fprintf(os.Stderr, "engine: could not resolve a rapid tag for %q; passing it to pr-downloader as-is\n", gameVersion)
		}
	}
	// Provisioning is best-effort: a download failure should not abort a run whose
	// content is already installed — the engine surfaces a clear error later if
	// something is genuinely missing. pr-downloader re-queries/re-downloads even when
	// content is present, so skip it when we can see the content on disk already: a
	// rapid game is a finalized packages/<md5>.sdp, a map an archive in maps/.
	if game != "" {
		if !e.cfg.ForceProvision && e.cfg.GameOverride == "" && e.gameInstalled(gameMD5) {
			fmt.Fprintf(os.Stderr, "engine: game %q already installed (packages/%s.sdp); skipping download\n", gameVersion, gameMD5)
		} else {
			fmt.Fprintf(os.Stderr, "engine: ensuring game %q via pr-downloader...\n", game)
			if err := e.runPRD(ctx, "--download-game", game); err != nil {
				fmt.Fprintf(os.Stderr, "engine: warning: could not fetch game %q: %v (continuing; it may already be installed)\n", game, err)
			}
		}
	}

	m := e.cfg.MapOverride
	if m == "" {
		m = mapName
	}
	if m != "" {
		if !e.cfg.ForceProvision && e.cfg.MapOverride == "" && e.mapInstalled(mapName) {
			fmt.Fprintf(os.Stderr, "engine: map %q already installed; skipping download\n", mapName)
		} else {
			fmt.Fprintf(os.Stderr, "engine: ensuring map %q via pr-downloader...\n", m)
			if err := e.runPRD(ctx, "--download-map", m); err != nil {
				fmt.Fprintf(os.Stderr, "engine: warning: could not fetch map %q: %v (continuing; it may already be installed)\n", m, err)
			}
		}
	}
	return nil
}

// gameInstalled reports whether the rapid game package <md5>.sdp is finalized in the
// data dir (an unfinished download leaves only <md5>.sdp.incomplete, which the engine
// ignores). Empty md5 (rapid resolution failed) -> false, so we still try to fetch.
func (e *Engine) gameInstalled(md5 string) bool {
	return md5 != "" && fileExists(filepath.Join(e.cfg.DataDir, "packages", md5+".sdp"))
}

// mapInstalled reports whether a map archive for springname is present in <data>/maps.
// BAR maps are named after a normalized springname (lowercase, spaces -> underscores,
// e.g. "Hooked 1.1.1" -> hooked_1.1.1.sd7), matched case-insensitively. A miss just
// means we ask pr-downloader (no worse than before), so a false negative is harmless.
func (e *Engine) mapInstalled(springname string) bool {
	want := strings.ToLower(strings.ReplaceAll(springname, " ", "_"))
	entries, err := os.ReadDir(filepath.Join(e.cfg.DataDir, "maps"))
	if err != nil {
		return false
	}
	for _, ent := range entries {
		if ent.IsDir() {
			continue
		}
		name := ent.Name()
		ext := strings.ToLower(filepath.Ext(name))
		if ext != ".sd7" && ext != ".sdz" {
			continue
		}
		if strings.ToLower(name[:len(name)-len(ext)]) == want {
			return true
		}
	}
	return false
}

func (e *Engine) runPRD(ctx context.Context, args ...string) error {
	full := append([]string{"--filesystem-writepath", e.cfg.DataDir}, args...)
	cmd := exec.CommandContext(ctx, e.prdPath, full...)
	cmd.Env = e.prdEnv()
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	return cmd.Run()
}

// prdEnv returns the environment for pr-downloader, ensuring BAR's rapid repo
// (games) and map search endpoint are configured. Any value already present in
// the environment wins, so users behind proxies can still tune pr-downloader
// (e.g. PRD_RAPID_USE_STREAMER, PRD_SSL_CERT_FILE) freely.
func (e *Engine) prdEnv() []string {
	env := os.Environ()
	setDefault := func(key, val string) {
		prefix := key + "="
		for _, kv := range env {
			if strings.HasPrefix(kv, prefix) {
				return // caller's environment already sets it
			}
		}
		env = append(env, prefix+val)
	}
	repo := e.cfg.RapidRepoMaster
	if repo == "" {
		repo = barRapidRepoMaster
	}
	setDefault("PRD_RAPID_REPO_MASTER", repo)
	setDefault("PRD_HTTP_SEARCH_URL", barMapSearchURL)
	// The rapid "streamer" bundles pool files into one stream; it is faster but
	// flaky (notably on WSL and behind proxies), where it stalls mid-pool and
	// leaves a "<md5>.sdp.incomplete" the engine ignores — so the game archive is
	// reported "not found" even though pr-downloader exits 0. Default it off so
	// pool files download individually over HTTP (slower, reliable). Set
	// PRD_RAPID_USE_STREAMER=true in the environment to opt back into the streamer.
	setDefault("PRD_RAPID_USE_STREAMER", "false")
	return env
}

// WriteWidget writes the snapshot widget (with SampleEvery substituted) into
// <DataDir>/LuaUI/Widgets/ and best-effort seeds a widget config that enables it,
// so it runs unattended in headless mode. Returns the widget path.
func (e *Engine) WriteWidget() (string, error) {
	widgetsDir := filepath.Join(e.cfg.DataDir, "LuaUI", "Widgets")
	if err := os.MkdirAll(widgetsDir, 0o755); err != nil {
		return "", err
	}
	src := strings.ReplaceAll(assets.SnapshotWidgetLua, "__SAMPLE_EVERY__", fmt.Sprint(e.cfg.SampleEvery))
	src = strings.ReplaceAll(src, "__OUTPUT_PATH__", luaEscapeString(e.cfg.SnapshotStreamPath))
	src = strings.ReplaceAll(src, "__PROFILE__", boolToken(e.cfg.Profile))
	src = strings.ReplaceAll(src, "__DISABLE_WIDGETS__", boolToken(e.cfg.DisableWidgets))
	widgetPath := filepath.Join(widgetsDir, "snapshot_widget.lua")
	if err := os.WriteFile(widgetPath, []byte(src), 0o644); err != nil {
		return "", err
	}
	return widgetPath, nil
}

// luaEscapeString escapes s for embedding inside a Lua double-quoted string
// literal (the widget's __OUTPUT_PATH__). Paths may contain spaces (harmless) but
// backslashes and quotes must be escaped.
func luaEscapeString(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return s
}

// boolToken renders a bool as the "1"/"0" the widget's Lua token comparisons use.
func boolToken(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

// WriteEngineConfig writes the barreplay-owned engine config file that Run passes
// via --config: the user's <DataDir>/springsettings.cfg (if any) merged with
// barreplay's overrides. Using a separate file leaves the user's real config
// untouched (the engine also writes runtime config changes back to whatever file
// --config names, so it must be ours). Returns the file's path.
//
// With ThrottleDraw, MinDrawFPS/MinSimDrawBalance are overridden: they govern how
// often the demo-playback loop yields from sim to draw (default: every 15 sim
// frames plus 15% of CPU time reserved for drawing), and even headless each draw
// runs the full unsynced update chain (WorldDrawer, unit/feature drawer updates).
// MinDrawFPS=1 + MinSimDrawBalance=0.001 give ~1 draw/s. Both are read once at
// engine startup (CGlobalConfig), so a config file — not a runtime Lua call — is
// the only way to set them.
func (e *Engine) WriteEngineConfig() (string, error) {
	existing, err := os.ReadFile(filepath.Join(e.cfg.DataDir, "springsettings.cfg"))
	if err != nil && !os.IsNotExist(err) {
		return "", err
	}
	overrides := map[string]string{}
	if e.cfg.ThrottleDraw {
		overrides["MinDrawFPS"] = "1"
		overrides["MinSimDrawBalance"] = "0.001"
		// Demo playback is paced by the LOCAL SERVER: LagProtection adjusts the
		// frame-release speed to hold the client's reported Sim CPU share at a
		// hardcoded target — 60% with SpeedControl=1 (default; median of client
		// CPUs) or 75% with SpeedControl=2 (max). With one local client median
		// and max are the same player, so 2 is a free ~+25% sim-speed ceiling.
		// Pacing changes when pre-recorded packets are released, never their
		// content or order, so it cannot desync the re-sim.
		overrides["SpeedControl"] = "2"
	}
	if e.cfg.WorkerThreads != nil {
		overrides["WorkerThreadCount"] = fmt.Sprint(*e.cfg.WorkerThreads)
	}
	p, err := filepath.Abs(filepath.Join(e.cfg.DataDir, "_barreplay_springsettings.cfg"))
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(p, mergeSpringSettings(existing, overrides), 0o644); err != nil {
		return "", err
	}
	e.engineCfgPath = p
	return p, nil
}

// mergeSpringSettings overlays overrides onto an existing springsettings.cfg
// ("key = value" lines): matching keys (case-insensitive) are replaced in place,
// missing ones appended in sorted order. Unrelated lines pass through untouched.
func mergeSpringSettings(existing []byte, overrides map[string]string) []byte {
	pending := map[string]string{} // lower(key) -> canonical key
	for k := range overrides {
		pending[strings.ToLower(k)] = k
	}
	var out []string
	if len(existing) > 0 {
		for _, line := range strings.Split(strings.TrimRight(string(existing), "\n"), "\n") {
			if k, _, found := strings.Cut(line, "="); found {
				lk := strings.ToLower(strings.TrimSpace(k))
				if ck, hit := pending[lk]; hit {
					out = append(out, ck+" = "+overrides[ck])
					delete(pending, lk)
					continue
				}
			}
			out = append(out, line)
		}
	}
	rest := make([]string, 0, len(pending))
	for _, ck := range pending {
		rest = append(rest, ck+" = "+overrides[ck])
	}
	sort.Strings(rest)
	out = append(out, rest...)
	if len(out) == 0 {
		return []byte{}
	}
	return []byte(strings.Join(out, "\n") + "\n")
}

// BuildStartscript writes a wrapper startscript that plays demoPath at maximum
// speed and returns its path (under DataDir). The demo carries its own map/game
// setup, so only the demofile and speed modoptions are needed.
func (e *Engine) BuildStartscript(demoPath string) (string, error) {
	abs, err := filepath.Abs(demoPath)
	if err != nil {
		return "", err
	}
	script := fmt.Sprintf(`[game]
{
	demofile = %s;
}
[modoptions]
{
	MinSpeed = 9999;
	MaxSpeed = 9999;
}
`, abs)
	scriptPath := filepath.Join(e.cfg.DataDir, "_barreplay_script.txt")
	if err := os.WriteFile(scriptPath, []byte(script), 0o644); err != nil {
		return "", err
	}
	return scriptPath, nil
}

// Run launches spring-headless on scriptPath. It returns a reader over the merged
// engine stdout+stderr (where the widget's BRSNAP lines appear) and a wait
// function that reaps the process. The caller drains the reader to EOF (the read
// end EOFs when the engine exits) via capture.Consume, then calls wait.
// Cancelling ctx kills the engine.
func (e *Engine) Run(ctx context.Context, scriptPath string) (io.Reader, func() error, error) {
	args := []string{"--isolation", "--write-dir", e.cfg.DataDir}
	if e.engineCfgPath != "" {
		args = append(args, "--config", e.engineCfgPath)
	}
	args = append(args, scriptPath)
	cmd := exec.CommandContext(ctx, e.headlessPath, args...)
	// Pin the working directory to the write-dir: the widget writes its stream via a
	// relative path (Spring's LuaIO sandbox forbids absolute paths), resolved against
	// the CWD, so this makes SnapshotStreamPath land where the tool expects to read it.
	cmd.Dir = e.cfg.DataDir

	// An os.Pipe (not io.Pipe) is passed to the child as a real fd, so the read
	// end reaches EOF on its own when the child exits — no deadlock between
	// draining and Wait.
	pr, pw, err := os.Pipe()
	if err != nil {
		return nil, nil, err
	}
	cmd.Stdout = pw
	cmd.Stderr = pw
	if err := cmd.Start(); err != nil {
		pw.Close()
		pr.Close()
		return nil, nil, fmt.Errorf("engine: start %s: %w", e.headlessPath, err)
	}
	// The parent must drop its copy of the write end so the reader can EOF once
	// the child (the only remaining writer) exits.
	pw.Close()
	e.pid = cmd.Process.Pid

	wait := func() error {
		err := cmd.Wait()
		pr.Close()
		return err
	}
	return pr, wait, nil
}

// HeadlessPath reports the resolved engine binary (for logging).
func (e *Engine) HeadlessPath() string { return e.headlessPath }

// Pid is the process id of the engine Run started, or 0 before it has. It is
// here so a caller can watch the run's resource use (SampleProcess) without Run
// growing a fourth return value; a data dir takes only one run at a time
// (LockDataDir), so there is never a second live process to confuse it with.
func (e *Engine) Pid() int { return e.pid }
