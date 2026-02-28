Security Hardening — Test Plan
Prerequisites:

macOS with Figma Desktop installed
Node.js 18+
Forked repo with patched daemon.js and index.js in place
A Figma design file open (not just the home screen)
Terminal with Full Disk Access granted


Phase 1: Basic Connectivity (Confirm Nothing Is Broken)
Test 1.1 — Clean Start
bash# Kill any existing daemon first
lsof -ti:3456 | xargs kill -9 2>/dev/null; true

# Connect to Figma (this patches + starts daemon + generates token)
node src/index.js connect
Expected:

Figma patches successfully (or reports already patched)
Daemon starts
Console shows "Speed daemon running"
No errors

Test 1.2 — Token File Exists
bashls -la ~/.figma-ds-cli/.daemon-token
Expected:

File exists
Permissions show -rw------- (600 — owner read/write only)
File contains a 64-character hex string

bashcat ~/.figma-ds-cli/.daemon-token
Expected: Something like a3f8b2c1d4e5... (64 hex chars, no newlines)
Test 1.3 — CLI Commands Still Work
bashnode src/index.js canvas info
Expected: Returns current file name and page info — no errors.
bashnode src/index.js var list
Expected: Lists variables (or says none found) — no errors.
Test 1.4 — Daemon Health Check Works With Token
bashTOKEN=$(cat ~/.figma-ds-cli/.daemon-token)
curl -s -H "X-Daemon-Token: $TOKEN" http://127.0.0.1:3456/health | python3 -m json.tool
Expected:
json{
    "status": "ok",
    "mode": "yolo",
    "plugin": false,
    "cdp": true,
    "idleTimeoutMs": 600000
}

Phase 2: Token Authentication (Layer 1)
Test 2.1 — Request WITHOUT Token → Rejected
bashcurl -s http://127.0.0.1:3456/health | python3 -m json.tool
Expected:
json{
    "error": "Unauthorized: Invalid or missing token"
}
HTTP status should be 403.
Verify with status code:
bashcurl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3456/health
Expected: 403
Test 2.2 — Request WITH Wrong Token → Rejected
bashcurl -s -H "X-Daemon-Token: wrong_token_here" http://127.0.0.1:3456/health | python3 -m json.tool
Expected:
json{
    "error": "Unauthorized: Invalid or missing token"
}
Test 2.3 — Request WITH Correct Token → Accepted
bashTOKEN=$(cat ~/.figma-ds-cli/.daemon-token)
curl -s -H "X-Daemon-Token: $TOKEN" http://127.0.0.1:3456/health | python3 -m json.tool
Expected: 200 with status ok
Test 2.4 — Exec WITHOUT Token → Rejected
bashcurl -s -X POST http://127.0.0.1:3456/exec \
  -H "Content-Type: application/json" \
  -d '{"action":"eval","code":"1+1"}' | python3 -m json.tool
Expected:
json{
    "error": "Unauthorized: Invalid or missing token"
}
Test 2.5 — Exec WITH Token → Works
bashTOKEN=$(cat ~/.figma-ds-cli/.daemon-token)
curl -s -X POST http://127.0.0.1:3456/exec \
  -H "Content-Type: application/json" \
  -H "X-Daemon-Token: $TOKEN" \
  -d '{"action":"eval","code":"1+1"}' | python3 -m json.tool
Expected:
json{
    "result": 2,
    "mode": "yolo"
}

Phase 3: CORS Lockdown (Layer 2)
Test 3.1 — OPTIONS Preflight → Blocked
bashcurl -s -X OPTIONS http://127.0.0.1:3456/exec | python3 -m json.tool
Expected:
json{
    "error": "CORS preflight rejected"
}
Verify status code:
bashcurl -s -o /dev/null -w "%{http_code}" -X OPTIONS http://127.0.0.1:3456/exec
Expected: 403
Test 3.2 — No CORS Headers in Response
bashTOKEN=$(cat ~/.figma-ds-cli/.daemon-token)
curl -sI -H "X-Daemon-Token: $TOKEN" http://127.0.0.1:3456/health 2>&1 | grep -i "access-control"
Expected: No output (zero Access-Control-* headers present)
Test 3.3 — Browser Cross-Origin Request → Blocked
Open any website in Chrome (e.g., https://example.com), open DevTools Console (F12), and run:
javascriptfetch('http://localhost:3456/exec', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'eval', code: '1+1' })
}).then(r => r.json()).then(console.log).catch(e => console.error('BLOCKED:', e.message));
Expected:
BLOCKED: Failed to fetch
The browser blocks it because there are no CORS headers allowing cross-origin access.

⚠️ This is the critical test. This is the exact attack vector we're closing.
Before the patch, this would return {"result": 2} from any website.


Phase 4: Host Header Validation (Layer 3)
Test 4.1 — Spoofed Host Header → Rejected
bashTOKEN=$(cat ~/.figma-ds-cli/.daemon-token)
curl -s -H "Host: evil.com" -H "X-Daemon-Token: $TOKEN" http://127.0.0.1:3456/health | python3 -m json.tool
Expected:
json{
    "error": "Unauthorized: Invalid host header"
}
Test 4.2 — localhost Host Header → Accepted
bashTOKEN=$(cat ~/.figma-ds-cli/.daemon-token)
curl -s -H "Host: localhost:3456" -H "X-Daemon-Token: $TOKEN" http://127.0.0.1:3456/health | python3 -m json.tool
Expected: 200 with status ok
Test 4.3 — 127.0.0.1 Host Header → Accepted
bashTOKEN=$(cat ~/.figma-ds-cli/.daemon-token)
curl -s -H "Host: 127.0.0.1:3456" -H "X-Daemon-Token: $TOKEN" http://127.0.0.1:3456/health | python3 -m json.tool
Expected: 200 with status ok

