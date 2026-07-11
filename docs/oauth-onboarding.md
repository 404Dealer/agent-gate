# Secure OAuth Onboarding

`agent-gate` can obtain Gmail, Outlook/Microsoft 365, and Zoho Mail send credentials without exposing authorization codes or tokens to Hermes.

## Security boundary

Run onboarding only from a human-controlled local console or SSH terminal:

```text
human terminal -> agentgate-owned OAuth process -> provider -> encrypted pass store
```

The production helper:

- must be launched by a human in a real TTY;
- drops from root to the isolated `agentgate` account with a clean environment;
- accepts no authorization code, token, or client-secret command-line option;
- binds callbacks only to remote `127.0.0.1`;
- validates a random `state` value and PKCE S256 for every browser callback flow;
- stops the callback listener after one successful or denied callback;
- validates returned scopes and authenticated mailbox identity;
- sends secrets to `pass` over child-process stdin, with a 30-second timeout;
- writes only versioned `${PASS:...}` references and safe metadata to `config.yaml`;
- atomically preserves private `0600` configuration;
- never prints authorization codes, access tokens, or refresh tokens;
- restarts `agent-gate` only after all persistence succeeds.

The installer keeps the root-invoked scripts and their directory root-owned so the `agentgate` service account cannot replace a helper before `sudo` execution.

> Do **not** invoke onboarding through Hermes or paste provider responses into chat. Hermes may install and verify the non-secret infrastructure; only the human runs authorization.

## Common prerequisites

1. Install `agent-gate` in production mode.
2. Initialize `/home/agentgate/.gnupg` and `/home/agentgate/.password-store`.
3. From a human-controlled terminal, store the dedicated approval-bot token first:

```bash
sudo /opt/agent-gate/scripts/configure-provider-secrets.sh telegram
```

4. Keep `defaults.provider: log` until onboarding and a controlled test succeed.
5. Verify the installed helper:

```bash
cd /opt/agent-gate
sudo scripts/oauth-setup.sh --help
```

## SSH loopback tunnel

All default browser flows use port `8765`. From the computer where the browser will run, open an SSH session with local forwarding.

For Gmail and Zoho, whose registered callbacks use `127.0.0.1`:

```bash
ssh -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:8765:127.0.0.1:8765 \
  YOUR_USER@YOUR_SERVER
```

For Outlook, whose Entra callback uses `localhost`, bind the local forward as `localhost` so both the registered hostname and local resolver behavior agree:

```bash
ssh -o ExitOnForwardFailure=yes \
  -L localhost:8765:127.0.0.1:8765 \
  YOUR_USER@YOUR_SERVER
```

Run the setup command inside that same SSH session. The callback process remains bound to remote `127.0.0.1`; it is never exposed on a LAN, Tailscale interface, or public IP.

Use the same port in registration and setup if you override it:

```bash
sudo scripts/oauth-setup.sh PROVIDER --port 9876
```

---

## Gmail

### Provider-side preparation

1. Create or select a Google Cloud project.
2. Enable the Gmail API.
3. Configure the OAuth consent screen.
4. Create an OAuth client of type **Desktop app**.
5. If the consent screen is in Testing, add the intended account as a test user.
6. Record the client ID. A Desktop client is public; `agent-gate` does **not** request or store a Google client secret.

The helper requests:

```text
openid
email
https://www.googleapis.com/auth/gmail.send
```

`openid email` is basic identity access used to bind the configured sender and approval preview to the verified authenticated Google account. `gmail.send` is the only Gmail data scope.

Google Desktop clients use a loopback redirect. With the default port, the helper uses and prints:

```text
http://127.0.0.1:8765/
```

### Durability and publication

`gmail.send` is a sensitive scope. For an External consent screen left in **Testing**, refresh tokens generally expire after seven days because this flow includes a non-basic Gmail scope. Configure the publishing state and verification appropriate to your deployment before relying on it for durable sending.

