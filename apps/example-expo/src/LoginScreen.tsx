import { useState } from "react";
import { Button, StyleSheet, Text, TextInput, View } from "react-native";
import type { UseEmberAuthTokenResult } from "@ember/react-native";

export function LoginScreen({ auth }: { auth: UseEmberAuthTokenResult }) {
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "signIn") await auth.signIn({ email: email.trim(), password });
      else {
        const user = await auth.signUp({ email: email.trim(), password, name: name.trim() || email.split("@")[0]! });
        if (!user) setError("Check your email to verify the account, then sign in.");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Ember Chat</Text>
      {mode === "signUp" && <TextInput style={styles.input} placeholder="Name" value={name} onChangeText={setName} />}
      <TextInput
        style={styles.input}
        placeholder="Email"
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput style={styles.input} placeholder="Password" secureTextEntry value={password} onChangeText={setPassword} />
      {error && <Text style={styles.error}>{error}</Text>}
      <Button title={busy ? "…" : mode === "signIn" ? "Sign in" : "Create account"} disabled={busy || !email || !password} onPress={submit} />
      <Button
        title={mode === "signIn" ? "No account? Sign up" : "Have an account? Sign in"}
        onPress={() => setMode(mode === "signIn" ? "signUp" : "signIn")}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", padding: 24, gap: 12 },
  title: { fontSize: 28, fontWeight: "700", marginBottom: 12 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderColor: "#999", borderRadius: 8, padding: 12, fontSize: 16 },
  error: { color: "#c0392b" },
});
