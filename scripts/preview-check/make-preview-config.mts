import { readFileSync, writeFileSync } from "node:fs";
import { withPreviewConfig } from "/var/tmp/mono/packages/integrations/src/preview.ts";
const test = readFileSync("/var/tmp/mono/tests/preview.test.ts", "utf8");
const appSql = test.slice(test.indexOf("const APP_SQL = `") + 17, test.indexOf("`;\n\nasync function boot"));
const [schema, seed] = [appSql.split("insert into public.products")[0], "insert into public.products" + appSql.split("insert into public.products")[1]];
const files = withPreviewConfig({
  "supabase/migrations/00000000000000_platform_base.sql": readFileSync("/var/tmp/mono/templates/expo-base/overlay/supabase/migrations/00000000000000_platform_base.sql", "utf8"),
  "supabase/migrations/20261121150000_00_shop.sql": schema,
  "preview/seed.sql": seed,
});
writeFileSync("/var/tmp/expo-check/app/src/lib/preview/config.ts", files["src/lib/preview/config.ts"]!);
