import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, SafeAreaView, StyleSheet } from "react-native";
import { EmberProvider, useEmberAuthToken } from "@freecorps/ember-react-native";
import { ChatScreen } from "./ChatScreen";
import { authClient, emberClient } from "./ember";
import { LoginScreen } from "./LoginScreen";

function Gate() {
  const auth = useEmberAuthToken(authClient);
  if (auth.isLoading) return <ActivityIndicator style={styles.fill} />;
  return auth.isAuthenticated ? <ChatScreen auth={auth} /> : <LoginScreen auth={auth} />;
}

export default function App() {
  return (
    <EmberProvider client={emberClient}>
      <SafeAreaView style={styles.fill}>
        <Gate />
      </SafeAreaView>
      <StatusBar style="auto" />
    </EmberProvider>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
