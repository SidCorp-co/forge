#!/bin/bash
set -e

API="${STRAPI_URL:-http://localhost:1337/api}"
TOKEN="${STRAPI_TOKEN:?STRAPI_TOKEN env var required (generate at /admin → Settings → API Tokens)}"
AUTH="Authorization: Bearer $TOKEN"
CT="Content-Type: application/json"

pass=0
fail=0
total=0

check() {
  total=$((total + 1))
  if [ $? -eq 0 ]; then
    echo "  PASS: $1"
    pass=$((pass + 1))
  else
    echo "  FAIL: $1"
    fail=$((fail + 1))
  fi
}

echo "============================================"
echo "  FORGE - Real-World Integration Tests"
echo "============================================"
echo ""

# ─────────────────────────────────────────────
echo "── TEST 1: Create a Project ──"
PROJECT=$(curl -s -X POST "$API/projects" \
  -H "$AUTH" -H "$CT" \
  -d '{"data":{"name":"My Web App","slug":"my-web-app","description":"A Next.js web application"}}')
PROJECT_ID=$(echo "$PROJECT" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['documentId'])" 2>/dev/null)
test -n "$PROJECT_ID"
check "Create project (documentId=$PROJECT_ID)"

# ─────────────────────────────────────────────
echo "── TEST 2: Report an Issue (like a user would) ──"
ISSUE=$(curl -s -X POST "$API/issues" \
  -H "$AUTH" -H "$CT" \
  -d "{\"data\":{\"title\":\"Login button not working on mobile\",\"description\":\"When I tap the login button on iPhone Safari, nothing happens. The button appears to be there but clicking it does nothing. I can see the button but it is unresponsive. This started happening after the last deployment.\",\"status\":\"open\",\"priority\":\"none\",\"reportedBy\":\"user@example.com\",\"project\":\"$PROJECT_ID\"}}")
ISSUE_ID=$(echo "$ISSUE" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['documentId'])" 2>/dev/null)
test -n "$ISSUE_ID"
check "Report issue (documentId=$ISSUE_ID)"

