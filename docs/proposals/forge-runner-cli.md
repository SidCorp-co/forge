# Forge Runner CLI (thay `packages/dev`)

## Cốt lõi
Tách lõi runner/broker khỏi Tauri desktop app thành **CLI daemon thuần Rust**. App chỉ còn một vai trò: **cầu nối core ↔ máy local**, chạy job bằng Claude Code CLI (tương lai codex/antigravity). Mọi UI nghiệp vụ (issue, agent chat, knowledge, MCP, pipeline) → **web**. Bỏ webview → 1 binary tĩnh ~10–15 MB, chạy headless/service được.

## Phát hiện then chốt
Core **đã có** runner framework (`core/src/runners/`): type `'claude-code' | 'antigravity'`, message `runner:register`, `capabilities`; dispatch gắn `runnerType`/`runnerId` vào mỗi `job.assigned`. → Daemon chỉ cần đăng ký đúng `type` + nói đúng protocol. Abstraction đa-runner đã có ở core, không phải tự nghĩ.

## Cargo workspace
```
packages/runner/
  crates/forge-runner-core/   # lib: transport(ws,events,lifecycle,heartbeat) · auth(pairing,keychain)
                              #      runner(Runner trait + claude_code + process/stream/platform)
                              #      workspace(worktree,repo) · mcp/config · config/store · daemon
  crates/forge-runner/        # bin clap: login | bind | start | status | logs | config | doctor | service | runners
```
Tách lib để sau gắn GUI/tray mỏng (điều khiển daemon qua local socket) mà không viết lại lõi.

## Runner trait (đa-runner trên cùng máy)
```rust
enum RunnerKind { ClaudeCode }                 // + Codex, Antigravity sau
struct JobSpec { job_id, project_id, issue_id, step, repo_path, prompt, system_prompt,
                 model, allowed_tools, permission_mode, timeout_seconds,
                 mcp_servers_override, worktree_branch, resume_id, agent_session_id }
enum RunnerEvent { Stdout(Value), Tool{name,phase}, Usage{..}, ClaudeSessionId(String),
                   Done{exit_code}, Failed{error,kind} }
trait Runner { kind(); start(spec,tx); send(s,msg); abort(s); status(s) }
```
`ClaudeCodeRunner` = port `claude_cli/{spawn,agent,mcp,platform}`, đổi `app.emit()` → `tx.send(RunnerEvent)`.

## Wire contract (đã xác minh với core)
| Bước | Endpoint / Frame | Ghi chú |
|---|---|---|
| Login | `POST /api/devices/auth/start` → `{userCode,verificationUri,deviceCode,interval}` → poll `POST /api/devices/auth/poll {deviceCode}` → `pending`\|`{deviceId,deviceToken,projectId}` | OAuth Device Authorization (RFC 8628): user approve trên `/activate`, không paste code dài. (Flow `POST /api/devices/pair` cũ giữ làm fallback.) |
| Connect | WS `/ws` + `Authorization: Bearer <deviceToken>` | subscribe `device:<id>` + `runner:register {type:"claude-code",capabilities}` → `runner.registered` |
| Heartbeat | `POST /api/devices/heartbeat` mỗi 30s | |
| Nhận job | frame `job.assigned` | có `runnerType`, `claudeSessionId`(resume), `mcpServersOverride`, `model`, `allowedTools`, `timeoutSeconds` |
| Stream | `POST /api/jobs/:id/events` (kinds `stdout\|tool_call\|tool_result\|progress\|result`) | batch ≤100 + retry backoff |
| Kết thúc | `POST /complete {exitCode}` / `POST /fail {error}` | nhận `job.cancel` → abort |
| MCP | lấy `mcpServersOverride` từ payload + ghép Forge MCP → temp `.json` | **không** quản lý local |

## Cài đặt & onboarding (kiểu claude native)
Mục tiêu: không cần Rust toolchain, không paste code, không config tay.
```bash
curl -fsSL https://core.example.com/install.sh | sh   # tải binary tĩnh build sẵn
forge-runner login            # browser approve + chọn project → paired
forge-runner bind my-app --path ~/code/my-app   # trỏ repo CÓ SẴN (hoặc bỏ --path để dò/clone)
forge-runner start            # hỏi cài service
```
| Thành phần | Thiết kế |
|---|---|
| `install.sh` | Core serve `GET /install.sh`; detect `uname` OS/arch → tải tarball từ `GET /releases/...` (redirect GitHub Releases) → `~/.local/bin/forge-runner` + chmod +x. **Bake `core_url`** vào script ⇒ `login` khỏi cần `--core-url`. |
| `login` | OAuth Device Authorization (RFC 8628): `/devices/auth/start` → in `userCode`+URL (tự mở browser nếu có DISPLAY) → user approve + chọn project trên `/activate` → poll `/devices/auth/poll` → lưu deviceToken. |
| Bind linh hoạt | `forge-runner bind <slug>` ưu tiên repo local CÓ SẴN: (1) `--path <dir>` trỏ checkout sẵn có; (2) tự dò `{projects_root}/{slug}` nếu đã clone; (3) chỉ auto-clone khi chưa có **và** user đồng ý (`--clone`/prompt). Không bao giờ ép clone trùng. Login xong gợi ý bind cho từng project đã chọn. |
| `service install` | systemd user unit / launchd → chạy lúc boot, 1 lệnh. |
| Binary nhẹ | musl static + `opt-level=z` + `strip` + `panic=abort` → 1 file ~8–12 MB, không runtime deps. |

