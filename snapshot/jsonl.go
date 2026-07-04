package snapshot

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// recordType tags each JSONL line so a reader can dispatch without guessing.
type recordType string

const (
	recMeta  recordType = "meta"
	recFrame recordType = "frame"
	recEvent recordType = "event"
)

// envelope is the on-disk line shape for the v1 JSONL format: a small type tag
// plus exactly one populated payload. This is deliberately verbose/readable; a
// future binary Writer can replace it entirely behind the Writer interface.
type envelope struct {
	Type  recordType `json:"type"`
	Meta  *Meta      `json:"meta,omitempty"`
	Frame *Frame     `json:"frame,omitempty"`
	Event *Event     `json:"event,omitempty"`
}

// jsonlWriter writes one JSON object per line to a file named "<gameID>.jsonl".
type jsonlWriter struct {
	f   *os.File
	w   *bufio.Writer
	enc *json.Encoder
}

// NewJSONLWriter creates dir if needed and opens "<gameID>.jsonl" for writing.
func NewJSONLWriter(dir, gameID string) (Writer, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, gameID+".jsonl")
	f, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	w := bufio.NewWriter(f)
	return &jsonlWriter{f: f, w: w, enc: json.NewEncoder(w)}, nil
}

func (jw *jsonlWriter) WriteMeta(m Meta) error {
	return jw.enc.Encode(envelope{Type: recMeta, Meta: &m})
}

func (jw *jsonlWriter) WriteFrame(fr Frame) error {
	return jw.enc.Encode(envelope{Type: recFrame, Frame: &fr})
}

func (jw *jsonlWriter) WriteEvent(e Event) error {
	return jw.enc.Encode(envelope{Type: recEvent, Event: &e})
}

func (jw *jsonlWriter) Close() error {
	if err := jw.w.Flush(); err != nil {
		jw.f.Close()
		return err
	}
	return jw.f.Close()
}

// Reader streams a JSONL capture back out. It is used by tests today and is the
// natural entry point for the future scrubbing UI.
type Reader struct {
	sc *bufio.Scanner
}

// NewReader wraps r. The caller retains ownership of r.
func NewReader(r io.Reader) *Reader {
	sc := bufio.NewScanner(r)
	// Frames with many units produce long lines; raise the token limit.
	sc.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	return &Reader{sc: sc}
}

// Next decodes the next record. Exactly one of the returned pointers is non-nil.
// It returns io.EOF when the stream is exhausted.
func (r *Reader) Next() (*Meta, *Frame, *Event, error) {
	if !r.sc.Scan() {
		if err := r.sc.Err(); err != nil {
			return nil, nil, nil, err
		}
		return nil, nil, nil, io.EOF
	}
	line := r.sc.Bytes()
	if len(line) == 0 {
		return r.Next()
	}
	var env envelope
	if err := json.Unmarshal(line, &env); err != nil {
		return nil, nil, nil, err
	}
	switch env.Type {
	case recMeta:
		return env.Meta, nil, nil, nil
	case recFrame:
		return nil, env.Frame, nil, nil
	case recEvent:
		return nil, nil, env.Event, nil
	default:
		return nil, nil, nil, fmt.Errorf("snapshot: unknown record type %q", env.Type)
	}
}
