package packer

// Where a publish lands in the bucket. Every replay published since month
// folders goes under replays/<YYYY-MM>/, the UTC month the game STARTED, and
// a game's first full-view capture (a spectator's upload or a re-sim) takes
// the plain name, <gameId>.brp — the game's MAIN replay. Everything else, a
// playing client's one-sided upload or a second full view with different
// bytes, keeps the -<rev> suffix in the same folder, so nothing is ever
// overwritten. Replays published before this stay where they are (flat
// replays/<gameId>-<rev>.brp): the catalog row's rid names the exact key, so
// readers never need to know which layout a replay uses.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/mabn/barreplay/snapshot"
)

// UndatedFolder holds the replays of games whose start time nobody knows (a
// no-demo pack of a game the BAR API does not know either). A month folder is
// a claim about when the game was played, so an unknown one is not guessed —
// least of all as the upload's month.
const UndatedFolder = "undated"

// ReplayMonth is the folder for a game that started at unix seconds: its UTC
// "YYYY-MM", or "" when the time is unknown (<= 0).
func ReplayMonth(unix int64) string {
	if unix <= 0 {
		return ""
	}
	return time.Unix(unix, 0).UTC().Format("2006-01")
}

// IsMainRid reports whether rid names gameID's main replay — the unsuffixed
// one, in a month folder or (published before folders, by -rev=false) flat.
func IsMainRid(rid, gameID string) bool {
	name := rid
	if i := strings.LastIndexByte(rid, '/'); i >= 0 {
		name = rid[i+1:]
	}
	return name == gameID
}

// CapturesAllTeams says whether a capture saw every team, which is what
// entitles it to the game's main name. An explicit view from the publisher
// wins ("full" is how bringest -resim and pack -view full say so); otherwise
// the capture speaks for itself: a recorder record says whether a spectator
// or a player recorded it, and a re-sim says so in its GAME line. A capture
// that says neither is an uploader stream from before the recorder record and
// counts as one-sided — it must not take the main name on a guess.
func CapturesAllTeams(m snapshot.Meta, view string) bool {
	switch view {
	case "full":
		return true
	case "ally", "unknown":
		return false
	}
	if m.Recorder != nil {
		return m.Recorder.Spectator
	}
	return m.Resim
}

// replayFolder is the month folder a game's replays go in: from the capture's
// start time (the demo header's), else the BAR API's record of the game, else
// UndatedFolder.
func replayFolder(ctx context.Context, o UploadOptions, m snapshot.Meta) string {
	if mo := ReplayMonth(m.StartUnix); mo != "" {
		return mo
	}
	if o.BarAPI != nil && m.GameID != "" {
		r, err := o.BarAPI.Resolve(ctx, m.GameID)
		if err == nil {
			if t, err := time.Parse(time.RFC3339, r.StartTime); err == nil {
				if mo := ReplayMonth(t.Unix()); mo != "" {
					return mo
				}
			}
		}
		fmt.Fprintf(os.Stderr, "%s: no start time in the capture or the BAR API; publishing under %s/\n", m.GameID, UndatedFolder)
	}
	return UndatedFolder
}

// mainReplay is what the catalog knows about a game's existing main replay.
type mainReplay struct {
	rid string
	rev string // its content revision; "" when it was published before revs were recorded
}

// existingMain asks the catalog whether gameID already has a main replay. A
// nil result with a nil error means it has none (or no row at all). The
// catalog is the record here, never the bucket's public hostname, which
// caches 404s and could call a just-published main missing. The conditional
// PUT behind it (putIfAbsent) is what makes a wrong answer harmless.
func existingMain(ctx context.Context, indexURL, gameID string) (*mainReplay, error) {
	if indexURL == "" {
		return nil, nil
	}
	u := strings.TrimSuffix(indexURL, "/") + "/api/replays?" + url.Values{"id": {gameID}, "limit": {"2"}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return nil, fmt.Errorf("GET %s: %s: %s", u, resp.Status, strings.TrimSpace(string(msg)))
	}
	var rows []struct {
		ID      string  `json:"id"`
		Rid     *string `json:"rid"`
		Uploads []struct {
			Rid string `json:"rid"`
			Rev string `json:"rev"`
		} `json:"uploads"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rows); err != nil {
		return nil, fmt.Errorf("catalog: %w", err)
	}
	for _, row := range rows {
		if row.ID != gameID { // ?id= matches by prefix
			continue
		}
		for _, up := range row.Uploads {
			if IsMainRid(up.Rid, gameID) {
				return &mainReplay{rid: up.Rid, rev: up.Rev}, nil
			}
		}
		if row.Rid != nil && IsMainRid(*row.Rid, gameID) {
			return &mainReplay{rid: *row.Rid}, nil
		}
	}
	return nil, nil
}

// errObjectExists is a conditional PUT refused because the key is taken.
var errObjectExists = errors.New("object already exists")

// putIfAbsent writes one object only if its key is free, through whichever
// transport can say so: the native S3 client, or the dev worker's PUT route.
// supported is false when neither is in play (the node-tooling fallback has no
// conditional write); the caller then uploads unconditionally, having already
// asked the catalog. A refused write is created=false with a nil error.
func putIfAbsent(ctx context.Context, o UploadOptions, native *R2Client, key string, body []byte) (created, supported bool, err error) {
	switch {
	case native != nil:
		err = native.put(ctx, key, body, true)
	case o.Target == "local" && o.IndexURL != "":
		err = workerPut(ctx, o.IndexURL, key, body, true)
		if err != nil && !errors.Is(err, errObjectExists) {
			if ctx.Err() != nil {
				return false, true, err
			}
			// Dev server down: uploadDir falls back to wrangler for the rest,
			// and this object goes with it.
			fmt.Fprintf(os.Stderr, "conditional PUT via the dev worker failed (%v); uploading without it\n", err)
			return false, false, nil
		}
	default:
		return false, false, nil
	}
	if errors.Is(err, errObjectExists) {
		return false, true, nil
	}
	if err != nil {
		return false, true, err
	}
	fmt.Fprintf(os.Stderr, "  put %s (new main replay)\n", key)
	return true, true, nil
}
