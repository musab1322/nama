"use client";

import { useState } from "react";
import { Flag } from "lucide-react";
import { LanguageSwitch } from "@/components/AppHeader";
import { Alert, Button, Card, Field, Input, Textarea, cn } from "@/components/ui/index";
import { api } from "@/lib/api-client";
import { useStrings } from "@/i18n/strings";

const REASONS = ["fraud", "illegal", "abuse", "privacy", "copyright", "other"] as const;

const S = {
  ar: {
    title: "الإبلاغ عن تطبيق",
    intro: "هذا التطبيق بُني على منصة بنّاء. إن رأيت فيه احتيالاً أو محتوى مخالفاً أو إساءة لبياناتك فأخبرنا، وسنراجعه.",
    reason: "نوع المشكلة",
    fraud: "احتيال",
    illegal: "محتوى مخالف للأنظمة",
    abuse: "إساءة أو تحرش",
    privacy: "إساءة استخدام بياناتي",
    copyright: "حقوق ملكية",
    other: "أخرى",
    details: "التفاصيل",
    email: "بريدك (اختياري، لنتواصل معك)",
    send: "أرسل البلاغ",
    thanks: "شكراً لك. استلمنا بلاغك وسنراجعه.",
    error: "تعذّر الإرسال. حاول مرة أخرى.",
  },
  en: {
    title: "Report an app",
    intro: "This app was built on the Banna platform. If you see fraud, unlawful content, or misuse of your data in it, tell us and we'll review it.",
    reason: "What's wrong",
    fraud: "Fraud",
    illegal: "Unlawful content",
    abuse: "Abuse or harassment",
    privacy: "Misuse of my data",
    copyright: "Copyright",
    other: "Other",
    details: "Details",
    email: "Your email (optional, so we can reply)",
    send: "Send report",
    thanks: "Thank you. We received your report and will review it.",
    error: "Couldn't send. Try again.",
  },
};

export function ReportForm({ slug }: { slug: string }) {
  const s = useStrings(S);
  const [reason, setReason] = useState<(typeof REASONS)[number]>("fraud");
  const [details, setDetails] = useState("");
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    try {
      await api("/api/reports", { body: { projectSlug: slug, reason, details: details || undefined, email: email || undefined } });
      setState("sent");
    } catch {
      setState("error");
    }
  }

  return (
    <main className="mx-auto max-w-lg space-y-4 px-4 py-10">
      <div className="flex justify-end"><LanguageSwitch /></div>
      <Card className="space-y-4 p-6">
        <h1 className="flex items-center gap-2 text-xl font-semibold"><Flag className="size-5 text-danger" />{s.title}</h1>
        <p className="ltr text-sm text-muted-foreground">{slug}</p>
        <p className="text-sm leading-relaxed">{s.intro}</p>
        {state === "sent" ? (
          <Alert tone="success">{s.thanks}</Alert>
        ) : (
          <form onSubmit={send} className="space-y-4">
            <fieldset className="space-y-1.5">
              <legend className="text-sm font-medium">{s.reason}</legend>
              <div className="flex flex-wrap gap-2">
                {REASONS.map((r) => (
                  <button key={r} type="button" aria-pressed={reason === r} onClick={() => setReason(r)} className={cn("rounded-full border px-3 py-1 text-sm", reason === r ? "border-primary bg-accent text-primary" : "border-border hover:bg-muted")}>
                    {s[r]}
                  </button>
                ))}
              </div>
            </fieldset>
            <Field label={s.details}><Textarea value={details} onChange={(e) => setDetails(e.target.value)} maxLength={4000} required minLength={5} /></Field>
            <Field label={s.email}><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={320} dir="ltr" /></Field>
            {state === "error" && <Alert tone="danger">{s.error}</Alert>}
            <Button type="submit" loading={state === "sending"} className="w-full">{s.send}</Button>
          </form>
        )}
      </Card>
    </main>
  );
}
