// Terminal prompts. `interactive()` is the single rule for "may the CLI ask?": stdin and stdout are terminals and
// this is not CI. Anything that would ask falls back to its non-interactive default otherwise.

import { createInterface } from "node:readline/promises";

export function interactive(env: NodeJS.ProcessEnv = process.env, stdin: { isTTY?: boolean } = process.stdin, stdout: { isTTY?: boolean } = process.stdout): boolean {
  const ci = env.CI !== undefined && env.CI !== "" && env.CI !== "0" && env.CI.toLowerCase() !== "false";
  return !!stdin.isTTY && !!stdout.isTTY && !ci;
}

export interface Prompter {
  /** `yes` is the answer to an empty line. */
  yesNo(question: string, yes: boolean): Promise<boolean>;
  /** A line of text (`fallback` for an empty answer). Never use it for secrets. */
  line(question: string, fallback?: string): Promise<string>;
}

export const terminalPrompter: Prompter = {
  async yesNo(question, yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const a = (await rl.question(`${question} ${yes ? "[Y/n]" : "[y/N]"} `)).trim();
      return a ? /^y(es)?$/i.test(a) : yes;
    } finally {
      rl.close();
    }
  },
  async line(question, fallback) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const a = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ""} `)).trim();
      return a || fallback || "";
    } finally {
      rl.close();
    }
  },
};
