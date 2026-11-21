"use client";

import { useEffect, useId, useState } from "react";
import { Alert, Spinner } from "@/components/ui/index";
import { useLocale } from "@/i18n/client";

/**
 * Moyasar's hosted payment form (card, mada, Apple Pay, STC Pay). Card data goes from
 * the browser to Moyasar only; we get back a payment id and confirm it on the server.
 * 🔎 Pin the form version to the one in Moyasar's current docs before going live.
 */
const MPF_VERSION = "1.15.0";
const BASE = `https://cdn.moyasar.com/mpf/${MPF_VERSION}`;

export interface MoyasarConfig {
  publishable_api_key: string;
  amount: number;
  currency: "SAR";
  description: string;
  callback_url: string;
  metadata: Record<string, string>;
  methods: string[];
  supported_networks: string[];
  credit_card: { save_card: boolean };
}

declare global {
  interface Window {
    Moyasar?: { init(config: Record<string, unknown>): void };
  }
}

let loading: Promise<void> | null = null;
function loadMoyasar(): Promise<void> {
  if (window.Moyasar) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `${BASE}/moyasar.css`;
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = `${BASE}/moyasar.js`;
    js.async = true;
    js.onload = () => resolve();
    js.onerror = () => {
      loading = null;
      reject(new Error("moyasar_load_failed"));
    };
    document.head.appendChild(js);
  });
  return loading;
}

export function MoyasarForm({ config }: { config: MoyasarConfig }) {
  const locale = useLocale();
  const id = `mysr-${useId().replace(/:/g, "")}`;
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    let cancelled = false;
    loadMoyasar()
      .then(() => {
        if (cancelled || !window.Moyasar) return;
        window.Moyasar.init({ ...config, element: `#${id}`, language: locale });
        setState("ready");
      })
      .catch(() => !cancelled && setState("failed"));
    return () => {
      cancelled = true;
    };
  }, [config, id, locale]);

  return (
    <div className="space-y-2">
      {state === "loading" && <Spinner />}
      {state === "failed" && (
        <Alert tone="danger">{locale === "ar" ? "تعذّر تحميل نموذج الدفع. تحقق من اتصالك وحاول مرة أخرى." : "The payment form couldn't load. Check your connection and try again."}</Alert>
      )}
      <div id={id} className="mysr-form" dir={locale === "ar" ? "rtl" : "ltr"} />
    </div>
  );
}
