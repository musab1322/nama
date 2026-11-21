// In-app account deletion (App Store Guideline 5.1.1(v), PDPL). Platform-owned.
// Deleting the auth user cascades to every row that references it.
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const auth = req.headers.get("Authorization") ?? "";
  const url = Deno.env.get("SUPABASE_URL")!;
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) return new Response("Unauthorized", { status: 401 });
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { error: delError } = await admin.auth.admin.deleteUser(data.user.id);
  if (delError) return new Response(delError.message, { status: 500 });
  return new Response(JSON.stringify({ deleted: true }), { headers: { "Content-Type": "application/json" } });
});
