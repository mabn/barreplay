package capture

import "github.com/mabn/barreplay/snapshot"

// ReplaceComms returns a Writer that drops the chat and drawings the capture
// STREAM carries and writes the given ones instead, at Close.
//
// The demo file is the better source and this is how a caller prefers it: it
// holds every side's chat on every channel (the server broadcasts chat
// unfiltered and lets each client decide what to display) with the sender's
// own destination byte, and it is framed exactly, because the frame packets
// sit in the same stream. A widget can only record what its client was allowed
// to perceive, and receives chat through AddConsoleLine — flushed from the
// engine's UNSYNCED update, a path the re-sim deliberately starves, so its
// frame stamps can lag by seconds early in a game. See
// internal/demofile/comms.go.
//
// An EMPTY comms slice returns w untouched, which is deliberate: it means "the
// demo told us nothing", and a demo tells us nothing both when the game really
// was silent and when its packet stream was cut short by a crash. The two are
// indistinguishable from here, and keeping a capture's own comms is the better
// answer in the second case and harmless in the first (a game with no comms
// gives the widget nothing to record either).
func ReplaceComms(w snapshot.Writer, comms []snapshot.Comm) snapshot.Writer {
	if len(comms) == 0 {
		return w
	}
	return &commReplacer{Writer: w, comms: comms}
}

type commReplacer struct {
	snapshot.Writer
	comms []snapshot.Comm
}

func (w *commReplacer) WriteComm(snapshot.Comm) error { return nil }

func (w *commReplacer) Close() error {
	for _, c := range w.comms {
		if err := w.Writer.WriteComm(c); err != nil {
			return err
		}
	}
	return w.Writer.Close()
}

// AddEvents returns a Writer that interleaves extra events (sorted by frame)
// into the capture's own: each is written just before the first frame or
// event of the capture that comes after it, the rest at Close. It is how the
// demo's self-destruct ORDERS (demofile.Demo.SelfDEvents) join a capture:
// orders are input, which no widget sees, and the event list must stay in
// frame order for the readers that binary-search it.
func AddEvents(w snapshot.Writer, extra []snapshot.Event) snapshot.Writer {
	if len(extra) == 0 {
		return w
	}
	return &eventAdder{Writer: w, extra: extra}
}

type eventAdder struct {
	snapshot.Writer
	extra []snapshot.Event
}

func (w *eventAdder) flush(through int32) error {
	for len(w.extra) > 0 && w.extra[0].Frame <= through {
		if err := w.Writer.WriteEvent(w.extra[0]); err != nil {
			return err
		}
		w.extra = w.extra[1:]
	}
	return nil
}

func (w *eventAdder) WriteFrame(f snapshot.Frame) error {
	if err := w.flush(f.Frame - 1); err != nil {
		return err
	}
	return w.Writer.WriteFrame(f)
}

func (w *eventAdder) WriteEvent(e snapshot.Event) error {
	if err := w.flush(e.Frame); err != nil {
		return err
	}
	return w.Writer.WriteEvent(e)
}

func (w *eventAdder) Close() error {
	if err := w.flush(1<<31 - 1); err != nil {
		return err
	}
	return w.Writer.Close()
}
