# Apple Passwords Changelog

## [Shorthand Search, Account Search and Local Icons] - {PR_MERGE_DATE}

- Search by a plain word (`github`, `grafana`) instead of a full domain, once a site has been searched in full
- Naming a host by its leading label returns that host, not every service sharing its registrable domain
- An `@` anywhere in the query searches usernames; a leading `@` lists accounts on that address domain
- Results show each site's own icon, read from the browser's local favicon cache
- Icons are fetched from a site directly when the browser has none cached, as its results are shown
- The APW binary is found on Intel Homebrew paths and on `PATH`, not only Apple Silicon

## [Updated] - 2026-08-21

- Updated extension to meet Raycast extension development criteria
- Updated for new version of `apw`
- Added Save Password command

## [Initial Version] - 2024-10-01

- Submitted the extension to Raycast