Google may return a refresh token only during qualifying authorization. The helper uses `prompt=consent` and refuses to persist an onboarding result without a refresh token. If prior consent prevents issuance, revoke the existing grant in the Google account and rerun onboarding.

### Run onboarding

With the SSH tunnel active:

```bash
cd /opt/agent-gate
sudo scripts/oauth-setup.sh gmail
```

The helper asks only for the public client ID and an optional display name, receives the PKCE callback, verifies the returned scopes and Google identity, then stores:

```text
agent-gate/google-client-id
agent-gate/google-refresh-token
```

No Google client secret is needed or stored.

---

## Outlook / Microsoft 365

### Recommended registration: authorization code + PKCE

1. Register an application in Microsoft Entra ID.
2. Choose an account audience matching the intended mailbox. To support Outlook.com/Hotmail personal accounts, select an audience that includes personal Microsoft accounts.
3. Under **Authentication**, add a **Mobile and desktop applications** redirect URI:

```text
http://localhost:8765/microsoft/oauth/callback
```

4. Add delegated Microsoft Graph permissions:
   - `Mail.Send`
   - `User.Read`
   - `Mail.ReadWrite` only when this registration will be used for a named mailbox profile
5. Do not create a client secret; this is a native/public client.
6. Leave **Allow public client flows** disabled unless the device-code fallback is required.

The helper also requests `offline_access` so Microsoft can issue a refresh token. `User.Read` is used during onboarding to retrieve `/me` and cryptographically bind the sender shown in approval previews to the account that authorized `Mail.Send`.

### Run the recommended flow

With the SSH tunnel active:

```bash
cd /opt/agent-gate
sudo scripts/oauth-setup.sh outlook
```

For bounded Inbox access, create a named profile instead. This explicitly requests delegated `Mail.ReadWrite` and atomically binds the resulting provider to the profile:

```bash
sudo scripts/oauth-setup.sh outlook --profile work
sudo scripts/oauth-setup.sh outlook --profile consulting
```

Run onboarding once per Outlook/Microsoft 365 account. Ordinary Outlook onboarding without `--profile` remains send-only and does not request `Mail.ReadWrite`. Both browser flows use authorization code + PKCE, state validation, and the exact `localhost` callback above. Tenant choices include:

| Tenant value | Intended accounts |
|---|---|
| `common` | Work/school plus personal accounts when registration permits |
| `organizations` | Work/school accounts only |
| `consumers` | Personal Microsoft accounts only |
| Tenant GUID/domain | One Entra tenant |

The provider persists Microsoft refresh-token replacements back to the isolated password store so token rotation survives service restarts.

For durable rotation, `refreshTokenKey` is accepted only when `refreshToken` is the exact matching `${PASS:key}` reference. Legacy environment-variable or literal-token configs may omit `refreshTokenKey`; sends remain compatible and replacements are reused in memory, but the operator should rerun the OAuth helper to migrate to durable rotation before relying on restart continuity.

### Device-code fallback

Device authorization is convenient for truly headless environments but current Microsoft guidance treats it as higher risk, and Conditional Access may block it. Use it only when the SSH-forwarded PKCE callback is unavailable:

```bash
cd /opt/agent-gate
sudo scripts/oauth-setup.sh outlook --device-code
```

For this fallback, enable **Allow public client flows** in the Entra app. The helper validates that the verification URL is an HTTPS Microsoft host, follows provider polling intervals, handles `authorization_pending` and `slow_down`, and stops on denial, invalid code, or expiry. No SSH tunnel is needed for the fallback.

The public-client flow stores:

```text
agent-gate/microsoft-client-id
agent-gate/microsoft-refresh-token
```

No Microsoft client secret is needed.

---

## Zoho Mail

### Provider-side preparation

1. Create a **Server-based Application** in Zoho API Console for the intended data center.
2. Register this exact redirect URI for the default port:

