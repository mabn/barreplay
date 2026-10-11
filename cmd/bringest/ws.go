package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
)

// A minimal RFC 6455 WebSocket client — just what the summary service needs
// to hold one connection open to the worker (summaries.go): text messages,
// ping/pong, close. The repo is stdlib-only, and the standard library has no
// WebSocket, but net/http does the hard part: a 101 response hands back the
// connection as the Body (an io.ReadWriteCloser), so TLS, proxies and the
// handshake request stay net/http's. Only the framing is here.

const (
	wsContinuation = 0x0
	wsText         = 0x1
	wsBinary       = 0x2
	wsClose        = 0x8
	wsPing         = 0x9
	wsPong         = 0xA

	// wsMaxMessage bounds what a peer can make this side buffer. The hub's
	// messages are a few hundred bytes.
	wsMaxMessage = 1 << 20
)

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

type wsConn struct {
	rw  io.ReadWriteCloser
	br  *bufio.Reader
	wmu sync.Mutex
	// mask is true on the client side, which RFC 6455 requires to mask
	// every frame it sends (and the server never to).
	mask bool
}

// wsAcceptKey is the Sec-WebSocket-Accept a server must answer key with.
func wsAcceptKey(key string) string {
	h := sha1.Sum([]byte(key + wsGUID))
	return base64.StdEncoding.EncodeToString(h[:])
}

// wsDial opens a WebSocket to an http(s) URL, sending token as a bearer
// credential. HTTP/2 is turned off for the request: a WebSocket over h2 is a
// different protocol (RFC 8441) that net/http does not speak, and an ALPN
// negotiation would otherwise pick it against Cloudflare.
func wsDial(ctx context.Context, url, token string) (*wsConn, error) {
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, err
	}
	key := base64.StdEncoding.EncodeToString(nonce[:])
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", key)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	tr := &http.Transport{
		Proxy:        http.ProxyFromEnvironment,
		TLSNextProto: map[string]func(string, *tls.Conn) http.RoundTripper{},
	}
	// No client Timeout: it would cut the connection's Body — the socket —
	// once it ran out. The handshake is bounded by ctx.
	resp, err := (&http.Client{Transport: tr}).Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		resp.Body.Close()
		return nil, fmt.Errorf("%s: %s %s", url, resp.Status, strings.TrimSpace(string(msg)))
	}
	rw, ok := resp.Body.(io.ReadWriteCloser)
	if !ok {
		resp.Body.Close()
		return nil, errors.New("upgrade response is not a connection")
	}
	if resp.Header.Get("Sec-WebSocket-Accept") != wsAcceptKey(key) {
		rw.Close()
		return nil, errors.New("server answered the upgrade with the wrong Sec-WebSocket-Accept")
	}
	return &wsConn{rw: rw, br: bufio.NewReader(rw), mask: true}, nil
}

// WriteMessage sends one whole message. Safe for concurrent use.
func (c *wsConn) WriteMessage(op byte, data []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	return wsWriteFrame(c.rw, op, data, c.mask)
}

// ReadMessage returns the next text or binary message, answering pings and
// reassembling fragments on the way. A close frame is answered and reported
// as io.EOF.
func (c *wsConn) ReadMessage() (byte, []byte, error) {
	var (
		op  byte
		msg []byte
	)
	for {
		fin, fop, payload, err := wsReadFrame(c.br)
		if err != nil {
			return 0, nil, err
		}
		switch fop {
		case wsPing:
			if err := c.WriteMessage(wsPong, payload); err != nil {
				return 0, nil, err
			}
			continue
		case wsPong:
			continue
		case wsClose:
			_ = c.WriteMessage(wsClose, payload)
			return 0, nil, io.EOF
		case wsText, wsBinary:
			if msg != nil {
				return 0, nil, errors.New("websocket: new message inside a fragmented one")
			}
			op, msg = fop, append([]byte{}, payload...)
		case wsContinuation:
			if msg == nil {
				return 0, nil, errors.New("websocket: continuation with no message")
			}
			msg = append(msg, payload...)
		default:
			return 0, nil, fmt.Errorf("websocket: unknown opcode %d", fop)
		}
		if len(msg) > wsMaxMessage {
			return 0, nil, errors.New("websocket: message too large")
		}
		if fin {
			return op, msg, nil
		}
	}
}

// Close sends a normal close frame (best effort) and drops the connection,
// which also unblocks a ReadMessage in progress.
func (c *wsConn) Close() error {
	_ = c.WriteMessage(wsClose, []byte{0x03, 0xE8}) // 1000, normal closure
	return c.rw.Close()
}

func wsWriteFrame(w io.Writer, op byte, data []byte, mask bool) error {
	hdr := make([]byte, 0, 14)
	hdr = append(hdr, 0x80|op)
	var mbit byte
	if mask {
		mbit = 0x80
	}
	switch n := len(data); {
	case n < 126:
		hdr = append(hdr, mbit|byte(n))
	case n <= 0xFFFF:
		hdr = append(hdr, mbit|126)
		hdr = binary.BigEndian.AppendUint16(hdr, uint16(n))
	default:
		hdr = append(hdr, mbit|127)
		hdr = binary.BigEndian.AppendUint64(hdr, uint64(n))
	}
	payload := data
	if mask {
		var key [4]byte
		if _, err := rand.Read(key[:]); err != nil {
			return err
		}
		hdr = append(hdr, key[:]...)
		payload = make([]byte, len(data))
		for i, b := range data {
			payload[i] = b ^ key[i&3]
		}
	}
	if _, err := w.Write(append(hdr, payload...)); err != nil {
		return err
	}
	return nil
}

func wsReadFrame(r *bufio.Reader) (fin bool, op byte, payload []byte, err error) {
	var h [2]byte
	if _, err = io.ReadFull(r, h[:]); err != nil {
		return
	}
	fin = h[0]&0x80 != 0
	op = h[0] & 0x0F
	masked := h[1]&0x80 != 0
	n := uint64(h[1] & 0x7F)
	switch n {
	case 126:
		var b [2]byte
		if _, err = io.ReadFull(r, b[:]); err != nil {
			return
		}
		n = uint64(binary.BigEndian.Uint16(b[:]))
	case 127:
		var b [8]byte
		if _, err = io.ReadFull(r, b[:]); err != nil {
			return
		}
		n = binary.BigEndian.Uint64(b[:])
	}
	if n > wsMaxMessage {
		err = errors.New("websocket: frame too large")
		return
	}
	var key [4]byte
	if masked {
		if _, err = io.ReadFull(r, key[:]); err != nil {
			return
		}
	}
	payload = make([]byte, n)
	if _, err = io.ReadFull(r, payload); err != nil {
		return
	}
	if masked {
		for i := range payload {
			payload[i] ^= key[i&3]
		}
	}
	return
}
