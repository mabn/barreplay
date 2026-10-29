package main

import "testing"

func TestTrayTooltip(t *testing.T) {
	for _, c := range []struct {
		mode string
		job  *JobView
		want string
	}{
		{modeReady, nil, "FogOfWar"},
		{modeSetup, nil, "FogOfWar: setting up"},
		{modeRunning, &JobView{}, "FogOfWar: re-simulating"},
		{modeRunning, &JobView{Percent: 43.7}, "FogOfWar: re-simulating, 43%"},
	} {
		if got := trayTooltip(c.mode, c.job); got != c.want {
			t.Errorf("%s: %q, want %q", c.mode, got, c.want)
		}
	}
}

func TestTrayIconIsAnICO(t *testing.T) {
	ico, err := trayIcon()
	if err != nil {
		t.Fatal(err)
	}
	// ICONDIR: reserved 0, type 1 (icon), then the image count.
	if len(ico) < 6 || ico[0] != 0 || ico[1] != 0 || ico[2] != 1 || ico[3] != 0 || ico[4] != 5 {
		t.Fatalf("not a 5-image .ico: % x", ico[:min(len(ico), 8)])
	}
}
