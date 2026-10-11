package main

import "math"

// opts parameterizes the base feature set.
type opts struct {
	armyK, incK, cumK float64
	win               int  // income window, steps
	useValue          bool // value (everything owned) instead of army
	trade             bool // add cumulative metal-destroyed ratio
	tradeK            float64
	timeX             bool // add each feature times game time (min(t/T,1))
	timeT             float64
	noInc             bool    // drop last-minute income
	median            bool    // income window median instead of mean
	armyWin           int     // army averaged over this many steps (0/1 = none)
	valueAdd          bool    // add value as another feature
	skill             bool    // add the rating difference
	skillDecay        float64 // seconds; 0 = constant
	lossKeys          []string // add each side's cumulative losses of these (geo.go)
	lossK             float64
	front             int  // add the army centres' advance, averaged over this many steps
	frontW            bool // weight each side's advance by its army's size
}

func base(o opts) func(g *game) [][]float64 {
	return func(g *game) [][]float64 {
		n := g.n
		out := make([][]float64, n)
		var cum, killed [2]float64
		cl := make([][2]float64, len(o.lossKeys))
		for i := 0; i < n; i++ {
			var army, inc, val [2]float64
			for s := 0; s < 2; s++ {
				src := g.army[s]
				if o.useValue && g.value[s] != nil {
					src = g.value[s]
				}
				army[s] = winMean(src, i, o.armyWin)
				if g.value[s] != nil {
					val[s] = g.value[s][i]
				}
				cum[s] += g.inc[s][i] * step
				killed[s] += g.lost[1-s][i]
				if o.median {
					inc[s] = winMedian(g.inc[s], i, o.win)
				} else {
					inc[s] = winMean(g.inc[s], i, o.win)
				}
			}
			f := []float64{math.Log((army[0] + o.armyK) / (army[1] + o.armyK))}
			if !o.noInc {
				f = append(f, math.Log((inc[0]+o.incK)/(inc[1]+o.incK)))
			}
			f = append(f, math.Log((cum[0]+o.cumK)/(cum[1]+o.cumK)))
			if o.trade {
				f = append(f, math.Log((killed[0]+o.tradeK)/(killed[1]+o.tradeK)))
			}
			for k, key := range o.lossKeys {
				for sd := 0; sd < 2; sd++ {
					cl[k][sd] += g.lostOf(key, sd, i)
				}
				f = append(f, math.Log((cl[k][1]+o.lossK)/(cl[k][0]+o.lossK)))
			}
			if o.front > 0 {
				var a [2]float64
				for sd := 0; sd < 2; sd++ {
					if g.pos {
						a[sd] = advMean(g.adv[sd], i, o.front)
					}
					if o.frontW {
						a[sd] *= army[sd] / (army[sd] + o.armyK)
					}
				}
				f = append(f, a[0]-a[1])
			}
			if o.valueAdd {
				f = append(f, math.Log((val[0]+o.armyK)/(val[1]+o.armyK)))
			}
			if o.skill {
				sk := g.skill
				if math.IsNaN(sk) {
					sk = 0
				}
				sk /= 10
				if o.skillDecay > 0 {
					sk *= math.Exp(-g.t[i] / o.skillDecay)
				}
				f = append(f, sk)
			}
			if o.timeX {
				tau := math.Min(g.t[i]/o.timeT, 1)
				m := len(f)
				for k := 0; k < m; k++ {
					f = append(f, f[k]*tau)
				}
			}
			out[i] = f
		}
		return out
	}
}

func winMean(xs []float64, i, w int) float64 {
	if w <= 1 {
		return xs[i]
	}
	lo := max(0, i-w+1)
	s := 0.0
	for j := lo; j <= i; j++ {
		s += xs[j]
	}
	return s / float64(i-lo+1)
}

// advMean is the mean advance over the window, an armyless step counting
// as standing at home.
func advMean(xs []float64, i, w int) float64 {
	lo := max(0, i-max(w, 1)+1)
	s := 0.0
	for j := lo; j <= i; j++ {
		if x := xs[j]; !math.IsNaN(x) {
			s += math.Max(-0.2, math.Min(1.2, x))
		}
	}
	return s / float64(i-lo+1)
}

func winMedian(xs []float64, i, w int) float64 {
	lo := max(0, i-w+1)
	b := append([]float64(nil), xs[lo:i+1]...)
	for a := 1; a < len(b); a++ {
		for c := a; c > 0 && b[c] < b[c-1]; c-- {
			b[c], b[c-1] = b[c-1], b[c]
		}
	}
	m := len(b)
	if m%2 == 1 {
		return b[m/2]
	}
	return (b[m/2-1] + b[m/2]) / 2
}