Phase 5: Idle Timeout (Auto-Shutdown)
Test 5.1 — Daemon Exits After Idle Period
First, stop the current daemon:
bashnode src/index.js daemon stop
Start daemon with short timeout (60 seconds as you prefer):
bashDAEMON_IDLE_TIMEOUT=60000 node src/daemon.js
Expected on start: Console shows:
[daemon] Idle timeout: 60s
[daemon] Auth: token required
Now wait 60 seconds without sending any requests.
Expected after 60s:
[daemon] Idle for 60s — auto-shutting down
[daemon] Shutting down...
Process exits automatically.
Test 5.2 — Activity Resets the Timer
Start daemon again with short timeout:
bashDAEMON_IDLE_TIMEOUT=60000 node src/daemon.js &
Wait 50 seconds, then send a request:
bashsleep 50
TOKEN=$(cat ~/.figma-ds-cli/.daemon-token)
curl -s -H "X-Daemon-Token: $TOKEN" http://127.0.0.1:3456/health > /dev/null
echo "Sent health check at $(date)"
Now wait another 60 seconds.
Expected: Daemon should NOT have shut down at the 60s mark (because the health check at 50s reset the timer). It should shut down ~60s after the last request (i.e., at ~110s from start).
Test 5.3 — Default Timeout Is 10 Minutes
bashnode src/index.js daemon stop 2>/dev/null; true
node src/index.js connect
TOKEN=$(cat ~/.figma-ds-cli/.daemon-token)
curl -s -H "X-Daemon-Token: $TOKEN" http://127.0.0.1:3456/health | python3 -m json.tool | grep idleTimeout
Expected:
"idleTimeoutMs": 600000

Phase 6: Token Rotation on Restart
Test 6.1 — New Token Generated on Force Restart
bash# Save current token
OLD_TOKEN=$(cat ~/.figma-ds-cli/.daemon-token)
echo "Old token: $OLD_TOKEN"

# Force restart daemon
node src/index.js daemon stop
node src/index.js connect

# Read new token
NEW_TOKEN=$(cat ~/.figma-ds-cli/.daemon-token)
echo "New token: $NEW_TOKEN"

# Compare
if [ "$OLD_TOKEN" != "$NEW_TOKEN" ]; then
  echo "✓ PASS — Token rotated on restart"
else
  echo "✗ FAIL — Token was not rotated"
fi
Expected: Tokens are different. New token is generated every daemon start.
Test 6.2 — Old Token No Longer Works After Restart
bashcurl -s -H "X-Daemon-Token: $OLD_TOKEN" http://127.0.0.1:3456/health | python3 -m json.tool
Expected:
json{
    "error": "Unauthorized: Invalid or missing token"
}
Test 6.3 — CLI Automatically Uses New Token
bashnode src/index.js canvas info
Expected: Works normally — CLI reads the new token from file transparently.

Phase 7: End-to-End Workflow
Test 7.1 — Full Session Workflow
bash# 1. Clean start
node src/index.js daemon stop 2>/dev/null; true
node src/index.js connect

# 2. Verify file
node src/index.js canvas info

# 3. Do some real work
node src/index.js var list

# 4. Stop daemon
node src/index.js daemon stop

# 5. Verify daemon is actually stopped
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3456/health
Expected for step 5: Connection refused (not 403 — daemon process is gone)
Test 7.2 — Daemon Status Command
bashnode src/index.js connect
node src/index.js daemon status
Expected: Shows daemon is running on port 3456

Results Summary
Fill this in as you test:
#TestResult1.1Clean start☐ Pass ☐ Fail1.2Token file exists with 600 perms☐ Pass ☐ Fail1.3CLI commands work☐ Pass ☐ Fail1.4Health check with token☐ Pass ☐ Fail2.1No token → 403☐ Pass ☐ Fail2.2Wrong token → 403☐ Pass ☐ Fail2.3Correct token → 200☐ Pass ☐ Fail2.4Exec no token → 403☐ Pass ☐ Fail2.5Exec with token → works☐ Pass ☐ Fail3.1OPTIONS → 403☐ Pass ☐ Fail3.2No CORS headers☐ Pass ☐ Fail3.3Browser cross-origin blocked☐ Pass ☐ Fail4.1Spoofed host → 403☐ Pass ☐ Fail4.2localhost host → 200☐ Pass ☐ Fail4.3127.0.0.1 host → 200☐ Pass ☐ Fail5.1Idle timeout exits☐ Pass ☐ Fail5.2Activity resets timer☐ Pass ☐ Fail5.3Default is 10 min☐ Pass ☐ Fail6.1Token rotates on restart☐ Pass ☐ Fail6.2Old token rejected☐ Pass ☐ Fail6.3CLI uses new token☐ Pass ☐ Fail7.1Full session workflow☐ Pass ☐ Fail7.2Daemon status command☐ Pass ☐ Fail
All 22 tests must pass before submitting the PR.

If Something Fails

Token file not created: Check that ~/.figma-ds-cli/ directory exists and is writable
403 on everything: Check daemon logs — run node src/daemon.js in foreground to see output
CLI commands fail after patch: Run node src/index.js daemon stop then node src/index.js connect for a clean restart
Idle timeout not working: Make sure you're using DAEMON_IDLE_TIMEOUT env var (milliseconds, not seconds)