# ISOLATION-REVIEW.md — Security Review of ISOLATION-PLAN.md

## 1. Threat Model
If the AI agent is compromised and controls `devops`, realistic attack paths are:

1. `sudo` privilege escalation to root, then read all secrets and send mail directly.
2. Draft tampering after preview: write benign draft, wait for Telegram preview, then rewrite file before approve.
3. Message rendering deception in Telegram: inject Markdown in draft fields to make reviewer see misleading content.
4. Abuse remaining mailbox credentials (`pass email/zoho/engineer@johnnyr.dev`) to send via SMTP/IMAP if account/app-password permits send.
5. Replace or race draft files in shared pending directory (TOCTOU), including approval-time swaps.
6. Flood pending with huge/many files to DoS watcher/bot or bury malicious drafts in noise.
7. Leak operational details via verbose error forwarding and audit entries (provider response bodies are propagated).
8. If any sudo command allows shell/editor escape, bypass isolation without needing direct `sudo -u agentgate`.

## 2. Gaps in the Plan

1. **ACL model is internally inconsistent and weaker than claimed.**
   - Plan adds `devops` to `agentgate` group (`ISOLATION-PLAN.md:25-31`) and also sets `pending` mode `770` (`ISOLATION-PLAN.md:145-147`).
   - That already grants group read access. The claim "write only" in the table is false in that setup.

2. **No integrity lock between preview and approve.**
   - Current code previews one file state, then on approve re-reads from disk and executes that latest state (`src/bot.ts:65-73`, `src/bot.ts:80-100`).
   - Compromised `devops` can modify draft contents after preview but before approval.

3. **Pending file ownership/permission behavior is not handled.**
   - Draft files created by `devops` may not be writable by `agentgate` for status patching (`src/bot.ts:188-197` writes pending file).
   - This can fail operationally or force looser permissions than intended.

4. **Sudoers example is not a meaningful barrier.**
   - `devops ALL=(ALL) ALL` + `devops ALL=(agentgate) !ALL` (`ISOLATION-PLAN.md:463-466`) still allows root, so attacker can read `/home/agentgate`, `/opt/agent-gate/config.yaml`, process env, or just send directly.

5. **Residual credential path not evaluated.**
   - Plan keeps mailbox password for reader (`ISOLATION-PLAN.md:320-321`) but assumes direct send is blocked after OAuth removal.
   - That is not guaranteed unless SMTP send is explicitly tested/blocked.

6. **Telegram preview can be spoofed visually.**
   - Unescaped user-controlled fields are rendered with Markdown parse mode (`src/bot.ts:162-185`).
   - An attacker can craft values that hide/alter displayed meaning for the human approver.

7. **Error detail leakage.**
   - Raw provider/API response text is propagated in thrown errors (`src/providers/email-zoho.ts:30-33`, `src/providers/email-zoho.ts:73-76`) and then sent to Telegram (`src/bot.ts:101-104`) and audit logs (`src/executor.ts:54`).

## 3. Improvements (Concrete)

### A. Fix directory/ACL model (minimal and high impact)
Do **not** add `devops` to `agentgate` group.

```bash
sudo gpasswd -d devops agentgate || true
sudo groupadd -f agentgate-inbox
sudo usermod -aG agentgate-inbox devops

# Create a true dropbox: owner rwx, group wx, sticky bit
sudo install -d -o agentgate -g agentgate-inbox -m 1730 /opt/agent-gate/drafts/inbox

# Internal dirs remain private
sudo install -d -o agentgate -g agentgate -m 700 /opt/agent-gate/drafts/pending
sudo install -d -o agentgate -g agentgate -m 700 /opt/agent-gate/drafts/approved
sudo install -d -o agentgate -g agentgate -m 700 /opt/agent-gate/drafts/sent
sudo install -d -o agentgate -g agentgate -m 700 /opt/agent-gate/drafts/denied
sudo install -d -o agentgate -g agentgate -m 700 /opt/agent-gate/drafts/failed
```

Then set watcher to `inbox` and have code atomically move to private `pending` before parsing/sending preview.

### B. Enforce draft immutability from preview to approval
Implement one of these (prefer both):

1. Ingestion move: on add in inbox, `rename()` to internal pending path owned by `agentgate` and `chmod 600`.
2. Hash bind: compute `sha256` at preview and include it in callback data or in-memory map; on approve, recompute and reject if mismatched.

Pseudo-flow:
- `inbox/foo.json` detected
- `rename(inbox/foo.json, pending/<uuid>.json)`
- compute hash, store in memory keyed by message/file
- approve only if current hash equals preview hash

