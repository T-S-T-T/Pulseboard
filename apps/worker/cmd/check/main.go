// Command check runs one health check and prints the result as JSON.
//
//	go run ./cmd/check https://example.com
//
// It exits with 0 if the target is up, 1 if it is down and 2 for wrong usage.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/T-S-T-T/Pulseboard/apps/worker/internal/probe"
)

func main() {
	method := flag.String("method", "GET", "GET or HEAD")
	timeout := flag.Duration("timeout", 5*time.Second, "time limit for the whole check")
	flag.Parse()
	if flag.NArg() != 1 || *timeout <= 0 {
		fmt.Fprintln(os.Stderr, "usage: check [-method GET|HEAD] [-timeout 5s] <url>")
		os.Exit(2)
	}

	result := probe.Check(context.Background(), probe.Request{
		URL: flag.Arg(0), Method: *method, Timeout: *timeout,
	}, probe.PublicPolicy())

	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if !result.OK {
		os.Exit(1)
	}
}
