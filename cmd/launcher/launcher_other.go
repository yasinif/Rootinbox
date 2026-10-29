//go:build !linux

package main

import (
	"fmt"
	"os"
	"os/exec"
)

func run() {
	binary := "./rootinbox"
	if len(os.Args) > 1 && os.Args[1] != "" {
		binary = os.Args[1]
	}
	cmd := exec.Command(binary, os.Args[1:]...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "launcher error: %v\n", err)
		os.Exit(1)
	}
}
