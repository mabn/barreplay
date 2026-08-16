// Command favicon rasterizes worker/public/favicon.svg into
// worker/public/favicon.ico.
//
// The SVG is the tab icon everywhere that takes one (~95% of browsers). The
// .ico exists for the rest, and for everything that requests /favicon.ico of
// its own accord without reading any markup — crawlers, feed readers, bookmark
// tools. It is a DERIVED file: run this after editing the SVG, or the two
// drift and the .ico keeps showing the old icon forever.
//
//	go run ./tools/favicon worker/public/favicon.svg worker/public/favicon.ico
//
// There is no SVG rasterizer in the standard library and this repo takes no
// third-party dependencies, so it drives the headless Chromium that is already
// on the box (the one Playwright uses; $CHROME overrides). Chromium refuses to
// render into a 16px window and its --default-background-color=00000000 makes
// the whole capture transparent, content included, so neither the target size
// nor the alpha can be had directly: the SVG is rendered large, TWICE — once
// on white, once on black — and the alpha recovered from the pair
// (Cw = C·a + (1-a), Cb = C·a, so a = 1 - (Cw - Cb) and C = Cb/a). That also
// keeps this correct if the SVG ever stops being monochrome. The large render
// is then box-filtered down to each icon size, which antialiases better than
// asking Chromium for a 16px one.
package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// renderPx is the size the SVG is rasterized at before downsampling; the window
// is larger because Chromium will not lay out into a viewport this tight.
const renderPx = 192

// sizes are the images packed into the .ico, largest first.
var sizes = []int{48, 32, 16}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: favicon <in.svg> <out.ico>")
		os.Exit(2)
	}
	svg, err := os.ReadFile(os.Args[1])
	if err != nil {
		die(err)
	}
	chrome, err := findChrome()
	if err != nil {
		die(err)
	}
	tmp, err := os.MkdirTemp("", "favicon-")
	if err != nil {
		die(err)
	}
	defer os.RemoveAll(tmp)

	onWhite, err := shoot(chrome, tmp, svg, "#fff", "white")
	if err != nil {
		die(err)
	}
	onBlack, err := shoot(chrome, tmp, svg, "#000", "black")
	if err != nil {
		die(err)
	}
	full := unmatte(onWhite, onBlack)

	var payloads [][]byte
	for _, s := range sizes {
		var buf bytes.Buffer
		if err := png.Encode(&buf, downsample(full, s)); err != nil {
			die(err)
		}
		payloads = append(payloads, buf.Bytes())
	}
	if err := os.WriteFile(os.Args[2], packICO(payloads), 0o644); err != nil {
		die(err)
	}
	fmt.Fprintf(os.Stderr, "%s: %v from %s\n", os.Args[2], sizes, os.Args[1])
}

// shoot renders the SVG at renderPx over an opaque background and returns the
// top-left renderPx square of the capture.
func shoot(chrome, tmp string, svg []byte, bg, tag string) (image.Image, error) {
	s := string(svg)
	s = regexp.MustCompile(`width="\d+"`).ReplaceAllString(s, fmt.Sprintf(`width="%d"`, renderPx))
	s = regexp.MustCompile(`height="\d+"`).ReplaceAllString(s, fmt.Sprintf(`height="%d"`, renderPx))
	html := filepath.Join(tmp, tag+".html")
	page := "<!doctype html><meta charset=\"utf-8\"><style>html,body{margin:0;padding:0;background:" +
		bg + "}svg{display:block}</style>" + strings.TrimSpace(s)
	if err := os.WriteFile(html, []byte(page), 0o644); err != nil {
		return nil, err
	}
	shot := filepath.Join(tmp, tag+".png")
	cmd := exec.Command(chrome, "--headless=new", "--disable-gpu", "--no-sandbox",
		"--hide-scrollbars", "--force-device-scale-factor=1",
		fmt.Sprintf("--window-size=%d,%d", renderPx+64, renderPx+64),
		"--screenshot="+shot, "file://"+html)
	if out, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("chromium: %w: %s", err, out)
	}
	f, err := os.Open(shot)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		return nil, err
	}
	b := img.Bounds()
	return img.(interface {
		SubImage(image.Rectangle) image.Image
	}).SubImage(image.Rect(b.Min.X, b.Min.Y, b.Min.X+renderPx, b.Min.Y+renderPx)), nil
}

