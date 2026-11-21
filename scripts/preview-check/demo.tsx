import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { supabase } from "@/lib/supabase";

export default function Demo() {
  const [log, setLog] = useState<string[]>(["starting"]);
  useEffect(() => {
    (async () => {
      const out: string[] = [];
      const p = await supabase.from("products").select("name, price_halalas").order("price_halalas");
      out.push(`products:${p.error ? p.error.message : p.data.map((x) => x.name).join("|")}`);
      const s = await supabase.auth.signUp({ email: "demo@example.com", password: "password-1" });
      out.push(`signup:${s.error ? s.error.message : "ok"}`);
      const o = await supabase.from("orders").insert({ note: "تجربة" }).select().single();
      out.push(`order:${o.error ? o.error.message : "ok"}`);
      const anon = await supabase.from("orders").select("id");
      out.push(`own_orders:${anon.data?.length ?? anon.error?.message}`);
      setLog(out);
    })().catch((e) => setLog([`crash:${String(e)}`]));
  }, []);
  return <View>{log.map((l) => <Text key={l} testID="line">{l}</Text>)}</View>;
}
