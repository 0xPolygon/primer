---
'@primer/api': patch
---

Security: clear the moderate and low npm audit advisories affecting the API service by raising the `hono` override floor to 4.13.16 (`mount()` middleware bypass, RegExpRouter skipping wildcard middleware, `csrf()` not checking `text/ping` requests, `validator('form')` skipping multipart bodies with extra parameters, `css` helper HTML injection) and the `@hono/node-server` floor to 2.1.6 (process crash on `ECONNRESET` during a WebSocket upgrade, backslash treated as a path separator behind a reverse proxy). Also removes the expired `body-parser` exemption from the 14-day release-age gate.
