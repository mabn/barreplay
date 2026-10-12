package assets

import (
	"regexp"
	"testing"
)

func TestWidgetVersion(t *testing.T) {
	if v := WidgetVersion(); !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(v) {
		t.Fatalf("WidgetVersion() = %q, want a x.y.z version read from the embedded widget", v)
	}
}
