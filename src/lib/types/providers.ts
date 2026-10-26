import type { AiProvider } from "./ai";

export const aiProviders: { id: AiProvider; label: string }[] = [
    { id: "openai", label: "OpenAI" },
    { id: "anthropic", label: "Anthropic" },
    { id: "openaiOauth", label: "OpenAI · ChatGPT plan" },
];

export function providerLabel(provider: AiProvider): string {
    return aiProviders.find((item) => item.id === provider)?.label ?? provider;
}
