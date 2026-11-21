# UI screenshots (T-16)

Local-only harness. No real services are contacted.

1. `node mock-base.mjs` starts a mock Supabase on :54321.
2. `source env.example.sh` (dummy values only), then `npx next build && npx next start -p 3100` in `apps/web`.
3. `node shots2.cjs [outDir]` captures screens 20..31; `node err.cjs` prints page errors.
