Search Apple Passwords from Raycast, through the local `apw` CLI.

Look a site up by a plain word rather than its full domain, copy passwords and one-time codes, and pair with the Apple Passwords helper inline when it asks for a code.

Typing an address instead of a site searches accounts: `@example.com` lists every account on that address domain, and `me@example.com` finds that one.

Each result carries its own site icon, read from the local favicon cache of the browser `apw` already drives. Where the browser has none, the icon is fetched from that site directly, so no third party is told which sites you hold an account with.

Accounts you have looked up are remembered locally — domains, usernames, whether a one-time code exists, and when each was last seen. Passwords and one-time codes are never written to disk by the extension.
