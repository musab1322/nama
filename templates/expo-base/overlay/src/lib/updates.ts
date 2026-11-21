import * as Updates from "expo-updates";
import { AppState } from "react-native";

/** Checks for an OTA update whenever the app returns to the foreground and applies it right away. */
export function enableForegroundUpdates() {
  if (__DEV__ || !Updates.isEnabled) return () => {};
  const sub = AppState.addEventListener("change", async (state) => {
    if (state !== "active") return;
    try {
      const res = await Updates.checkForUpdateAsync();
      if (res.isAvailable) {
        await Updates.fetchUpdateAsync();
        await Updates.reloadAsync();
      }
    } catch {
      // offline or no update server: keep running the current bundle
    }
  });
  return () => sub.remove();
}
