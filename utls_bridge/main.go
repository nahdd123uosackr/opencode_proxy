package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	utls "github.com/refraction-networking/utls"
)

var (
	targetHost = "opencode.ai"
	targetPort = "443"
)

func dialCONNECT(ctx context.Context, proxyURL *url.URL, targetAddr string) (net.Conn, error) {
	dialer := &net.Dialer{Timeout: 15 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", proxyURL.Host)
	if err != nil {
		return nil, fmt.Errorf("dial proxy: %w", err)
	}

	req := &http.Request{
		Method: "CONNECT",
		URL:    &url.URL{Opaque: targetAddr},
		Host:   targetAddr,
		Header: make(http.Header),
	}
	if proxyURL.User != nil {
		user := proxyURL.User.Username()
		pass, _ := proxyURL.User.Password()
		req.Header.Set("Proxy-Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(user+":"+pass)))
	}

	if err := req.Write(conn); err != nil {
		conn.Close()
		return nil, fmt.Errorf("write CONNECT: %w", err)
	}

	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, req)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("read CONNECT resp: %w", err)
	}
	if resp.StatusCode != 200 {
		conn.Close()
		return nil, fmt.Errorf("CONNECT status %d: %s", resp.StatusCode, resp.Status)
	}

	if br.Buffered() > 0 {
		return &bufferedConn{Conn: conn, br: br}, nil
	}
	return conn, nil
}

type bufferedConn struct {
	net.Conn
	br *bufio.Reader
}

func (b *bufferedConn) Read(p []byte) (int, error) {
	return b.br.Read(p)
}

func newBunTransport(proxyURL *url.URL) *http.Transport {
	return &http.Transport{
		Proxy:                 nil, // direct or handled in DialTLSContext via CONNECT
		DisableKeepAlives:     true, // PR #5381 / #5411: clean socket teardown, prevents 429 pooling poisoning
		TLSHandshakeTimeout:   15 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		DialTLSContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			var raw net.Conn
			var err error
			if proxyURL != nil {
				raw, err = dialCONNECT(ctx, proxyURL, addr)
			} else {
				dialer := &net.Dialer{
					Timeout:   30 * time.Second,
					KeepAlive: 30 * time.Second,
				}
				raw, err = dialer.DialContext(ctx, network, addr)
			}
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
	proxyFlag := flag.String("proxy", "", "upstream HTTP proxy URL (e.g. http://user:pass@host:port)")
	flag.Parse()

	if envPort := os.Getenv("UTLS_PORT"); envPort != "" {
		fmt.Sscanf(envPort, "%d", port)
	}

	proxyRaw := *proxyFlag
	if proxyRaw == "" {
		proxyRaw = os.Getenv("PROXY_URL")
	}
	if proxyRaw == "" {
		proxyRaw = os.Getenv("HTTPS_PROXY")
	}
	if proxyRaw == "" {
		proxyRaw = os.Getenv("HTTP_PROXY")
	}
	var proxyURL *url.URL
	if proxyRaw != "" {
		var err error
		proxyURL, err = url.Parse(proxyRaw)
		if err != nil {
			log.Fatalf("invalid proxy URL: %v", err)
		}
	}

	transport := newBunTransport(proxyURL)
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
		outReq.Close = true // Force connection close after response to avoid poisoned socket reuse

		resp, err := client.Do(outReq)
		if err != nil {
			log.Printf("[uTLS bridge] upstream error: %v", err)
			http.Error(w, fmt.Sprintf("upstream uTLS error: %v", err), http.StatusBadGateway)
			return
		}
		defer func() {
			resp.Body.Close()
			if resp.StatusCode == http.StatusTooManyRequests {
				transport.CloseIdleConnections()
			}
		}()

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
