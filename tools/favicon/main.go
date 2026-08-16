// Command favicon regenerates worker/public/favicon.{ico,png} from one of the
// vendored BAR unit icons.
//
// The tab icon is BAR's T2 air icon turned 90° clockwise: the fuselage
// triangle then points right and reads as a play button, while the tail bays
// keep it recognisably a unit icon rather than a generic media glyph. The
// bitmap is a grayscale luminance mask (the same thing the viewer team-tints,
// see internal/viz/icons.go), so it is tinted with the app's accent and
// composited on the app's own ground colour.
//
// Regenerate with:
//
//	go run ./tools/favicon worker/public/icons/air_t2.png worker/public
//
// The vendored bitmap is the source of truth; there is deliberately no second,
// hand-traced copy of the shape to keep in sync with it. Output is the .ico
// (16/32/48, PNG payloads) a browser requests on its own from /favicon.ico,
// plus a 180px .png for apple-touch-icon.
package main

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
)

const radius = 7.0 // in 32-unit space

func inRoundRect(x, y float64) bool {
	cx := math.Max(radius, math.Min(32-radius, x))
	cy := math.Max(radius, math.Min(32-radius, y))
	if (x >= radius && x <= 32-radius) || (y >= radius && y <= 32-radius) {
		return true
	}
	return math.Hypot(x-cx, y-cy) <= radius
}

var src image.Image

// Margins around the icon, in 32-unit space. The LEFT one is deliberately the
// largest: the shape is a triangle pointing right, so its area sits toward the
// flat left edge while its silhouette reaches furthest right. Centring the
// bounding box therefore looks left-heavy, and the fix is to give the flat
// side more room than the point.
const (
	marginL = 5.4
	marginR = 3.2
	marginY = 3.6
)

// Content bounds of the rotated icon, in normalized 0..1 rotated coordinates.
// Taken from what is actually opaque rather than assumed: the source bitmaps
// carry their own transparent padding, and a fixed inset centres that padding
// instead of the aircraft.
var u0, u1, v0, v1 float64

// placement is where those bounds land in 32-space, scaled uniformly (never
// stretched) to fit between the margins.
var boxX, boxY, boxW, boxH float64

func measure() {
	b := src.Bounds()
	minX, minY, maxX, maxY := b.Max.X, b.Max.Y, b.Min.X, b.Min.Y
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			if _, _, _, a := src.At(x, y).RGBA(); a > 0x2000 {
				minX, minY = min(minX, x), min(minY, y)
				maxX, maxY = max(maxX, x), max(maxY, y)
			}
		}
	}
	fx := func(x int) float64 { return float64(x-b.Min.X) / float64(b.Dx()-1) }
	fy := func(y int) float64 { return float64(y-b.Min.Y) / float64(b.Dy()-1) }
	// Rotate 90° CW: dst u = 1 - srcY, dst v = srcX.
	u0, u1 = 1-fy(maxY), 1-fy(minY)
	v0, v1 = fx(minX), fx(maxX)

	availW, availH := 32-marginL-marginR, 32-2*marginY
	// Aspect of the content in dst orientation, in source pixels.
	cw, ch := float64(maxY-minY+1), float64(maxX-minX+1)
	scale := math.Min(availW/cw, availH/ch)
	boxW, boxH = cw*scale, ch*scale
	boxX = marginL + (availW-boxW)/2
	boxY = marginY + (availH-boxH)/2
}

// sample returns the rotated icon's (luminance, alpha) at 32-space coords.
func sample(x, y float64) (float64, float64) {
	fu, fv := (x-boxX)/boxW, (y-boxY)/boxH
	if fu < 0 || fu > 1 || fv < 0 || fv > 1 {
		return 0, 0
	}
	u := u0 + fu*(u1-u0)
	v := v0 + fv*(v1-v0)
	b := src.Bounds()
	// Rotate 90° CW: dst(u,v) <- src(u' = v, v' = 1-u)
	sx := b.Min.X + int(v*float64(b.Dx()-1)+0.5)
	sy := b.Min.Y + int((1-u)*float64(b.Dy()-1)+0.5)
	r, g, bb, a := src.At(sx, sy).RGBA()
	lum := float64(r+g+bb) / 3 / 65535
	return lum, float64(a) / 65535
}

func render(size int) *image.NRGBA {
	const ss = 6
	accent := [3]float64{0xff, 0x10, 0x05}
	ground := [3]float64{0x11, 0x15, 0x1a}
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	scale := 32.0 / float64(size)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var acc [3]float64
			var alpha float64
			for sy := 0; sy < ss; sy++ {
				for sx := 0; sx < ss; sx++ {
					px := (float64(x) + (float64(sx)+0.5)/ss) * scale
					py := (float64(y) + (float64(sy)+0.5)/ss) * scale
					if !inRoundRect(px, py) {
						continue
					}
					lum, a := sample(px, py)
					var c [3]float64
					for i := 0; i < 3; i++ { // tint the mask, over the ground
						c[i] = ground[i]*(1-a) + accent[i]*lum*a
					}
					for i := 0; i < 3; i++ {
						acc[i] += c[i]
					}
					alpha += 1
				}
			}
			n := float64(ss * ss)
			if alpha > 0 {
				img.SetNRGBA(x, y, color.NRGBA{
					uint8(math.Round(acc[0] / alpha)),
					uint8(math.Round(acc[1] / alpha)),
					uint8(math.Round(acc[2] / alpha)),
					uint8(math.Round(alpha / n * 255)),
				})
			}
		}
	}
	return img
}

func main() {
	f, _ := os.Open(os.Args[1])
	var err error
	src, err = png.Decode(f)
	if err != nil {
		panic(err)
	}
	f.Close()
	measure()
	out := os.Args[2]

	var b bytes.Buffer
	png.Encode(&b, render(180))
	os.WriteFile(out+"/favicon.png", b.Bytes(), 0o644)

	sizes := []int{16, 32, 48}
	var payloads [][]byte
	for _, s := range sizes {
		var buf bytes.Buffer
		png.Encode(&buf, render(s))
		payloads = append(payloads, buf.Bytes())
	}
	var ico bytes.Buffer
	binary.Write(&ico, binary.LittleEndian, [3]uint16{0, 1, uint16(len(sizes))})
	offset := 6 + 16*len(sizes)
	for i, s := range sizes {
		ico.Write([]byte{uint8(s), uint8(s), 0, 0})
		binary.Write(&ico, binary.LittleEndian, [2]uint16{1, 32})
		binary.Write(&ico, binary.LittleEndian, uint32(len(payloads[i])))
		binary.Write(&ico, binary.LittleEndian, uint32(offset))
		offset += len(payloads[i])
	}
	for _, p := range payloads {
		ico.Write(p)
	}
	os.WriteFile(out+"/favicon.ico", ico.Bytes(), 0o644)
}
