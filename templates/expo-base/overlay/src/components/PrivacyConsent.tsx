import { I18nManager, Pressable, Text, View } from "react-native";
import { Link } from "expo-router";

/** "ar" when the layout is right-to-left. */
export function useLocale(): "ar" | "en" {
  return I18nManager.isRTL ? "ar" : "en";
}

/**
 * Consent checkbox for sign-up (PDPL). Platform-owned: sign-up must not submit
 * until `accepted` is true; after sign-up call acceptPrivacyNotice() from lib/privacy.
 */
export function PrivacyConsent({ accepted, onChange }: { accepted: boolean; onChange: (v: boolean) => void }) {
  const ar = useLocale() === "ar";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: accepted }}
        accessibilityLabel={ar ? "أوافق على إشعار الخصوصية" : "I accept the privacy notice"}
        onPress={() => onChange(!accepted)}
        style={{ width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: "#888", alignItems: "center", justifyContent: "center", backgroundColor: accepted ? "#2F5D46" : "transparent" }}
      >
        {accepted && <Text style={{ color: "white", fontWeight: "700" }}>✓</Text>}
      </Pressable>
      <Text style={{ flex: 1, textAlign: "auto" }}>
        {ar ? "قرأت " : "I have read "}
        <Link href="/privacy" style={{ textDecorationLine: "underline" }}>
          {ar ? "إشعار الخصوصية" : "the privacy notice"}
        </Link>
        {ar ? " وأوافق عليه." : " and accept it."}
      </Text>
    </View>
  );
}
