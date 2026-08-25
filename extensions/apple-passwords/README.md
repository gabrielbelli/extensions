# Apple Passwords

Search and manage Apple Passwords (iCloud Keychain) from Raycast using the [APW](https://github.com/bendews/apw) CLI.

## Requirements

1. Install a [supported browser](https://github.com/bendews/apw) and iCloud Passwords extension
2. Install `apw` via Homebrew and start the daemon:

```sh
brew install bendews/tap/apw
brew services start apw
```

## Searching

`apw` answers questions about one site at a time, so a site has to be searched
by its full hostname once. After that it is remembered and the short form works:

- `github` finds an account stored against `github.com`
- `grafana` finds a service on your own domain, without also returning every
  other service sharing it

An `@` searches accounts rather than sites. `@example.com` lists every account
on that address domain; `me@example.com` finds that one.

Each result shows its own site icon, read from the favicon cache of the browser
`apw` already runs. Where the browser has none, it is fetched from that site
directly as the result is shown — never from a favicon service, which would
otherwise be told every domain you hold an account with.

Accounts you look up are remembered locally so the short form keeps working:
domains, usernames, whether a one-time code exists, and when each was last seen.
Passwords and one-time codes are never written to disk.

## Commands

### Apple Passwords

Search your keychain by URL or domain. Opening the command auto-detects the active browser tab's domain and loads matching logins immediately. You can also type any domain into the search bar manually.

Each result shows which secrets are available as tags — **Password** is always present, **OTP** appears for entries that have a one-time code. Actions:

| Action | Shortcut | Description |
|--------|----------|-------------|
| Copy Username | ↩ | Fill (or copy) the username |
| Copy Password | ⇧↩ | Fill (or copy) the password |
| Copy OTP | ⌘⇧↩ | Fill (or copy) the current one-time code |

If the daemon needs authentication, this command opens **Authenticate Apple Passwords** automatically.

### Save Apple Password

Save a new or updated login. The URL field is pre-filled from your active browser tab and the password field is pre-filled from the clipboard if it contains text.

Built-in password generator (⌘G):

| Type | Description |
|------|-------------|
| Random | Letters, digits, and symbols — configurable length (default 20) |
| Alphanumeric | Letters and digits only — configurable length (default 20) |
| Memorable | 4-word hyphenated passphrase |
| PIN | 6-digit numeric PIN |

When saving a login detected from the browser, the password is also copied or filled at the cursor (respecting the **Copy secrets** preference) before the save completes.

### Authenticate Apple Passwords

Sends an auth challenge to the APW daemon, which causes macOS to display a PIN. Enter the PIN to authenticate. On success the **Apple Passwords** search opens automatically.

## Preferences

| Preference | Default | Description |
|-----------|---------|-------------|
| APW CLI path | `/opt/homebrew/bin/apw` | Path to the `apw` binary |
| Copy secrets | Disabled | Copy secret values to the clipboard; disable to paste at the cursor instead |
| Cache timeout | `5` minutes | How long password list results are cached. Set to `0` to disable caching |
