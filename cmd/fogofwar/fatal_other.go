//go:build !windows

package main

import (
	"fmt"
	"os"
)

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "fogofwar:", err)
	os.Exit(1)
}

// killChildrenWithUs is Windows-only; elsewhere the engine is the operator's.
func killChildrenWithUs() {}
