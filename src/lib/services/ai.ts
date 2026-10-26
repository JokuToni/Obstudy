import { invoke } from "@tauri-apps/api/core";
import type {
    AiConfiguration,
    AiIntegration,
    AiModel,
    AiProvider,
    AiResponse,
    OpenAiOauthAccount,
} from "$lib/types/ai";

/** Uses the selected integration; no provider-specific request data escapes this service. */
export function promptAi(prompt: string): Promise<AiResponse> {
    return invoke("prompt_ai", { prompt });
}

export function getAiConfiguration(): Promise<AiConfiguration> {
    return invoke("get_ai_configuration");
}

/** Omit apiKey to keep the integration's existing credential. Never save it in Store. */
export function saveAiIntegration(
    integration: AiIntegration,
    apiKey?: string,
): Promise<void> {
    return invoke("save_ai_integration", { integration, apiKey });
}

export function selectAiIntegration(integrationId: string): Promise<void> {
    return invoke("select_ai_integration", { integrationId });
}

export function removeAiIntegration(
    integrationId: string,
): Promise<boolean | null> {
    return invoke("remove_ai_integration", { integrationId });
}

/** Lists account-accessible models; availability does not guarantee text-endpoint compatibility. */
export function listAiModels(integrationId: string): Promise<AiModel[]> {
    return invoke("list_ai_models", { integrationId });
}

/** Last successful call for this integration, including the model used; not an account balance or live quota. */
export function getLastAiResponse(
    integrationId: string,
): Promise<AiResponse | null> {
    return invoke("get_last_ai_response", { integrationId });
}

/** Discover models without persisting an integration or its credential. */
export function discoverAiModels(
    provider: AiProvider,
    apiKey: string,
): Promise<AiModel[]> {
    return invoke("discover_ai_models", { provider, apiKey });
}

/** Starts native browser sign-in; OAuth credentials never cross IPC. */
export function connectOpenAiOauth(): Promise<OpenAiOauthAccount> {
    return invoke("connect_openai_oauth");
}
export function cancelOpenAiOauth(): Promise<void> {
    return invoke("cancel_openai_oauth");
}
export function getOpenAiOauthAccount(): Promise<OpenAiOauthAccount | null> {
    return invoke("get_openai_oauth_account");
}
export function listOpenAiOauthModels(): Promise<AiModel[]> {
    return invoke("list_openai_oauth_models");
}
export function disconnectOpenAiOauth(): Promise<boolean> {
    return invoke("disconnect_openai_oauth");
}