```text
http://127.0.0.1:8765/zoho/oauth/callback
```

3. Keep the Zoho client ID and client secret outside Hermes.

The helper requests:

```text
ZohoMail.messages.CREATE
ZohoMail.accounts.READ
```

It also sends `access_type=offline`, `prompt=consent`, random state, and PKCE S256. The account-read scope is used during onboarding to enumerate eligible account IDs and confirmed sender addresses. The human must explicitly select the sender; the helper never trusts the first API record automatically.

### Supported data centers

| Region | Accounts host | Mail API host |
|---|---|---|
| `us` | `accounts.zoho.com` | `mail.zoho.com` |
| `eu` | `accounts.zoho.eu` | `mail.zoho.eu` |
| `in` | `accounts.zoho.in` | `mail.zoho.in` |
| `au` | `accounts.zoho.com.au` | `mail.zoho.com.au` |
| `jp` | `accounts.zoho.jp` | `mail.zoho.jp` |
| `ca` | `accounts.zohocloud.ca` | `mail.zohocloud.ca` |
| `sa` | `accounts.zoho.sa` | `mail.zoho.sa` |

The selected region independently pins both Accounts and Mail API hosts. Arbitrary hosts are rejected. If Zoho returns `location` or `accounts-server` callback hints, they must match the selected allowlisted region; cross-data-center callbacks fail closed.

### Run onboarding

With the SSH tunnel active:

```bash
cd /opt/agent-gate
sudo scripts/oauth-setup.sh zoho
```

Choose the same data center used for the OAuth client and mailbox. The helper receives the exact callback, exchanges the code with PKCE, enumerates eligible senders, asks for an explicit selection, and stores the client credentials and refresh token directly in `agentgate`'s encrypted store. At send time, agent-gate reuses each Zoho access token until shortly before its provider-reported expiry to stay within Zoho token limits.

---

## Verification without revealing credentials

List secret **names** without printing values:

```bash
sudo -u agentgate env \
  HOME=/home/agentgate \
  GNUPGHOME=/home/agentgate/.gnupg \
  PASSWORD_STORE_DIR=/home/agentgate/.password-store \
  pass ls agent-gate
```

Check non-secret service health:

```bash
sudo systemctl status agent-gate --no-pager
sudo journalctl -u agent-gate -n 100 --no-pager
```

Do not run `pass show`, print config after secret resolution, or include token endpoint responses in support messages.

## First live test

The safest onboarding choice is **not** to change the default provider. Keep `defaults.provider: log`, submit a message to your own mailbox with the new provider selected explicitly, inspect the exact sender/recipient/body in Telegram, and approve only that controlled test. A live-provider approval sends real email.

## Revocation and recovery

If an authorization code, access token, refresh token, Zoho client secret, or approval/send credential reaches Hermes, chat history, logs, command arguments, or screenshots:

1. revoke the provider grant/token;
2. rotate the confidential client secret where applicable (Zoho);
3. remove the affected password-store entries;
4. rerun onboarding personally.

Deleting local traces is not a substitute for revocation.

## Official references

- [Google OAuth for native/desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google OAuth policies](https://developers.google.com/identity/protocols/oauth2/policies)
- [Gmail OAuth scope classification](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Microsoft authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- [Microsoft desktop/public-client registration](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-registration)
- [Microsoft device authorization grant](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code)
- [Microsoft Graph permissions](https://learn.microsoft.com/en-us/graph/permissions-reference)
- [Zoho server-based OAuth applications](https://www.zoho.com/developer/oauth/web-server-apps/overview.html)
- [Zoho OAuth client registration](https://www.zoho.com/developer/oauth/register-app.html)
- [Zoho Mail OAuth](https://www.zoho.com/mail/help/api/using-oauth-2.html)
- [Zoho Mail Accounts API](https://www.zoho.com/mail/help/api/get-all-users-accounts.html)
