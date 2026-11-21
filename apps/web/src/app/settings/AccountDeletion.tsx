"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Alert, Button, Dialog, Field, Input } from "@/components/ui/index";
import { browserClient } from "@/lib/supabase/browser";
import { api, ApiError } from "@/lib/api-client";
import { useLocale } from "@/i18n/client";
import { fill, useStrings } from "@/i18n/strings";

const S = {
  ar: {
    delete: "حذف الحساب",
    title: "حذف حسابك نهائياً",
    what: "يحدث الآتي:",
    w1: "يتوقف تجديد اشتراكك الآن، وتُنسى بطاقتك المحفوظة.",
    w2: "بعد 7 أيام تُحذف قواعد بيانات تطبيقاتك وبيانات مستخدميها، وتُزال مواقعها، وتُحذف ملفاتك ومفاتيحك.",
    w3: "تطبيقاتك المنشورة في App Store وGoogle Play تبقى في حساباتك هناك، لكنها تتوقف عن العمل. احذفها من متجرك إن أردت.",
    w4: "سجلات الدفع تُحفظ دون اسمك كما يلزم النظام الضريبي.",
    exportFirst: "نزّل كود تطبيقاتك أولاً من إعدادات كل تطبيق إن أردت الاحتفاظ بها.",
    confirm: "اكتب بريدك للتأكيد",
    yes: "احذف حسابي",
    scheduled: "سيُحذف حسابك في {date}. يمكنك التراجع حتى ذلك الحين.",
    undo: "تراجع عن الحذف",
    undone: "أُلغي الحذف. التجديد ما زال متوقفاً؛ اشترك من صفحة الباقات إن أردت.",
    "err.confirmation_mismatch": "البريد لا يطابق حسابك.",
    error: "حدث خطأ. حاول مرة أخرى.",
    cancel: "إلغاء",
  },
  en: {
    delete: "Delete account",
    title: "Delete your account permanently",
    what: "What happens:",
    w1: "Your renewal stops now and your saved card is forgotten.",
    w2: "After 7 days your apps' databases and their users' data are deleted, their websites removed, and your files and keys deleted.",
    w3: "Apps you published on the App Store and Google Play stay in your own accounts there, but stop working. Remove them from your store if you want.",
    w4: "Payment records are kept without your name, as tax law requires.",
    exportFirst: "Download your apps' code first from each app's settings if you want to keep it.",
    confirm: "Type your email to confirm",
    yes: "Delete my account",
    scheduled: "Your account will be deleted on {date}. You can undo until then.",
    undo: "Undo deletion",
    undone: "Deletion canceled. Renewal is still off; subscribe again on the Plans page if you want.",
    "err.confirmation_mismatch": "The email doesn't match your account.",
    error: "Something went wrong. Try again.",
    cancel: "Cancel",
  },
};

export function AccountDeletion() {
  const s = useStrings(S);
  const locale = useLocale();
  const router = useRouter();
  const [scheduled, setScheduled] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  useEffect(() => {
    void browserClient().auth.getUser().then(async ({ data }) => {
      if (!data.user) return;
      const { data: p } = await browserClient().from("profiles").select("deletion_scheduled_for").eq("id", data.user.id).single();
      setScheduled((p?.deletion_scheduled_for as string | null) ?? null);
    });
  }, []);

  const date = (iso: string) => new Date(iso).toLocaleDateString(locale === "ar" ? "ar-SA-u-nu-latn" : "en-GB", { dateStyle: "long" });

  async function remove(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await api<{ scheduledFor: string }>("/api/account", { method: "DELETE", body: { confirmEmail: email } });
      setScheduled(res.scheduledFor);
      setOpen(false);
      router.refresh();
    } catch (err) {
      const key = err instanceof ApiError ? (`err.${err.code}` as keyof typeof s) : null;
      setMessage({ tone: "danger", text: key && key in s ? s[key] : s.error });
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    setBusy(true);
    try {
      await api("/api/account", { method: "PATCH", body: {} });
      setScheduled(null);
      setMessage({ tone: "success", text: s.undone });
    } catch {
      setMessage({ tone: "danger", text: s.error });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {message && !open && <Alert tone={message.tone}>{message.text}</Alert>}
      {scheduled ? (
        <Alert tone="warning" className="flex flex-wrap items-center gap-3">
          <span className="flex-1">{fill(s.scheduled, { date: date(scheduled) })}</span>
          <Button size="sm" variant="outline" onClick={undo} loading={busy}>{s.undo}</Button>
        </Alert>
      ) : (
        <Button variant="ghost" className="text-danger" onClick={() => { setMessage(null); setOpen(true); }}>
          <Trash2 className="size-4" />
          {s.delete}
        </Button>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title={s.title}>
        <form onSubmit={remove} className="space-y-4 text-sm">
          <p className="font-medium">{s.what}</p>
          <ul className="list-inside list-disc space-y-1.5 leading-relaxed">
            <li>{s.w1}</li>
            <li>{s.w2}</li>
            <li>{s.w3}</li>
            <li>{s.w4}</li>
          </ul>
          <Alert tone="info">{s.exportFirst}</Alert>
          <Field label={s.confirm}>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required dir="ltr" autoComplete="off" />
          </Field>
          {message && <Alert tone={message.tone}>{message.text}</Alert>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>{s.cancel}</Button>
            <Button type="submit" variant="danger" loading={busy}>{s.yes}</Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
