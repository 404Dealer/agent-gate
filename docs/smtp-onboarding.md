# Gmail App Password SMTP Onboarding

This is the simplest self-hosted Gmail path for agent-gate. It uses Gmail's authenticated SMTP service, similar to common Himalaya configurations, and does **not** require a Google Cloud project, OAuth consent screen, Gmail API enablement, client ID, callback URL, or OAuth app verification.

## Security trade-off

| Method | Setup | Credential scope |
|--------|-------|------------------|
| Gmail App Password + SMTP | Simple | Broad, long-lived Google mail credential |
| Gmail API OAuth (`gmail.send`) | More involved | Narrow send-only API scope |

Google recommends OAuth/“Sign in with Google” where available. An App Password is easier for a self-hosted operator, but it is more powerful than the Gmail API `gmail.send` refresh token. Keep it only under the isolated `agentgate` Unix user and revoke it when no longer needed.

Hermes must never receive, type, print, or store the App Password. The human enters it directly into the installed root-owned setup wrapper from a terminal Hermes is not controlling.

## Prerequisites

1. A Gmail or compatible Google Workspace account.
2. Google 2-Step Verification enabled.
3. App Passwords permitted for the account.
4. The production installer completed and the separate Telegram approval-bot token stored.

Google may hide App Passwords when:

- 2-Step Verification is not enabled;
- 2-Step Verification is configured only with security keys;
- the account is enrolled in Advanced Protection; or
- a managed Google Workspace policy disables App Passwords.

See Google's official guidance: [Sign in with app passwords](https://support.google.com/accounts/answer/185833).

## One-time setup

### 1. Store the approval-bot token first

Run personally from a human-controlled SSH/local terminal:

```bash
sudo /opt/agent-gate/scripts/configure-provider-secrets.sh telegram
```

### 2. Create a dedicated Google App Password

1. Open [Google App Passwords](https://myaccount.google.com/apppasswords) in your own browser.
2. Sign in and complete 2-Step Verification.
3. Create a password named `agent-gate`.
4. Keep the generated value on screen only until the next step.

Do not paste it into Telegram, Hermes, shell arguments, environment variables, issue comments, or configuration files.

### 3. Run the Gmail SMTP setup helper

```bash
sudo /opt/agent-gate/scripts/smtp-setup.sh gmail
```

The helper prompts for:

- Gmail address;
- optional sender display name;
- Google App Password in a hidden TTY prompt; and
- whether `gmail-smtp` should become the default provider.

The wrapper then:

1. verifies that it and the installed runtime are root-owned and not writable by non-root users;
2. drops privileges to `agentgate` with a clean environment;
3. normalizes Google's grouped 16-character App Password;
4. verifies authentication against `smtp.gmail.com:465` with certificate-verified implicit TLS;
5. stores one versioned password under the `agentgate` `pass` store;
6. atomically writes only a `${PASS:...}` reference plus safe sender metadata to private config;
7. restarts `agent-gate.service`; and
8. requires three consecutive active health checks.

The password is never printed. SMTP provider error responses are replaced with fixed redacted messages.

## Resulting provider config

The helper writes a provider equivalent to:

```yaml
providers:
  gmail-smtp:
    type: email-smtp
    host: smtp.gmail.com
    port: 465
    tlsMode: implicit
    username: you@gmail.com
    password: "${PASS:agent-gate/smtp-password-<version>}"
    fromAddress: you@gmail.com
    displayName: Your Name
```

`fromAddress` is trusted provider configuration. A draft's optional `from` field is ignored in both the approval preview and SMTP send.

## Generic authenticated SMTP

The runtime provider also supports manually configured authenticated SMTP servers:

```yaml
providers:
  work-smtp:
    type: email-smtp
    host: smtp.example.com
    port: 587
    tlsMode: starttls
    username: you@example.com
    password: "${PASS:agent-gate/smtp-password-work}"
    fromAddress: you@example.com
    displayName: Your Name
```

By default, `fromAddress` must match `username` case-insensitively. If the SMTP server uses a non-email login or the operator has independently verified a permitted sender alias, set `allowFromAlias: true` explicitly. Server-side rewriting can still change the final sender, so test aliases before production use.

Allowed TLS modes:

- `implicit`: TLS from connection start, commonly port `465`;
- `starttls`: plaintext connection upgraded with **required** STARTTLS, commonly port `587`.

Unencrypted SMTP is not supported. Certificate verification is always enabled. The Gmail setup helper currently uses only the fixed Gmail preset; custom SMTP metadata must be configured manually by the human operator.

## Partial recipient delivery

SMTP can accept some approved recipients while rejecting others. Agent-gate treats this as a non-retryable partial result:

- the draft is archived under `sent`, not `failed`, because retrying could duplicate delivery;
- audit records action `partial`, accepted/rejected counts, and rejected addresses only when they match the approved recipient list;
- Telegram displays an explicit partial-delivery alert and reply;
- if delivery is accepted but local archive/audit finalization fails, Telegram reports an accepted-delivery record warning rather than a send failure; and
- the operator should create a new draft only for rejected recipients after confirming the original outcome.

## Revocation

To remove Gmail SMTP capability:

1. Open [Google App Passwords](https://myaccount.google.com/apppasswords).
2. Delete the `agent-gate` App Password.
3. Remove or disable the `gmail-smtp` provider in private agent-gate config.
4. Restart `agent-gate.service`.

Google also revokes App Passwords after a Google Account password change.

## Troubleshooting

### App Passwords is not visible

Confirm 2-Step Verification is enabled. Then check for Advanced Protection, security-key-only 2SV, or a Workspace policy that blocks App Passwords. If App Passwords remains unavailable, use [OAuth onboarding](oauth-onboarding.md).

### `SMTP credential verification failed`

The helper intentionally does not show Google's raw response. Check:

- the account address is correct;
- the value is the dedicated App Password, not the normal Google password;
- all 16 characters were copied;
- the App Password has not been revoked; and
- outbound TCP port 465 is allowed.

Create a new dedicated App Password and retry if needed.

### Service does not remain active

```bash
sudo systemctl status agent-gate --no-pager
sudo journalctl -u agent-gate -n 100 --no-pager
```

Service logs should contain only fixed/redacted SMTP failures, never the App Password or raw SMTP response.