func ema(a float64) func([]float64) []float64 {
	return func(p []float64) []float64 {
		out := make([]float64, len(p))
		// smooth in logit space
		z := 0.0
		for i, x := range p {
			l := math.Log(x / (1 - x))
			if i == 0 {
				z = l
			} else {
				z = a*l + (1-a)*z
			}
			out[i] = 1 / (1 + math.Exp(-z))
		}
		return out
	}
}

var cur = opts{armyK: 25000, incK: 250, cumK: 25000, win: 4}

func v9(o *opts) { o.trade = true; o.tradeK = 25000; o.win = 12 }

func with(f func(*opts)) opts { o := cur; f(&o); return o }

// variants is what a run compares. "+trade win12" is what Version 9 ships.
var variants = []variant{
	{name: "current", feat: base(cur)},
	{name: "win8", feat: base(with(func(o *opts) { o.win = 8 }))},
	{name: "win12", feat: base(with(func(o *opts) { o.win = 12 }))},
	{name: "median4", feat: base(with(func(o *opts) { o.median = true }))},
	{name: "noInc", feat: base(with(func(o *opts) { o.noInc = true }))},
	{name: "value", feat: base(with(func(o *opts) { o.useValue = true }))},
	{name: "+skill", feat: base(with(func(o *opts) { o.skill = true }))},
	{name: "time20", feat: base(with(func(o *opts) { o.timeX = true; o.timeT = 1200 }))},
	{name: "ema0.5", feat: base(cur), post: ema(0.5)},
	{name: "+trade", feat: base(with(func(o *opts) { o.trade = true; o.tradeK = 25000 }))},
	{name: "+trade win8", feat: base(with(func(o *opts) { o.trade = true; o.tradeK = 25000; o.win = 8 }))},
	{name: "+trade win12", feat: base(with(func(o *opts) { o.trade = true; o.tradeK = 25000; o.win = 12 }))},
	{name: "+trade win16", feat: base(with(func(o *opts) { o.trade = true; o.tradeK = 25000; o.win = 16 }))},
	{name: "+trade win20", feat: base(with(func(o *opts) { o.trade = true; o.tradeK = 25000; o.win = 20 }))},
	{name: "v9+front", feat: base(with(func(o *opts) { v9(o); o.front = 1 }))},
	{name: "v9+front4", feat: base(with(func(o *opts) { v9(o); o.front = 4 }))},
	{name: "v9+front12", feat: base(with(func(o *opts) { v9(o); o.front = 12 }))},
	{name: "v9+frontW4", feat: base(with(func(o *opts) { v9(o); o.front = 4; o.frontW = true }))},
	{name: "v9+ownHalf", feat: base(with(func(o *opts) { v9(o); o.lossKeys = []string{"ownHalf"}; o.lossK = 10000 }))},
	{name: "v9+ownBase", feat: base(with(func(o *opts) { v9(o); o.lossKeys = []string{"ownBase"}; o.lossK = 10000 }))},
	{name: "v9+defence", feat: base(with(func(o *opts) { v9(o); o.lossKeys = []string{"defence"}; o.lossK = 5000 }))},
	{name: "v9+eco", feat: base(with(func(o *opts) { v9(o); o.lossKeys = []string{"eco"}; o.lossK = 5000 }))},
	{name: "v9+factory", feat: base(with(func(o *opts) { v9(o); o.lossKeys = []string{"factory"}; o.lossK = 2000 }))},
	{name: "v9+naval", feat: base(with(func(o *opts) { v9(o); o.lossKeys = []string{"naval"}; o.lossK = 5000 }))},
	{name: "v9+sea", feat: base(with(func(o *opts) { v9(o); o.lossKeys = []string{"sea"}; o.lossK = 5000 }))},
	{name: "v9+def+eco", feat: base(with(func(o *opts) { v9(o); o.lossKeys = []string{"defence", "eco"}; o.lossK = 5000 }))},
	{name: "v9+front4+def", feat: base(with(func(o *opts) { v9(o); o.front = 4; o.lossKeys = []string{"defence"}; o.lossK = 5000 }))},
	{name: "+trade win12 ema.5", feat: base(with(func(o *opts) { o.trade = true; o.tradeK = 25000; o.win = 12 })), post: ema(0.5)},
}
