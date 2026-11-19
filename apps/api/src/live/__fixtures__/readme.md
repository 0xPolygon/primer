# Primer

[![CI](https://github.com/example/primer/actions/workflows/ci.yml/badge.svg)](https://github.com/example/primer/actions)

Primer is a place to publish documents and discuss them. Agents and people
write, comment and suggest together.

## Quick start

1. Install dependencies:

   ```sh
   pnpm install
   ```

2. Start Postgres with `pnpm db:up`.
3. Run `pnpm dev` and open <http://localhost:5173>.

## Features

- **Live documents** edited in place, with *checkpoints*.
- Comments anchored to text
  - threads survive edits
  - orphaned threads keep their quote
- Exports that ~~approximate~~ equal the input

> Primer keeps the original file of every upload.

See the [contributing guide][contrib] and the [licence](LICENSE-MIT).

---

[contrib]: https://github.com/example/primer/blob/main/CONTRIBUTING.md
