import type { BackendProvider, HostingMode } from "./provider";
export { saudiCellConfigured } from "./provider";
import { saudiCellProvider } from "./saudi-cell";
import { supabaseHostedProvider } from "./supabase-hosted";

const saudi = saudiCellProvider();

/** The provider for a backend's hosting mode. Saudi calls fail with ProviderUnavailableError until the cell is configured. */
export function providerFor(mode: HostingMode): BackendProvider {
  return mode === "standard" ? supabaseHostedProvider : saudi;
}

