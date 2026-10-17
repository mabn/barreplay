// Command winres writes rsrc_windows_amd64.syso, the Windows resources that
// `go build` links into FogOfWar.exe on its own: the icon, the version info
// (product and company name, file description) and the application manifest
// (asInvoker, per-monitor DPI, common controls v6).
//
// An exe with none of these is what antivirus heuristics expect of a dropper,
// and the manifest's asInvoker also keeps Windows' installer detection from
// asking for admin rights. Run it from cmd/fogofwar after changing the icon or
// the version, and commit the .syso:
//
//	go run ./winres -version 0.1.0
package main

import (
	"flag"
	"fmt"
	"image/png"
	"log"
	"os"

	"github.com/tc-hib/winres"
	"github.com/tc-hib/winres/version"
)

func main() {
	ver := flag.String("version", "0.1.0", "product and file version (major.minor.patch)")
	icon := flag.String("icon", "winres/icon.png", "the icon, a square PNG of at least 256px")
	out := flag.String("out", "rsrc_windows_amd64.syso", "the object file to write")
	flag.Parse()
	if err := run(*ver, *icon, *out); err != nil {
		log.Fatal(err)
	}
}

func run(ver, iconPath, out string) error {
	f, err := os.Open(iconPath)
	if err != nil {
		return err
	}
	img, err := png.Decode(f)
	f.Close()
	if err != nil {
		return fmt.Errorf("%s: %w", iconPath, err)
	}
	ico, err := winres.NewIconFromResizedImage(img, nil)
	if err != nil {
		return err
	}

	rs := &winres.ResourceSet{}
	// The first icon by ID is the one Explorer shows for the exe.
	if err := rs.SetIcon(winres.ID(1), ico); err != nil {
		return err
	}
	rs.SetManifest(winres.AppManifest{
		Identity:            winres.AssemblyIdentity{Name: "dev.fogofwar.FogOfWar"},
		Description:         "FogOfWar",
		Compatibility:       winres.Win10AndAbove,
		ExecutionLevel:      winres.AsInvoker,
		DPIAwareness:        winres.DPIPerMonitorV2,
		UseCommonControlsV6: true,
		LongPathAware:       true,
	})

	vi := version.Info{}
	vi.SetFileVersion(ver)
	vi.SetProductVersion(ver)
	for k, v := range map[string]string{
		version.ProductName:      "FogOfWar",
		version.FileDescription:  "FogOfWar - Beyond All Reason replay re-simulator",
		version.CompanyName:      "fogofwar.dev",
		version.LegalCopyright:   "fogofwar.dev",
		version.InternalName:     "FogOfWar",
		version.OriginalFilename: "FogOfWar.exe",
		version.Comments:         "https://replay.fogofwar.dev",
	} {
		if err := vi.Set(version.LangDefault, k, v); err != nil {
			return err
		}
	}
	rs.SetVersionInfo(vi)

	w, err := os.Create(out)
	if err != nil {
		return err
	}
	if err := rs.WriteObject(w, winres.ArchAMD64); err != nil {
		w.Close()
		return err
	}
	return w.Close()
}
