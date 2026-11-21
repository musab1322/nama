import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";
import { supabase, isPreview } from "./supabase";

/**
 * Payments through the app owner's own Moyasar account (FR-014). The amount is
 * always computed by the database (public.payment_amount_for); card details are
 * entered on Moyasar's hosted page and never touch this app.
 *
 * Use only for physical goods and services. Digital content consumed in the app
 * must use Apple in-app purchase on iOS (App Store guideline 3.1.1).
 */
export type PaymentResult = { status: "paid" | "failed" | "pending" | "canceled"; paymentId: string | null };

export async function pay(referenceType: string, referenceId: string): Promise<PaymentResult> {
  const returnUrl = Platform.OS === "web" ? window.location.href : `${process.env.EXPO_PUBLIC_APP_SCHEME ?? "app"}://payment-return`;
  const { data, error } = await supabase.functions.invoke("payments", {
    body: { action: "create", referenceType, referenceId, returnUrl },
  });
  if (error) throw error;
  if (isPreview || data.status === "paid") return { status: "paid", paymentId: data.paymentId };

  if (Platform.OS === "web") {
    window.location.assign(data.url); // comes back to returnUrl; call verifyPayment there
    return { status: "pending", paymentId: data.paymentId };
  }
  const result = await WebBrowser.openAuthSessionAsync(data.url, returnUrl);
  if (result.type !== "success") {
    const check = await verifyPayment(data.paymentId);
    return check.status === "paid" ? check : { status: "canceled", paymentId: data.paymentId };
  }
  return verifyPayment(data.paymentId);
}

export async function verifyPayment(paymentId: string): Promise<PaymentResult> {
  const { data, error } = await supabase.functions.invoke("payments", { body: { action: "verify", paymentId } });
  if (error) throw error;
  const status = data.status === "paid" ? "paid" : data.status === "initiated" ? "pending" : "failed";
  return { status, paymentId };
}
