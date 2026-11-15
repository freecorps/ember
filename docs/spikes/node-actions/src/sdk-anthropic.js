import Anthropic from "@anthropic-ai/sdk";
import { serve } from "./_serve.js";

export default serve({
  async run() {
    const ai = new Anthropic({ apiKey: "sk-ant-fake", maxRetries: 0 });
    const r = await ai.messages.create({ model: "claude-x", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
    let streamed = "";
    const s = ai.messages.stream({ model: "claude-x", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
    s.on("text", (t) => (streamed += t));
    await s.finalMessage();
    return { text: r.content[0].text, streamed };
  },
});
