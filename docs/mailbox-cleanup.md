# Human-gated Gmail Spam/Trash cleanup

This helper marks the currently unread messages in Gmail's server-declared **Spam** and **Trash** mailboxes as read. It exists for operators who use the production `gmail-smtp` App Password onboarding path and want to clear unread badges without giving Hermes mailbox credentials.

It does **not** delete, move, archive, empty, fetch, display, or summarize messages. Gmail continues to remove Spam and Trash according to Google's retention policy.

## Prerequisites

- agent-gate is installed with `scripts/install-production.sh`.
- Gmail SMTP onboarding has completed successfully:

  ```bash
  sudo /opt/agent-gate/scripts/smtp-setup.sh gmail
  ```

- `/opt/agent-gate/config/config.yaml` contains the verified `gmail-smtp` provider and a versioned `${PASS:agent-gate/...}` password reference.
- Run from a human-controlled local or SSH terminal. Non-interactive execution is rejected.

The send-only Gmail OAuth provider is not eligible. The helper intentionally reuses the isolated Gmail App Password because Gmail OAuth onboarding requests only `gmail.send`, which cannot read or modify mailbox flags.

## Run

```bash
sudo /opt/agent-gate/scripts/mailbox-cleanup.sh gmail
```

The helper will:

1. validate the root-owned installed wrapper and pinned system executables;
2. drop privileges to the isolated `agentgate` user with a clean environment;
3. read only the `gmail-smtp` provider and its App Password reference;
4. obtain the App Password internally from the `agentgate` password store;
5. connect only to `imap.gmail.com:993` with certificate-verified TLS;
6. locate exactly one server-declared `\Junk` and one `\Trash` mailbox;
7. snapshot unread message UIDs and each mailbox's UIDVALIDITY;
8. print counts only;
9. ask you to type the exact phrase `MARK READ`;
10. add `\Seen` only to the approved UID snapshot.

A new unread message arriving after the preview is not part of the approved UID snapshot and is not changed. If UIDVALIDITY changes before application, that folder is left incomplete rather than applying the snapshot to a different mailbox identity.

Example interaction:

```text
Gmail mailbox: you@gmail.com
Unread Spam: 14
Unread Trash: 3
Total unread to mark read: 17
Type MARK READ to mark exactly this unread Spam/Trash snapshot as read: MARK READ
Marked 17 messages as read. No messages were deleted or moved.
```

Any input other than the exact phrase `MARK READ` cancels without writing message flags.

## Outcomes

| Outcome | Meaning | Operator action |
|---|---|---|
| `no-op` | Both folders had zero unread messages | None |
| `cancelled` | Exact confirmation was not entered | None |
| `applied` | Both approved UID snapshots were submitted successfully | None |
| `partial` | One folder failed or could not verify its complete update after confirmation | Rerun the same command; adding `\Seen` is idempotent |
| Audit warning | Mailbox result completed, but the counts-only audit event could not be appended | Do not assume the mailbox action failed; repair `/opt/agent-gate/audit.log` permissions and inspect Gmail before rerunning |
| Fixed failure | Validation, credential lookup, TLS, authentication, discovery, or preview failed before a result | Correct the installation/account issue and rerun |

Provider/server diagnostics are not reflected to the terminal or audit log.

## Audit record

Each result attempts to append one JSONL event to `/opt/agent-gate/audit.log` with:

- timestamp;
- action (`mailbox-cleanup`);
- provider (`gmail-smtp`);
- authenticated mailbox address;
- outcome;
- unread Spam/Trash counts from the preview;
- snapshotted total;
- marked-read count;
- incomplete folder labels, if any.

No App Password, password-store key, message UID, sender, recipient, subject, body, header, or server diagnostic is recorded. The audit file is opened with no-symlink semantics and must remain owned by `agentgate` without group/other write permission.

## Security boundary

- The root wrapper accepts only the literal `gmail` operation; it has no folder, action, password, host, or provider override.
- It resolves `node`, `runuser`, `env`, and `pass` from a fixed root-owned, non-writable system path and passes their canonical absolute paths.
- The App Password never appears in arguments, environment variables, output, config, audit data, or Hermes-readable files.
- IMAP client logging and raw protocol logging are disabled.
- TLS endpoint, port, SNI, certificate verification, timeouts, and response-size bounds are fixed in code.
- Preview locks are read-only. Write locks verify UIDVALIDITY immediately before UID-based `STORE +FLAGS (\Seen)`.
- The helper never restarts or modifies the agent-gate service.

The human-controlled `sudo` invocation and exact confirmation phrase are the deterministic approval gate for this narrowly scoped mailbox mutation.

## Troubleshooting

### `Configured gmail-smtp provider is not eligible`

Run Gmail SMTP onboarding first. The helper requires the exact verified Gmail configuration: `smtp.gmail.com`, port `465`, implicit TLS, matching username/from address, and an isolated `${PASS:...}` reference.

### `Gmail mailbox cleanup failed before completion`

The public error is intentionally fixed. Common causes are revoked App Passwords, Gmail account policy changes, lack of network access, or missing/ambiguous IMAP special-use folders. Verify onboarding again rather than placing credentials in command arguments or config.

### `partial`

Rerun the command. Already-seen messages no longer match the unread search, and `\Seen` is idempotent. Review the new counts before confirming.

### Audit warning

Verify without printing the audit contents:

```bash
sudo stat -c '%U:%G %a %n' /opt/agent-gate/audit.log
```

Expected owner is `agentgate:agentgate`, with mode `640` (plus any installer-managed read-only ACL).
