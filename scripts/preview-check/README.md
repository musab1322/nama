# Preview feasibility check (ADR-010, T-08)

Proves that a real Expo web export of the template runs the app's own supabase-js
code against PGlite inside the browser, with RLS.

1. `npx create-expo-app@5.0.0 app --template default --no-install && cd app && npm install`
   then `npm install @supabase/supabase-js @react-native-async-storage/async-storage react-native-url-polyfill expo-web-browser`
2. Copy `templates/expo-base/overlay/.` into `app/`, set `expo.web.output = "static"` in app.json,
   replace `src/app/_layout.tsx` with a plain `<Stack />`, copy `demo.tsx` to `src/app/`.
3. `npx tsx make-preview-config.mts` (writes src/lib/preview/config.ts with the test schema and demo data).
4. `npx expo export --platform web --output-dir dist-preview`
5. `node browser-check.cjs` (serves dist-preview, maps the PGlite CDN to local node_modules).

Result on 2026-11-21 (Expo SDK 58, PGlite 0.5.17, Chromium): products listed from demo data,
sign-up ok, order inserted under RLS, user sees only their own order; ready in about 3 seconds.
Paths inside the scripts point at /var/tmp/expo-check and /var/tmp/mono; adjust when re-running.
