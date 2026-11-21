import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import { Platform } from "react-native";
import { PREVIEW } from "./preview/config";
import { previewFetch } from "./preview/client";

// Injected per app at build time: each app has its own backend. The preview has none:
// it runs on a database inside the browser with demo data (no real user data).
const url = PREVIEW ? "https://preview.local" : process.env.EXPO_PUBLIC_SUPABASE_URL!;
const key = PREVIEW ? "preview" : process.env.EXPO_PUBLIC_SUPABASE_KEY!;

let ready: Promise<typeof fetch> | undefined;
const fetchViaPreview: typeof fetch = async (input, init) => (await (ready ??= previewFetch()))(input, init);

export const isPreview = PREVIEW;

export const supabase = createClient(url, key, {
  ...(PREVIEW ? { global: { fetch: fetchViaPreview } } : {}),
  auth: {
    storage: Platform.OS === "web" ? undefined : AsyncStorage,
    autoRefreshToken: !PREVIEW,
    persistSession: !PREVIEW, // the preview database starts fresh on every load
    detectSessionInUrl: Platform.OS === "web" && !PREVIEW,
  },
});

/** In-app account deletion (App Store Guideline 5.1.1(v)). Deletes the user and their data. */
export async function deleteAccount() {
  const { error } = await supabase.functions.invoke("delete-account", { method: "POST" });
  if (error) throw error;
  await supabase.auth.signOut();
}
