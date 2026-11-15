import OpenAI from "openai";
import { serve } from "./_serve.js";

export default serve({
  async run() {
    const ai = new OpenAI({ apiKey: "sk-fake", maxRetries: 0 });
    const r = await ai.chat.completions.create({ model: "gpt-x", messages: [{ role: "user", content: "hi" }] });
    let streamed = "";
    const s = await ai.chat.completions.create({ model: "gpt-x", messages: [{ role: "user", content: "hi" }], stream: true });
    for await (const ch of s) streamed += ch.choices[0]?.delta?.content ?? "";
    return { text: r.choices[0].message.content, streamed };
  },
});
