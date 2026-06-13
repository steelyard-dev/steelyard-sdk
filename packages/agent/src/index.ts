import Anthropic from "@anthropic-ai/sdk";
import { Steelyard, type Merchant, type SteelyardError } from "@steelyard/client";
import type { Offer, Policies } from "@steelyard/core";

export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

export interface AgentOutput {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface AgentDeps {
  connect?: typeof Steelyard.connect;
  createAnthropic?: (apiKey: string) => AnthropicLike;
}

export interface AnthropicLike {
  messages: {
    create(input: {
      model: string;
      max_tokens: number;
      messages: { role: "user"; content: string }[];
    }): Promise<{ content: { type: string; text?: string }[] }>;
  };
}

export async function runAgent(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  output: AgentOutput = consoleOutput,
  deps: AgentDeps = {}
): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    output.stdout(helpText());
    return 0;
  }
  if (!parsed.merchant || !parsed.prompt) {
    output.stderr(helpText());
    return 1;
  }

  const connect = deps.connect ?? Steelyard.connect;
  const merchant = await connect(parsed.merchant);
  if (isError(merchant)) {
    output.stderr(formatError(merchant));
    return 1;
  }

  const apiKey = env.ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      const answer = await answerWithAnthropic(
        merchant,
        parsed.prompt,
        apiKey,
        env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
        deps.createAnthropic
      );
      output.stdout(answer);
      return 0;
    } catch (error) {
      output.stdout(`(LLM provider failed: ${(error as Error).message}; falling back to naive parser)`);
    }
  } else {
    output.stdout("(running without LLM; export ANTHROPIC_API_KEY for natural-language prompts)");
  }

  return runNaive(merchant, parsed.prompt, output);
}

export function parseNaivePrompt(prompt: string):
  | { action: "list" }
  | { action: "offer"; id: string }
  | { action: "policies" }
  | undefined {
  const normalized = prompt.trim().toLowerCase();
  if (/^(what|tell me|show)\b.*\bsell\b/.test(normalized)) return { action: "list" };
  const offer = /^(what|tell me|show)\b.*\boffer\s+([a-z0-9._:-]+)/i.exec(prompt.trim());
  if (offer?.[2]) return { action: "offer", id: offer[2] };
  if (/^(what|tell me|show)\b.*\bpolicies\b/.test(normalized)) return { action: "policies" };
  return undefined;
}

async function answerWithAnthropic(
  merchant: Merchant,
  prompt: string,
  apiKey: string,
  model: string,
  createAnthropic?: (apiKey: string) => AnthropicLike
): Promise<string> {
  const offers = await merchant.search("");
  if (isError(offers)) throw new Error(formatError(offers));
  const client = createAnthropic ? createAnthropic(apiKey) : new Anthropic({ apiKey });
  const message = await client.messages.create({
    model,
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content:
          `Answer this merchant catalog question: ${prompt}\n\n` +
          `Offers JSON:\n${JSON.stringify(offers)}\n\n` +
          "Answer naturally and name at least one offer when relevant."
      }
    ]
  });
  const text = message.content.find(isTextBlock)?.text.trim();
  if (!text) throw new Error("empty LLM response");
  return text;
}

async function runNaive(merchant: Merchant, prompt: string, output: AgentOutput): Promise<number> {
  const parsed = parseNaivePrompt(prompt);
  if (!parsed) {
    output.stderr("Try: what does this shop sell | show offer <id> | tell me policies");
    return 1;
  }
  if (parsed.action === "list") {
    const offers = await merchant.search("");
    return printResult(offers, output);
  }
  if (parsed.action === "offer") {
    const offer = await merchant.getOffer(parsed.id);
    return printResult(offer, output);
  }
  const policies = await merchant.getPolicies();
  return printResult(policies, output);
}

function printResult(value: Offer | Offer[] | Policies | SteelyardError, output: AgentOutput): number {
  if (isError(value)) {
    output.stderr(formatError(value));
    return 1;
  }
  output.stdout(JSON.stringify(value, null, 2));
  return 0;
}

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return (
    !!block &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

function parseArgs(argv: string[]): { merchant?: string; prompt?: string; help: boolean } {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const merchantIndex = argv.indexOf("--merchant");
  const merchant = merchantIndex >= 0 ? argv[merchantIndex + 1] : undefined;
  const promptParts = argv.filter((part, index) => index !== merchantIndex && index !== merchantIndex + 1);
  return { merchant, prompt: promptParts.join(" ").trim() || undefined, help: false };
}

function helpText(): string {
  return "Usage: steelyard-agent --merchant <url> \"what does this shop sell\"";
}

function formatError(error: SteelyardError): string {
  return error.error_detail ? `${error.error}: ${error.error_detail}` : error.error;
}

function isError(value: unknown): value is SteelyardError {
  return !!value && typeof value === "object" && typeof (value as { error?: unknown }).error === "string";
}

const consoleOutput: AgentOutput = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message)
};