### C. Lock down sudo correctly
Best practical model:
1. Run OpenClaw under a non-sudo account (`openclaw` or `devops-ai`).
2. Keep human admin access in separate account.
3. If `devops` must keep some sudo, allow only exact read/ops commands, no shell/editors.

Example `/etc/sudoers.d/devops-agentgate`:
```sudoers
Defaults:devops env_reset,use_pty
Cmnd_Alias AGENTGATE_SAFE = /usr/bin/systemctl status agent-gate.service, /usr/bin/systemctl restart agent-gate.service, /usr/bin/journalctl -u agent-gate.service -n 200 --no-pager

devops ALL=(root) NOPASSWD: AGENTGATE_SAFE
```

And remove any broad grant like `devops ALL=(ALL:ALL) ALL`.

### D. Validate residual send paths
Explicitly test whether the kept mailbox credential can send:

```bash
# As devops
swaks --server smtp.zoho.com:587 --tls --auth LOGIN \
  --auth-user 'engineer@johnnyr.dev' \
  --auth-password "$(pass email/zoho/engineer@johnnyr.dev)" \
  --from engineer@johnnyr.dev --to you@example.com --quit-after AUTH
```

If AUTH works, this is a bypass. Fix by moving reader to a different mailbox/credential with no send capability.

### E. Add stronger systemd hardening (easy wins)
In `agent-gate.service` add:

```ini
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
PrivateDevices=true
RestrictSUIDSGID=true
MemoryDenyWriteExecute=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
UMask=0077
SystemCallArchitectures=native
```

Keep `ReadWritePaths=/opt/agent-gate/drafts /opt/agent-gate/audit.log`.

### F. Prevent oversized draft DoS
Set size limits before parse (for example 256KB), reject bigger files to `failed`.

## 4. Overkill Check

1. **`pass` + dedicated GPG key is optional complexity.**
   - With proper Unix separation and no sudo, a root-owned `EnvironmentFile` readable only by `agentgate` is often enough.
   - If current team can operate pass cleanly, keep it; otherwise simplify to reduce operational mistakes.

2. **Copying full source tree to `/opt` is more than needed for runtime.**
   - Deploy only `dist/`, `package.json`, lockfile, config, and minimal runtime assets.

3. **ACL + SGID + shared primary group is too complex and currently wrong.**
   - A dedicated dropbox group/directory is simpler and safer.

## 5. Priority Order (Top 3 for today)

1. **Remove broad sudo path from AI-controlled account.**
   - This is the single largest risk reducer.
2. **Split inbox from internal pending and enforce immutable draft handoff.**
   - Prevents preview/approve mismatch attacks.
3. **Eliminate credential bypass via leftover mailbox password (verify and rotate/split).**
   - Otherwise "cannot send directly" is not true.

## 6. The Sudo Problem
The plan is correct that sudo is the elephant in the room, but the proposed rule is not sufficient.

- `devops ALL=(ALL) ALL` means full root if command execution is possible.
- Blocking `sudo -u agentgate` alone does not matter because root can read/modify anything anyway.

Best practical solution for your constraints:

1. Create separate AI runtime user with zero sudo:
```bash
sudo adduser --disabled-password --gecos '' devops-ai
sudo usermod -L devops-ai  # optional if only service-run account
```
2. Run OpenClaw as `devops-ai`.
3. Keep `devops` (human) for admin tasks, outside AI execution context.
4. If you cannot split users immediately, reduce `devops` sudo to explicit command allowlist only and remove broad grants.

## 7. Code Changes Needed

1. **`src/watcher.ts`**
   - Watch `inbox`, not `pending`.
   - On add: reject symlinks (`lstat`), enforce max file size, atomically `rename` into private pending dir.

2. **`src/bot.ts`**
   - Escape all user-controlled fields before Telegram rendering or switch to plain text.
   - Store and verify content hash at approval time.
   - Do not send raw provider errors to Telegram users.

3. **`src/executor.ts`**
   - Record sanitized error codes/messages in audit, not full upstream body.

4. **`src/providers/email-zoho.ts`**
   - Replace thrown raw API body with sanitized message + status code (log raw only in restricted debug logs if needed).

5. **`src/schema.ts`**
   - Add upper bounds (`max`) on subject/body/context/tag lengths and list sizes to cap resource abuse.

6. **`src/config.ts`**
   - Fail hard on unresolved env placeholders instead of substituting empty strings.
   - Optionally enforce secure file mode checks on config/audit paths at startup.

Bottom line: your isolation direction is correct, but today it is not yet a structural guarantee. With sudo removal/restriction + immutable inbox handoff + residual credential cleanup, it becomes materially strong.