// unmatte recovers straight RGBA from the same image composited over white and
// over black. Per channel Cw = C·a + (1-a) and Cb = C·a, so a = 1 - (Cw - Cb).
func unmatte(onWhite, onBlack image.Image) *image.NRGBA {
	b := onWhite.Bounds()
	out := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	for y := 0; y < b.Dy(); y++ {
		for x := 0; x < b.Dx(); x++ {
			wr, wg, wb, _ := onWhite.At(b.Min.X+x, b.Min.Y+y).RGBA()
			br, bg, bb, _ := onBlack.At(b.Min.X+x, b.Min.Y+y).RGBA()
			// Average the three channels' estimates: they agree in theory, and
			// averaging absorbs the odd rounding difference between renders.
			a := 1 - (float64(wr-br)+float64(wg-bg)+float64(wb-bb))/3/65535
			a = math.Max(0, math.Min(1, a))
			if a < 1.0/512 {
				continue // fully transparent; leave the zero pixel
			}
			c := func(v uint32) uint8 {
				return uint8(math.Round(math.Max(0, math.Min(1, float64(v)/65535/a)) * 255))
			}
			out.SetNRGBA(x, y, color.NRGBA{c(br), c(bg), c(bb), uint8(math.Round(a * 255))})
		}
	}
	return out
}

// downsample box-filters to size, averaging in PREMULTIPLIED space so the
// colour of a transparent pixel cannot bleed into its neighbours.
func downsample(src *image.NRGBA, size int) *image.NRGBA {
	out := image.NewNRGBA(image.Rect(0, 0, size, size))
	step := float64(src.Bounds().Dx()) / float64(size)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var rs, gs, bs, as, n float64
			for sy := int(float64(y) * step); sy < int(float64(y+1)*step); sy++ {
				for sx := int(float64(x) * step); sx < int(float64(x+1)*step); sx++ {
					c := src.NRGBAAt(sx, sy)
					a := float64(c.A) / 255
					rs += float64(c.R) * a
					gs += float64(c.G) * a
					bs += float64(c.B) * a
					as += a
					n++
				}
			}
			if n == 0 || as == 0 {
				continue
			}
			out.SetNRGBA(x, y, color.NRGBA{
				uint8(math.Round(rs / as)), uint8(math.Round(gs / as)), uint8(math.Round(bs / as)),
				uint8(math.Round(as / n * 255)),
			})
		}
	}
	return out
}

// packICO wraps PNG payloads in an ICONDIR. PNG-in-ICO is valid since Vista and
// is what every client that still asks for a .ico understands.
func packICO(payloads [][]byte) []byte {
	var ico bytes.Buffer
	binary.Write(&ico, binary.LittleEndian, [3]uint16{0, 1, uint16(len(payloads))})
	offset := 6 + 16*len(payloads)
	for i, s := range sizes {
		// 0 means 256 in an ICONDIRENTRY; none of our sizes reach it.
		ico.Write([]byte{uint8(s), uint8(s), 0, 0})
		binary.Write(&ico, binary.LittleEndian, [2]uint16{1, 32})
		binary.Write(&ico, binary.LittleEndian, uint32(len(payloads[i])))
		binary.Write(&ico, binary.LittleEndian, uint32(offset))
		offset += len(payloads[i])
	}
	for _, p := range payloads {
		ico.Write(p)
	}
	return ico.Bytes()
}

// findChrome locates a Chromium to rasterize with: $CHROME, then the browser
// Playwright installs for this repo's screenshot testing, then $PATH.
func findChrome() (string, error) {
	if p := os.Getenv("CHROME"); p != "" {
		return p, nil
	}
	root := os.Getenv("PLAYWRIGHT_BROWSERS_PATH")
	if root == "" {
		root = "/opt/pw-browsers"
	}
	if m, _ := filepath.Glob(filepath.Join(root, "chromium-*/chrome-linux/chrome")); len(m) > 0 {
		return m[0], nil
	}
	for _, n := range []string{"chromium", "chromium-browser", "google-chrome"} {
		if p, err := exec.LookPath(n); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("no chromium found (set $CHROME)")
}

func die(err error) {
	fmt.Fprintln(os.Stderr, "favicon:", err)
	os.Exit(1)
}
