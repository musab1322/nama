"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { ExternalLink, Monitor, QrCode, RefreshCw, Smartphone, TabletSmartphone } from "lucide-react";
import { Alert, Button, Segmented, Spinner, cn } from "@/components/ui/index";
import { useT } from "@/i18n/client";
import type { DeploymentRow } from "@/components/workspace/Workspace";

type Device = "desktop" | "iphone" | "android";

/** Logical viewport of each device frame; the frame is scaled down to fit the panel. */
const DEVICES: Record<Device, { w: number; h: number; radius: number; bezel: number }> = {
  desktop: { w: 1280, h: 800, radius: 12, bezel: 0 },
  iphone: { w: 393, h: 852, radius: 54, bezel: 12 },
  android: { w: 412, h: 915, radius: 36, bezel: 10 },
};
const BUSY = new Set(["queued", "building", "uploading"]);

const withScheme = (u: string) => (u.startsWith("http") ? u : `https://${u}`);

export function PreviewPanel({
  currentVersionId,
  deployments,
  onBuild,
  productionUrl,
}: {
  currentVersionId: string | null;
  deployments: DeploymentRow[];
  onBuild: () => void | Promise<void>;
  productionUrl: string | null;
}) {
  const t = useT();
  const [device, setDevice] = useState<Device>("iphone");
  const [reloadKey, setReloadKey] = useState(0);
  const [showQr, setShowQr] = useState(false);
  const [requesting, setRequesting] = useState(false);

  const previews = deployments.filter((d) => d.target === "preview");
  const building = previews.find((d) => d.version_id === currentVersionId && BUSY.has(d.status));
  const readyCurrent = previews.find((d) => d.version_id === currentVersionId && d.status === "ready" && d.url);
  const readyAny = readyCurrent ?? previews.find((d) => d.status === "ready" && d.url);
  const failed = !building && !readyCurrent && previews.find((d) => d.version_id === currentVersionId && d.status === "error");
  const url = readyAny?.url ? withScheme(readyAny.url) : productionUrl;
  const stale = Boolean(url && !readyCurrent && currentVersionId);

  async function build() {
    setRequesting(true);
    try {
      await onBuild();
    } finally {
      setRequesting(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/40">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2">
        <Segmented<Device>
          label={t("ws.preview")}
          value={device}
          onChange={setDevice}
          options={[
            { value: "desktop", label: t("preview.desktop"), icon: <Monitor className="size-4" /> },
            { value: "iphone", label: t("preview.iphone"), icon: <Smartphone className="size-4" /> },
            { value: "android", label: t("preview.android"), icon: <TabletSmartphone className="size-4" /> },
          ]}
        />
        <div className="flex-1" />
        {url && (
          <>
            <Button variant="ghost" size="icon" onClick={() => setReloadKey((k) => k + 1)} aria-label={t("preview.refresh")} title={t("preview.refresh")}>
              <RefreshCw className="size-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => setShowQr((s) => !s)} aria-label={t("preview.qr")} title={t("preview.qr")} aria-pressed={showQr}>
              <QrCode className="size-4" />
            </Button>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex size-9 items-center justify-center rounded-xl hover:bg-muted"
              aria-label={t("preview.openTab")}
              title={t("preview.openTab")}
            >
              <ExternalLink className="size-4" />
            </a>
          </>
        )}
      </div>

      {(building || stale || failed) && (
        <div className="flex items-center gap-3 border-b border-border bg-card px-3 py-2 text-sm">
          {building ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Spinner />
              {t("preview.building")}
            </span>
          ) : (
            <>
              <span className={cn(failed ? "text-danger" : "text-muted-foreground")}>{failed ? t("common.error") : t("preview.stale")}</span>
              <Button size="sm" variant="outline" onClick={build} loading={requesting}>
                {failed ? t("common.retry") : t("preview.build")}
              </Button>
            </>
          )}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {url ? (
          <DeviceFrame device={device} url={url} reloadKey={reloadKey} />
        ) : (
          <div className="grid h-full place-items-center p-6">
            <div className="max-w-xs space-y-3 text-center">
              <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-accent text-primary">
                {building ? <Spinner className="size-6" /> : <Smartphone className="size-7" />}
              </div>
              <p className="text-sm text-muted-foreground">{building ? t("preview.building") : t("preview.none")}</p>
              {currentVersionId && !building && (
                <Button size="sm" onClick={build} loading={requesting}>
                  {t("preview.build")}
                </Button>
              )}
            </div>
          </div>
        )}
        {showQr && url && <QrPopover url={url} onClose={() => setShowQr(false)} />}
      </div>
    </div>
  );
}

function DeviceFrame({ device, url, reloadKey }: { device: Device; url: string; reloadKey: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const spec = DEVICES[device];
  const outerW = spec.w + spec.bezel * 2;
  const outerH = spec.h + spec.bezel * 2 + (device === "desktop" ? 36 : 0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      const pad = 32;
      setScale(Math.min(1, (el.clientWidth - pad) / outerW, (el.clientHeight - pad) / outerH));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [outerW, outerH]);

  return (
    <div ref={box} dir="ltr" className="absolute inset-0 grid place-items-center overflow-hidden">
      <div style={{ width: outerW * scale, height: outerH * scale }}>
        <div
          className={cn(
            "origin-top-left overflow-hidden shadow-2xl",
            device === "desktop" ? "border border-border bg-card" : "bg-[oklch(0.18_0_0)]",
          )}
          style={{ width: outerW, height: outerH, borderRadius: spec.radius + spec.bezel, padding: spec.bezel, transform: `scale(${scale})` }}
        >
          {device === "desktop" && (
            <div className="ltr flex h-9 items-center gap-1.5 border-b border-border bg-muted px-3" dir="ltr">
              <span className="size-3 rounded-full bg-[oklch(0.7_0.18_25)]" />
              <span className="size-3 rounded-full bg-[oklch(0.82_0.16_85)]" />
              <span className="size-3 rounded-full bg-[oklch(0.75_0.17_145)]" />
              <span className="ms-3 truncate rounded-md bg-card px-3 py-0.5 text-xs text-muted-foreground">{url.replace(/^https?:\/\//, "")}</span>
            </div>
          )}
          <div className="relative overflow-hidden bg-white" style={{ width: spec.w, height: spec.h, borderRadius: device === "desktop" ? 0 : spec.radius }}>
            {device === "iphone" && <span className="absolute left-1/2 top-3 z-10 h-8 w-28 -translate-x-1/2 rounded-full bg-black" aria-hidden />}
            {device === "android" && <span className="absolute left-1/2 top-3 z-10 size-4 -translate-x-1/2 rounded-full bg-black" aria-hidden />}
            <iframe
              key={`${url}:${reloadKey}`}
              src={url}
              title="preview"
              className="size-full border-0"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
              allow="clipboard-write; geolocation; camera; microphone"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function QrPopover({ url, onClose }: { url: string; onClose: () => void }) {
  const t = useT();
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(url, { margin: 1, width: 360, errorCorrectionLevel: "M" }).then((d) => alive && setSrc(d));
    return () => {
      alive = false;
    };
  }, [url]);
  const host = useMemo(() => url.replace(/^https?:\/\//, ""), [url]);

  return (
    <div className="absolute end-3 top-3 z-20 w-64 rounded-2xl border border-border bg-card p-4 shadow-xl" role="dialog" aria-label={t("preview.qr")}>
      <p className="font-medium">{t("preview.qr")}</p>
      <p className="mb-3 text-xs text-muted-foreground">{t("preview.qrHint")}</p>
      <div className="grid aspect-square place-items-center rounded-xl bg-white p-2">
        {src ? <img src={src} alt={url} className="size-full" /> : <Spinner />}
      </div>
      <p className="ltr mt-2 truncate text-center text-xs text-muted-foreground" dir="ltr">
        {host}
      </p>
      <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={onClose}>
        {t("common.close")}
      </Button>
    </div>
  );
}
