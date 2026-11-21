import { redirect } from "next/navigation";
import { userClient } from "@/lib/supabase/server";
import { BillingView, type PlanRow, type SubscriptionView } from "@/app/billing/BillingView";

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const supabase = await userClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login?next=/billing");
  const { status } = await searchParams;

  const [{ data: plans }, { data: subs }, { data: profile }, { data: org }, { count: publishedApps }] = await Promise.all([
    supabase
      .from("plans")
      .select("id, code, name_ar, name_en, price_halalas, billing_interval, monthly_credits, max_published_apps, features, charity_discount_pct")
      .eq("is_active", true)
      .order("sort_order"),
    supabase
      .from("subscriptions")
      .select("status, plan_id, current_period_end, grace_until, cancel_at_period_end, extra_apps")
      .in("status", ["trialing", "active", "past_due"])
      .limit(1),
    supabase.from("profiles").select("credits_balance").eq("id", auth.user.id).single(),
    supabase.from("organizations").select("kind, verification_status").maybeSingle(),
    supabase.from("projects").select("id", { count: "exact", head: true }).not("published_at", "is", null).neq("status", "archived"),
  ]);

  return (
    <BillingView
      plans={(plans ?? []) as PlanRow[]}
      subscription={((subs ?? [])[0] as SubscriptionView | undefined) ?? null}
      credits={profile?.credits_balance ?? 0}
      publishedApps={publishedApps ?? 0}
      verifiedCharity={org?.kind === "charity" && org.verification_status === "verified"}
      returnStatus={status === "paid" || status === "pending" || status === "failed" ? status : null}
    />
  );
}
