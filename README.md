# pi-agent-daemon

Standalone local daemon for Pi coding agent sessions.

The daemon owns the TypeScript/Deno runtime that talks to
`@earendil-works/pi-coding-agent`. SDKs and gateways connect to it over a small
newline-delimited JSON RPC protocol.

## Install

```sh
deno task compile
```

The binary is written to `dist/pi-agent-daemon`.

## Run

```sh
pi-agent-daemon serve --socket /tmp/pi-agent.sock
```

Use `--cwd` when running from a service manager:

```sh
pi-agent-daemon serve --socket /tmp/pi-agent.sock --cwd "$HOME"
```

TCP is also supported for local development:

```sh
pi-agent-daemon serve --tcp 127.0.0.1:7777
```

See [docs/services.md](docs/services.md) for systemd and launchd setup.

## Protocol

Requests and responses are newline-delimited JSON.

Client request:

```json
{ "id": 1, "method": "create_session", "params": {} }
```

Server event:

```json
{ "id": 1, "event": "text_delta", "data": { "delta": "hello" } }
```

Server result:

```json
{ "id": 1, "result": { "session_id": "s1" } }
```

Supported methods:

- `configure`: `{ providers?, auth?, auth_path? }`
- `create_session`: `{ system_prompt?, tools?, model?, cwd? }`
- `prompt`: `{ session_id, message }`
- `dispose_session`: `{ session_id }`
- `auth_status`: `{ provider? }` — report auth status without exposing credentials (one
  provider, or a map of all known/configured providers)
- `auth_login`: `{ provider, method? }` — start an OAuth login (`anthropic`,
  `openai-codex`, `github-copilot`, …); `method` picks a login method up front (e.g.
  `device_code`) to skip the `auth_select` round-trip
- `auth_input`: `{ prompt_id, value? }` — answer a pending prompt/selection (omit/null
  `value` to cancel)
- `auth_cancel`: `{ login_id }` — abort an in-flight login
- `shutdown`: `{}`

### OAuth login flow

`auth_login` runs in the background so the connection keeps accepting requests while the
user authenticates. It streams events under the request `id`:

- `auth_url`: `{ url, instructions }` — open this URL to authorize
- `device_code`: `{ user_code, verification_uri, interval_seconds, expires_in_seconds }`
- `auth_progress`: `{ message }`
- `auth_prompt`: `{ prompt_id, message, placeholder, allow_empty }` — reply with
  `auth_input`
- `auth_select`: `{ prompt_id, message, options: [{ id, label }] }` — reply with
  `auth_input` (the selected option `id`)

To avoid re-authenticating on every launch, a client can name a file-backed store with
`configure { auth_path }` (absolute path). The daemon then loads, saves, refreshes, and
locks credentials in that file, so `auth_login` persists straight through and later
launches only need to pass `auth_path` again — no inline `auth` map and no client-side
refresh logic. `auth_path` takes precedence over an inline `auth` map.

On success the result carries the new credential and the full auth map so the caller can
persist it and re-`configure` later:

```json
{
  "id": 7,
  "result": {
    "provider": "openai-codex",
    "credential": { "type": "oauth", "...": "..." },
    "auth": { "openai-codex": { "...": "..." } }
  }
}
```

The ready frame includes the daemon, upstream Pi agent, and protocol versions:

```json
{
  "ready": true,
  "daemon": "pi-agent-daemon",
  "version": "0.80.2",
  "pi_agent_version": "0.80.2",
  "protocol_version": "4.0.0",
  "transport": "unix"
}
```

## Release

Release versions mirror upstream `@earendil-works/pi-coding-agent` versions. For
example, daemon tag `v0.79.0` embeds Pi agent `0.79.0`.

If the daemon needs a daemon-only patch while staying on the same upstream Pi agent
version, use SemVer build metadata:

```sh
deno task prepare-release -- --pi-version 0.79.0 --daemon-version 0.79.0+dev.1
git tag v0.79.0+dev.1
```

The scheduled sync workflow checks upstream Pi releases and opens a release-prep PR when
the latest Pi version does not have a matching daemon release. The release workflow
builds standalone binaries for macOS and Linux targets from `v*` tags.

## Validation

`deno task e2e` runs the daemon against a local fake OpenAI-compatible provider. It
exercises the real daemon process, Unix-socket RPC, provider registration, session
creation, and prompt flow without calling a paid model.
