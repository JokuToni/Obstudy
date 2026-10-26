export type AiProvider = "openai" | "anthropic" | "openaiOauth";

export interface AiIntegration {
    id: string;
    provider: AiProvider;
    model: string;
    maxOutputTokens: number;
    reasoningEffort?: string | null;
}

export interface AiConfiguration {
    integrations: AiIntegration[];
    activeIntegrationId: string | null;
}

export interface AiTokenUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
}

export interface AiRateLimits {
    /** Provider headers retain their original units and reset formats. */
    headers: Record<string, string>;
    observedAt: number;
}

export interface AiResponse {
    text: string;
    integrationId: string;
    provider: AiProvider;
    model: string;
    responseId: string | null;
    usage: AiTokenUsage;
    rateLimits: AiRateLimits;
}

export interface AiError {
    code:
        | "configuration"
        | "credentials"
        | "network"
        | "authentication"
        | "rateLimit"
        | "provider"
        | "invalidResponse"
        | "incomplete"
        | "reauthorizationRequired";
    message: string;
    status: number | null;
    rateLimits: AiRateLimits | null;
    providerCode?: string;
    requestId?: string;
}

export interface AiModel {
    id: string;
    name: string;
    effortLevels: string[];
}

export interface OpenAiOauthAccount {
    email: string | null;
    planEnabled: boolean;
    connected: boolean;
}
