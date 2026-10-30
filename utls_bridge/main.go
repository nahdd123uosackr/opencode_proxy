package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	utls "github.com/refraction-networking/utls"
)

var (
	targetHost = "opencode.ai"
	targetPort = "443"
)

func newBunTransport() *http.Transport {
	return &http.Transport{
		Proxy:                 nil, // direct
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		DialTLSContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			dialer := &net.Dialer{
				Timeout:   30 * time.Second,
				KeepAlive: 30 * time.Second,
			}
			raw, err := dialer.DialContext(ctx, network, addr)
			if err != nil {
				return nil, err
			}
			host, _, err := net.SplitHostPort(addr)
			if err != nil {
				raw.Close()
				return nil, err
			}
			uconn := utls.UClient(raw, &utls.Config{
				ServerName: host,
				NextProtos: []string{"http/1.1"},
			}, utls.HelloCustom)
			if err := uconn.ApplyPreset(bunSpecForConn()); err != nil {
				raw.Close()
				return nil, fmt.Errorf("apply bun uTLS preset: %w", err)
			}
			if err := uconn.HandshakeContext(ctx); err != nil {
				raw.Close()
				return nil, fmt.Errorf("bun uTLS handshake: %w", err)
			}
			return uconn, nil
		},
	}
}

func main() {
	port := flag.Int("port", 18791, "listen port for uTLS bridge")
	host := flag.String("host", "127.0.0.1", "listen host")
	flag.Parse()

	if envPort := os.Getenv("UTLS_PORT"); envPort != "" {
		fmt.Sscanf(envPort, "%d", port)
	}

	transport := newBunTransport()
	client := &http.Client{
		Transport: transport,
		Timeout:   300 * time.Second, // allow long LLM stream
	}

	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok","transport":"uTLS-Bun-BoringSSL","target":"opencode.ai"}`))
	})

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Forward request to https://opencode.ai + r.URL.RequestURI()
		destURL := fmt.Sprintf("https://%s:%s%s", targetHost, targetPort, r.URL.RequestURI())

		outReq, err := http.NewRequestWithContext(r.Context(), r.Method, destURL, r.Body)
		if err != nil {
			http.Error(w, fmt.Sprintf("create upstream request: %v", err), http.StatusBadRequest)
			return
		}

		// Copy headers except hop-by-hop
		for k, vv := range r.Header {
			lk := strings.ToLower(k)
			if lk == "connection" || lk == "keep-alive" || lk == "proxy-authenticate" ||
				lk == "proxy-authorization" || lk == "te" || lk == "trailers" ||
				lk == "transfer-encoding" || lk == "upgrade" {
				continue
			}
			for _, v := range vv {
				outReq.Header.Add(k, v)
			}
		}
		outReq.Header.Set("Host", targetHost)

		resp, err := client.Do(outReq)
		if err != nil {
			log.Printf("[uTLS bridge] upstream error: %v", err)
			http.Error(w, fmt.Sprintf("upstream uTLS error: %v", err), http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		// Copy response headers
		for k, vv := range resp.Header {
			for _, v := range vv {
				w.Header().Add(k, v)
			}
		}
		w.Header().Set("X-Bridge-Transport", "uTLS-Bun-BoringSSL")
		w.WriteHeader(resp.StatusCode)

		// Stream body
		flusher, isFlusher := w.(http.Flusher)
		buf := make([]byte, 4096)
		for {
			n, readErr := resp.Body.Read(buf)
			if n > 0 {
				w.Write(buf[:n])
				if isFlusher {
					flusher.Flush()
				}
			}
			if readErr != nil {
				break
			}
		}
	})

	addr := fmt.Sprintf("%s:%d", *host, *port)
	log.Printf("==========================================================")
	log.Printf("  OpenCode uTLS Bridge (Bun BoringSSL ClientHello)")
	log.Printf("  Listening on http://%s -> https://%s:443", addr, targetHost)
	log.Printf("==========================================================")

	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatalf("server exited: %v", err)
	}
}
