import { ScrollView, Text, View } from "react-native";
import { Stack } from "expo-router";
import { privacyNotice, NOTICE_VERSION } from "@/lib/privacy";
import { useLocale } from "@/components/PrivacyConsent";

/** Privacy notice screen (PDPL). Platform-owned; reachable from sign-up and the account page. */
export default function PrivacyScreen() {
  const locale = useLocale();
  const sections = privacyNotice(locale);
  return (
    <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
      <Stack.Screen options={{ title: locale === "ar" ? "إشعار الخصوصية" : "Privacy notice" }} />
      {sections.map((s) => (
        <View key={s.title} style={{ gap: 6 }}>
          <Text style={{ fontSize: 17, fontWeight: "600", textAlign: "auto" }}>{s.title}</Text>
          <Text style={{ fontSize: 15, lineHeight: 24, textAlign: "auto" }}>{s.body}</Text>
        </View>
      ))}
      <Text style={{ fontSize: 12, opacity: 0.6, textAlign: "auto" }}>{NOTICE_VERSION}</Text>
    </ScrollView>
  );
}
