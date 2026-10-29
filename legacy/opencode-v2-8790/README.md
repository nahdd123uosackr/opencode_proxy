# Legacy OpenCode v2 Genuine Server & Adapter (Port 8790)

2026-10-29 이전까지 8790 포트로 운영되던 genuine OpenCode v2 서버 + 어댑터 아키텍처 아카이브.
- `oc-adapter.mjs`: OpenCode v2 genuine 서버(포트 49380) 앞단에서 동작하는 OpenAI 호환 어댑터 (포트 8790)
- `multi-bridge.mjs`: Northflank/외부 WebSocket relay를 통해 opencode.ai로 CONNECT 프록시 중계 (포트 18790)
- `quota-monitor.py`: 릴레이별 쿼터 및 상태 모니터링