**Phần việc phía CORE** (track riêng, song song daemon): `GET /install.sh` + serve/redirect binary; `POST /api/devices/auth/start` + `/poll`; trang web `/activate` (user nhập `userCode` + chọn project + Approve). Tái dùng `issueDeviceToken()` sẵn có để cấp token khi approve.

## Multi-project trên 1 device
Hỗ trợ sẵn: core register runner theo `(deviceId, type, projectId)` (unique `runners_project_device_type_uq`) → **1 device = nhiều runner, mỗi project một runner**. Config giữ map `[bindings.<slug>] { repo_path, branch }` nhiều block; daemon `runner:register` cho từng binding khi `start`, job của project nào chạy trong `repo_path` của project đó. `max_concurrent` là **per-runner** (default 1); thêm `device_max_concurrent` (tùy chọn, 0=không giới hạn) để chặn tổng job đồng thời trên cả device. Mỗi binding bind độc lập (path sẵn có / dò / clone) — không ép clone trùng.

## Bỏ khỏi bản hiện tại
Skills sync, knowledge/conventions reader, `open_terminal`, usage rollup (core tính từ events), toàn bộ Tauri commands/plugins/tray, React/Vite frontend, MCP library local, project instructions.

## Rollout
| Phase | Scope | Effort |
|---|---|---|
| M0 | Scaffold workspace + clap skeleton + CI cross-OS | ½ ngày |
| M1 | cred store (keychain+file fallback) + `login` (pairing fallback) + heartbeat + ws connect/subscribe `device:<id>` → online trên dashboard | 1–2 ngày |
| M2 | Runner trait + ClaudeCodeRunner + dispatch → 1 job code end-to-end | 2–3 ngày |
| M3 | lifecycle `/complete` `/fail` + cancel/abort + map events + usage_limit/resume_failed | 1–2 ngày |
| M4 | `status --watch` + `logs -f` + `doctor` + `service install` + auto repo resolve/clone | 1–2 ngày |
| **C1** (core, song song) | `/devices/auth/start`+`/poll` + trang `/activate` + `forge-runner login` | 1–2 ngày |
| **C2** (core/CI) | `GET /install.sh` + binary release (musl static, GitHub Releases) + redirect | 1 ngày |
| M5 | Cut-over: deprecate `packages/dev`, cập nhật CLAUDE.md | 1 ngày |

## Quyết định (đã chốt)
1. **`runnerFramework` CHƯA bật** → M1 nối qua đường dispatch hiện hành mà Tauri app đang dùng: subscribe `device:<id>` + nhận `job.assigned`. `runner:register` (gated sau flag) chỉ kích hoạt ở M2+ khi flag bật, đặt sau cờ config `runner.register_enabled` (default theo khả năng phát hiện flag) để không phải sửa code khi bật.
2. **`claudeSessionId` từ core là nguồn resume duy nhất** — daemon KHÔNG tự lưu map `jobId→claudeSessionId` qua restart. Đọc thẳng từ `job.assigned.claudeSessionId`, truyền `--resume`; resume fail thì gắn `[RESUME_FAILED]` vào `/fail` **và dừng ở đó** (không respawn cục bộ). **Core đã tự mở session mới**: `handle-resume-failed.ts` null-hoá `claudeSessionId` trên `agent_sessions` khớp `(issueId,sessionGroup)` rồi auto-retry job fresh khi `onResumeFail='fresh'` (default). Daemon respawn cục bộ sẽ bỏ qua bước null-hoá này → step sau vớ phải session chết, nên cấm.
   - **Run-kind-aware (sửa phía CORE, ngoài scope daemon)**: hiện `onResumeFail` áp đồng nhất theo project, chưa phân biệt run kind. Cần để `handleResumeFailed` join `jobs→pipeline_runs` lấy `kind` (`issue|pm|interactive|system`): `kind∈{issue,pm,system}`→`fresh` (mở session mới); `kind=interactive`→`abort`/surface cho user (auto-retry fresh sẽ mất ngữ cảnh hội thoại). Daemon không cần đổi gì — core tra DB từ `jobId`, **không cần thêm field vào payload**.
3. **`maxConcurrent` cấu hình được, default 1** (khớp core dispatch-gate cap=1).
4. **Keychain với fallback file** — thứ tự: (a) OS keychain qua `keyring` (macOS/Windows/Linux secret-service); (b) nếu backend báo `NoStorageAccess`/`NoEntry` (Linux headless, server) → ghi `~/.config/forge-runner/credentials.json` quyền `0600`, thư mục `0700`; (c) cho phép ép qua env `FORGE_RUNNER_CRED_STORE=keychain|file`. `doctor` báo rõ đang dùng store nào + cảnh báo nếu là file plaintext. Migration: đọc fallback service cũ `forge-beta` một lần rồi ghi lại sang `forge-runner`.

## Rủi ro
- WSL/Windows spawn (`spawn.rs` ~740 dòng) là phần khó nhất — port nguyên + test 3 OS, giữ logic poll `try_wait`+grace 2s (MCP grandchild giữ pipe).
- Drift contract → integration test chạy với core dev server (pair → register → dispatch giả → events).
- Mất UX cho người không rành terminal → bù bằng `doctor` + thông điệp `login` rõ; GUI/tray để sau (lib đã tách sẵn).