# ─────────────────────────────────────────────
echo "── TEST 3: Verify issue was created with correct data ──"
GET_ISSUE=$(curl -s "$API/issues/$ISSUE_ID?populate=project" -H "$AUTH")
ISSUE_STATUS=$(echo "$GET_ISSUE" | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print(d['status'])" 2>/dev/null)
ISSUE_TITLE=$(echo "$GET_ISSUE" | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print(d['title'])" 2>/dev/null)
test "$ISSUE_STATUS" = "open"
check "Issue status is 'open'"
test "$ISSUE_TITLE" = "Login button not working on mobile"
check "Issue title matches"

# ─────────────────────────────────────────────
echo "── TEST 4: Simulate AI Enrichment (update issue with AI fields) ──"
ENRICH=$(curl -s -X PUT "$API/issues/$ISSUE_ID" \
  -H "$AUTH" -H "$CT" \
  -d '{
    "data": {
      "status": "enriched",
      "priority": "high",
      "category": "bug-frontend",
      "aiSummary": "Mobile Safari touch event handler is not firing on the login button. Likely a CSS issue where an overlay or z-index is blocking touch events on iOS.",
      "aiSuggestedSolution": "Check for overlapping elements using Safari dev tools. Likely fix: add position:relative and z-index to the login button, or remove any transparent overlays.",
      "aiAcceptanceCriteria": ["Login button responds to tap on iPhone Safari","Login button responds to tap on Android Chrome","No visual regression on desktop browsers","Add mobile touch event test"],
      "aiConfidence": 0.85
    }
  }')
ENRICHED_STATUS=$(echo "$ENRICH" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['status'])" 2>/dev/null)
test "$ENRICHED_STATUS" = "enriched"
check "Issue enriched with AI fields (status=enriched, priority=high)"

# ─────────────────────────────────────────────
echo "── TEST 5: User Confirms Enrichment ──"
CONFIRM=$(curl -s -X PUT "$API/issues/$ISSUE_ID" \
  -H "$AUTH" -H "$CT" \
  -d '{"data":{"status":"confirmed"}}')
CONFIRMED=$(echo "$CONFIRM" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['status'])" 2>/dev/null)
test "$CONFIRMED" = "confirmed"
check "User confirmed enrichment (status=confirmed)"

# ─────────────────────────────────────────────
echo "── TEST 6: Developer Approves Issue ──"
APPROVE=$(curl -s -X PUT "$API/issues/$ISSUE_ID" \
  -H "$AUTH" -H "$CT" \
  -d '{"data":{"status":"approved"}}')
APPROVED=$(echo "$APPROVE" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['status'])" 2>/dev/null)
test "$APPROVED" = "approved"
check "Developer approved issue (status=approved)"

# ─────────────────────────────────────────────
echo "── TEST 7: Create Tasks from Acceptance Criteria ──"
TASK1=$(curl -s -X POST "$API/tasks" \
  -H "$AUTH" -H "$CT" \
  -d "{\"data\":{\"title\":\"Fix login button touch event on mobile Safari\",\"description\":\"Investigate and fix the CSS/z-index issue blocking touch events on the login button in mobile Safari\",\"status\":\"backlog\",\"priority\":\"high\",\"isAgentTask\":true,\"agentStatus\":\"idle\",\"acceptanceCriteria\":[\"Login button responds to tap on iPhone Safari\",\"No visual regression on desktop\"],\"issue\":\"$ISSUE_ID\",\"project\":\"$PROJECT_ID\"}}")
TASK1_ID=$(echo "$TASK1" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['documentId'])" 2>/dev/null)
test -n "$TASK1_ID"
check "Task 1 created (documentId=$TASK1_ID)"

TASK2=$(curl -s -X POST "$API/tasks" \
  -H "$AUTH" -H "$CT" \
  -d "{\"data\":{\"title\":\"Add mobile touch event test\",\"description\":\"Write e2e test for login button on mobile viewport\",\"status\":\"backlog\",\"priority\":\"medium\",\"isAgentTask\":true,\"agentStatus\":\"idle\",\"acceptanceCriteria\":[\"E2E test covers mobile tap on login button\",\"Test runs in CI\"],\"issue\":\"$ISSUE_ID\",\"project\":\"$PROJECT_ID\"}}")
TASK2_ID=$(echo "$TASK2" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['documentId'])" 2>/dev/null)
test -n "$TASK2_ID"
check "Task 2 created (documentId=$TASK2_ID)"

# ─────────────────────────────────────────────
echo "── TEST 8: Verify Tasks exist ──"
TASKS=$(curl -s "$API/tasks" -H "$AUTH")
TASK_COUNT=$(echo "$TASKS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']))" 2>/dev/null)
test "$TASK_COUNT" = "2"
check "2 tasks created"

# ─────────────────────────────────────────────
echo "── TEST 9: Simulate Agent Starts Working ──"
AGENT_START=$(curl -s -X PUT "$API/tasks/$TASK1_ID" \
  -H "$AUTH" -H "$CT" \
  -d '{"data":{"status":"in_progress","agentStatus":"running"}}')
AGENT_RUNNING=$(echo "$AGENT_START" | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print(d['agentStatus'])" 2>/dev/null)
test "$AGENT_RUNNING" = "running"
check "Agent started on task 1 (agentStatus=running)"

# ─────────────────────────────────────────────
echo "── TEST 10: Add AI Comment to Issue ──"
COMMENT=$(curl -s -X POST "$API/comments" \
  -H "$AUTH" -H "$CT" \
  -d "{\"data\":{\"body\":\"Agent analysis: Found overlapping div with class .modal-backdrop that has z-index:1050. The login button has z-index:1. Fix: Remove stale modal backdrop that persists after page load.\",\"author\":\"Claude Agent\",\"isAI\":true,\"issue\":\"$ISSUE_ID\"}}")
COMMENT_ID=$(echo "$COMMENT" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['documentId'])" 2>/dev/null)
test -n "$COMMENT_ID"
check "AI comment added to issue"

# ─────────────────────────────────────────────
echo "── TEST 11: Agent Completes Task ──"
AGENT_DONE=$(curl -s -X PUT "$API/tasks/$TASK1_ID" \
  -H "$AUTH" -H "$CT" \
  -d '{"data":{"status":"in_review","agentStatus":"completed","agentLog":{"steps":["Analyzed DOM structure","Found .modal-backdrop overlay","Removed stale backdrop in useEffect cleanup","Ran npm test - 14/14 passing","Verified on mobile viewport"],"branch":"fix/mobile-login-button","commit":"abc123f"}}}')
AGENT_COMPLETED=$(echo "$AGENT_DONE" | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print(d['agentStatus'])" 2>/dev/null)
test "$AGENT_COMPLETED" = "completed"
check "Agent completed task 1 (status=in_review)"

# ─────────────────────────────────────────────
echo "── TEST 12: Verify Full Issue with all Relations ──"
FULL=$(curl -s "$API/issues/$ISSUE_ID?populate=project,tasks,comments" -H "$AUTH")
FULL_OK=$(echo "$FULL" | python3 -c "
import sys, json
d = json.load(sys.stdin)['data']
ok = True
ok = ok and d['status'] == 'approved'
ok = ok and d['priority'] == 'high'
ok = ok and d['aiConfidence'] == 0.85
ok = ok and len(d.get('tasks',[])) == 2
ok = ok and len(d.get('comments',[])) == 1
ok = ok and d['comments'][0]['isAI'] == True
print('PASS' if ok else 'FAIL')
" 2>/dev/null)
test "$FULL_OK" = "PASS"
check "Full issue has project, 2 tasks, 1 AI comment"

# ─────────────────────────────────────────────
echo "── TEST 13: Create Chat Session ──"
CHAT=$(curl -s -X POST "$API/chat-sessions" \
  -H "$AUTH" -H "$CT" \
  -d "{\"data\":{\"title\":\"Debug session for login bug\",\"source\":\"web\",\"messages\":[{\"role\":\"user\",\"content\":\"Why is the login button not working on mobile?\"},{\"role\":\"assistant\",\"content\":\"I found a stale .modal-backdrop overlay blocking touch events. The fix is to clean up the backdrop in the useEffect cleanup function.\"}],\"project\":\"$PROJECT_ID\"}}")
CHAT_ID=$(echo "$CHAT" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['documentId'])" 2>/dev/null)
test -n "$CHAT_ID"
check "Chat session created (documentId=$CHAT_ID)"

# ─────────────────────────────────────────────
echo "── TEST 14: List all Issues for Project ──"
LIST=$(curl -s "$API/issues?filters[project][documentId]=$PROJECT_ID&sort=createdAt:desc" -H "$AUTH")
LIST_COUNT=$(echo "$LIST" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']))" 2>/dev/null)
test "$LIST_COUNT" -ge 1
check "Can list issues filtered by project ($LIST_COUNT found)"

# ─────────────────────────────────────────────
echo "── TEST 15: Report Second Issue (widget scenario) ──"
ISSUE2=$(curl -s -X POST "$API/issues" \
  -H "$AUTH" -H "$CT" \
  -d "{\"data\":{\"title\":\"Dashboard charts show wrong date range\",\"description\":\"The analytics dashboard is showing data from last month instead of current month. The date picker shows correct dates but the chart data does not match.\",\"status\":\"open\",\"priority\":\"none\",\"reportedBy\":\"pm@company.com\",\"project\":\"$PROJECT_ID\"}}")
ISSUE2_ID=$(echo "$ISSUE2" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['documentId'])" 2>/dev/null)
test -n "$ISSUE2_ID"
check "Second issue reported (widget scenario)"

# ─────────────────────────────────────────────
echo "── TEST 16: Next.js Web App Responds ──"
WEB_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000)
test "$WEB_STATUS" = "200"
check "Next.js responds at localhost:3000 (HTTP $WEB_STATUS)"

# ─────────────────────────────────────────────
echo "── TEST 17: Tauri Dev App Responds ──"
DEV_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:1420)
test "$DEV_STATUS" = "200"
check "Tauri dev app responds at localhost:1420 (HTTP $DEV_STATUS)"

# ─────────────────────────────────────────────
echo "── TEST 18: Widget Dev Server Responds ──"
WIDGET_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5173)
test "$WIDGET_STATUS" = "200"
check "Widget dev server responds at localhost:5173 (HTTP $WIDGET_STATUS)"

# ─────────────────────────────────────────────
echo "── TEST 19: WebSocket Endpoint Exists ──"
WS_CHECK=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:1337/ws)
# WebSocket upgrade request returns 400 (expected - needs WS handshake)
test "$WS_CHECK" = "400" -o "$WS_CHECK" = "426" -o "$WS_CHECK" = "200"
check "WebSocket endpoint at /ws responds (HTTP $WS_CHECK)"

# ─────────────────────────────────────────────
echo ""
echo "============================================"
echo "  RESULTS: $pass/$total passed, $fail failed"
echo "============================================"
