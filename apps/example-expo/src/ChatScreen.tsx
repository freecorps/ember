import { useState } from "react";
import { Button, FlatList, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import { useConnectionState, useMutation, useQuery, type UseEmberAuthTokenResult } from "@ember/react-native";
import { api, CHANNEL, type Message } from "./api";
import { usePushRegistration } from "./usePushRegistration";

export function ChatScreen({ auth }: { auth: UseEmberAuthTokenResult }) {
  const me = useQuery(api.users.me, {});
  const messages = useQuery(api.messages.list, { channel: CHANNEL });
  const connection = useConnectionState();
  const push = usePushRegistration(me?.subject ?? null);
  const unregister = useMutation(api.push.unregister);
  const send = useMutation(api.messages.send).withOptimisticUpdate((store, args) => {
    // Show the message right away; the server's version replaces it when the mutation commits.
    const current = store.getQuery(api.messages.list, { channel: args.channel });
    if (!current) return;
    const optimistic: Message = { _id: `optimistic-${Date.now()}`, _creationTime: Date.now(), ...args };
    store.setQuery(api.messages.list, { channel: args.channel }, [optimistic, ...current]);
  });
  const [text, setText] = useState("");

  const author = me?.profile?.name || me?.email || "me";
  const onSend = () => {
    const body = text.trim();
    if (!body) return;
    setText("");
    // Queued (and persisted in AsyncStorage) while offline; sent when the socket is back.
    send({ channel: CHANNEL, author, body }).catch((e: unknown) => console.warn("[send]", e));
  };
  const onSignOut = async () => {
    if (push?.status === "granted") await unregister({ token: push.token }).catch(() => undefined);
    await auth.signOut();
  };

  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.header}>
        <Text style={styles.title}>#{CHANNEL}</Text>
        <Text style={styles.meta}>
          {connection.connected ? "live" : connection.online ? "connecting…" : "offline"}
          {connection.pendingMutations ? ` · ${connection.pendingMutations} pending` : ""}
          {push ? ` · push: ${push.status}` : ""}
        </Text>
        <Button title="Sign out" onPress={onSignOut} />
      </View>
      {messages === undefined ? (
        <Text style={styles.empty}>Loading…</Text>
      ) : (
        <FlatList
          inverted
          data={messages}
          keyExtractor={(m) => m._id}
          renderItem={({ item }) => (
            <View style={[styles.message, item._id.startsWith("optimistic-") && styles.pending]}>
              <Text style={styles.author}>{item.author}</Text>
              <Text>{item.body}</Text>
            </View>
          )}
          ListEmptyComponent={<Text style={styles.empty}>No messages yet.</Text>}
        />
      )}
      <View style={styles.composer}>
        <TextInput style={styles.input} placeholder={`Message #${CHANNEL}`} value={text} onChangeText={setText} onSubmitEditing={onSend} />
        <Button title="Send" onPress={onSend} disabled={!text.trim()} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: { padding: 16, gap: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: "#ccc" },
  title: { fontSize: 22, fontWeight: "700" },
  meta: { color: "#888" },
  empty: { padding: 24, color: "#888", textAlign: "center" },
  message: { paddingHorizontal: 16, paddingVertical: 8 },
  pending: { opacity: 0.5 },
  author: { fontWeight: "600" },
  composer: { flexDirection: "row", gap: 8, padding: 12, borderTopWidth: StyleSheet.hairlineWidth, borderColor: "#ccc" },
  input: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderColor: "#999", borderRadius: 8, paddingHorizontal: 12 },
});
