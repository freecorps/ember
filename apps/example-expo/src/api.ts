// Typed references to the backend in ../ember. After `npx ember dev` (codegen) you can import `api` from
// "../ember/_generated/api" instead; these hand-written ones keep the app type-checking without a codegen step.
import { makeFunctionReference } from "@ember/react-native";

export interface Message {
  _id: string;
  _creationTime: number;
  channel: string;
  author: string;
  body: string;
  edited?: boolean;
}

export interface Me {
  subject: string;
  email: string | null;
  profile: { name: string; email: string; credits: number } | null;
}

export const api = {
  messages: {
    list: makeFunctionReference<"query", { channel: string; limit?: number }, Message[]>("messages:list"),
    send: makeFunctionReference<"mutation", { channel: string; author: string; body: string }, { id: string; at: number }>("messages:send"),
  },
  users: {
    me: makeFunctionReference<"query", Record<string, never>, Me | null>("users:me"),
  },
  push: {
    register: makeFunctionReference<"mutation", { token: string; platform?: string; deviceName?: string }, string>("push:register"),
    unregister: makeFunctionReference<"mutation", { token: string }, boolean>("push:unregister"),
  },
};

/** Every shard-scoped call of this sample runs on the global shard (crons use it too). */
export const SHARD = "global:main";
export const CHANNEL = "general";
