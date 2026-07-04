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
}

// Engine is a resolved, launch-ready engine.
type Engine struct {
	cfg           Config
	headlessPath  string
	prdPath       string
	engineCfgPath string // set by WriteEngineConfig; passed to the engine as --config
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
	e := &Engine{cfg: cfg}

	var err error
	e.headlessPath, err = findBinary(cfg.EngineBinary, cfg.DataDir, engineVersion, headlessName())
	if err != nil {
		return nil, fmt.Errorf("engine: locate %s: %w", headlessName(), err)
	}
	if !cfg.SkipProvision {
		// pr-downloader usually sits beside the engine binary.
		if p, perr := findBinary(cfg.PRDownloaderBinary, cfg.DataDir, engineVersion, prdName()); perr == nil {
			e.prdPath = p
		}
	}
	return e, nil
}

// findBinary applies the search order described on Locate.
func findBinary(override, dataDir, version, name string) (string, error) {
	if override != "" {
		if fileExists(override) {
			return override, nil
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
			return c, nil
		}
	}
	if p, err := exec.LookPath(name); err == nil {
		return p, nil
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

	// pr-downloader re-queries (and can re-download) content on every call even when
	// it is already installed, so remember what we've fetched into this data dir and
	// skip repeat work. -force-provision bypasses the cache.
	pc := e.loadProvisioned()

	if e.cfg.GameOverride == "" && !e.cfg.ForceProvision && pc.Games[gameVersion] {
		fmt.Fprintf(os.Stderr, "engine: game %q already provisioned; skipping (use -force-provision to refetch)\n", gameVersion)
	} else {
		game := e.cfg.GameOverride
		if game == "" {
			// A replay pins one exact game build. Resolve the demo's game springname to
			// its precise rapid tag ("byar:git:<sha>") so pr-downloader fetches that build
			// and not the moving byar:test — otherwise the engine aborts because the
			// dependent archive the demo requires is not installed.
			game = gameVersion
			if tag, ok := e.resolveRapidGameTag(ctx, gameVersion); ok {
				fmt.Fprintf(os.Stderr, "engine: resolved game %q -> rapid tag %s\n", gameVersion, tag)
				game = tag
			} else {
				fmt.Fprintf(os.Stderr, "engine: could not resolve a rapid tag for %q; passing it to pr-downloader as-is\n", gameVersion)
			}
		}
		// Provisioning is best-effort: a download failure should not abort a run whose
		// content is already installed — the engine surfaces a clear error later if
		// something is genuinely missing.
		if game != "" {
			fmt.Fprintf(os.Stderr, "engine: ensuring game %q via pr-downloader...\n", game)
			if err := e.runPRD(ctx, "--download-game", game); err != nil {
				fmt.Fprintf(os.Stderr, "engine: warning: could not fetch game %q: %v (continuing; it may already be installed)\n", game, err)
			} else if e.cfg.GameOverride == "" {
				pc.Games[gameVersion] = true
				e.saveProvisioned(pc)
			}
		}
	}

	if e.cfg.MapOverride == "" && !e.cfg.ForceProvision && pc.Maps[mapName] {
		fmt.Fprintf(os.Stderr, "engine: map %q already provisioned; skipping (use -force-provision to refetch)\n", mapName)
	} else {
		m := e.cfg.MapOverride
		if m == "" {
			m = mapName
		}
		if m != "" {
			fmt.Fprintf(os.Stderr, "engine: ensuring map %q via pr-downloader...\n", m)
			if err := e.runPRD(ctx, "--download-map", m); err != nil {
				fmt.Fprintf(os.Stderr, "engine: warning: could not fetch map %q: %v (continuing; it may already be installed)\n", m, err)
			} else if e.cfg.MapOverride == "" {
				pc.Maps[mapName] = true
				e.saveProvisioned(pc)
			}
		}
	}
	return nil
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

	wait := func() error {
		err := cmd.Wait()
		pr.Close()
		return err
	}
	return pr, wait, nil
}

// HeadlessPath reports the resolved engine binary (for logging).
func (e *Engine) HeadlessPath() string { return e.headlessPath }
