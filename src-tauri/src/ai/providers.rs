use super::{AiError, AiIntegration, AiProvider, AiResponse, AiTokenUsage};
use reqwest::{Client, RequestBuilder};
use serde_json::{Value, json};

impl AiProvider {
    pub fn request(
        &self,
        client: &Client,
        key: &str,
        method: reqwest::Method,
        endpoint: &str,
    ) -> RequestBuilder {
        match self {
            Self::Openai | Self::OpenaiOauth => client
                .request(method, format!("https://api.openai.com/v1/{endpoint}"))
                .bearer_auth(key),
            Self::Anthropic => client
                .request(method, format!("https://api.anthropic.com/v1/{endpoint}"))
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01"),
        }
    }

    pub fn prompt_request(
        &self,
        client: &Client,
        key: &str,
        config: &AiIntegration,
        prompt: &str,
    ) -> RequestBuilder {
        let (endpoint, mut body) = match self {
            Self::OpenaiOauth => ("responses", super::oauth::prompt_body(config, prompt)),
            Self::Openai => (
                "responses",
                json!({"model": config.model, "input": prompt, "max_output_tokens": config.maxOutputTokens, "store": false}),
            ),
            Self::Anthropic => (
                "messages",
                json!({"model": config.model, "max_tokens": config.maxOutputTokens, "messages": [{"role": "user", "content": prompt}]}),
            ),
        };
        if let Some(effort) = &config.reasoningEffort {
            match self {
                Self::Openai | Self::OpenaiOauth => body["reasoning"] = json!({"effort": effort}),
                Self::Anthropic => body["output_config"] = json!({"effort": effort}),
            }
        }
        self.request(client, key, reqwest::Method::POST, endpoint)
            .json(&body)
    }
}

pub fn parse_response(config: &AiIntegration, body: &Value) -> Result<AiResponse, AiError> {
    let mut segments = Vec::new();
    match config.provider {
        AiProvider::Openai | AiProvider::OpenaiOauth => {
            if body["status"] != "completed" {
                return Err(AiError::new(
                    "incomplete",
                    "The provider did not complete the response. Try a larger output limit or a different prompt.",
                ));
            }
            if let Some(output) = body["output"].as_array() {
                for item in output {
                    if item["type"] == "message" {
                        if let Some(content) = item["content"].as_array() {
                            for block in content {
                                if block["type"] == "refusal" {
                                    return Err(AiError::new(
                                        "provider",
                                        "The provider declined this request.",
                                    ));
                                }
                                if block["type"] == "output_text" {
                                    if let Some(text) = block["text"].as_str() {
                                        segments.push(text);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        AiProvider::Anthropic => {
            if body["stop_reason"] != "end_turn" && body["stop_reason"] != "stop_sequence" {
                return Err(AiError::new(
                    "incomplete",
                    "The provider stopped before completing a text answer. Try a larger output limit.",
                ));
            }
            if let Some(content) = body["content"].as_array() {
                for block in content {
                    if block["type"] == "text" {
                        if let Some(text) = block["text"].as_str() {
                            segments.push(text);
                        }
                    }
                }
            }
        }
    }
    let text = segments.join("\n");
    if text.trim().is_empty() {
        let providerName = match config.provider {
            AiProvider::OpenaiOauth => "ChatGPT",
            AiProvider::Openai => "OpenAI",
            AiProvider::Anthropic => "Anthropic",
        };
        let mut error = AiError::new(
            "invalidResponse",
            &format!(
                "{providerName} completed the request without an assistant text answer. Try again, or choose another model in AI integrations."
            ),
        );
        error.providerCode = Some("empty_output".into());
        return Err(error);
    }
    let usage = &body["usage"];
    let input = usage["input_tokens"].as_u64().ok_or_else(|| {
        AiError::new("invalidResponse", "The provider omitted input-token usage.")
    })?;
    let output = usage["output_tokens"].as_u64().ok_or_else(|| {
        AiError::new(
            "invalidResponse",
            "The provider omitted output-token usage.",
        )
    })?;
    let cached = match config.provider {
        AiProvider::Openai | AiProvider::OpenaiOauth => {
            usage["input_tokens_details"]["cached_tokens"]
                .as_u64()
                .unwrap_or(0)
        }
        AiProvider::Anthropic => usage["cache_read_input_tokens"].as_u64().unwrap_or(0),
    };
    let created = usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
    let total = match config.provider {
        AiProvider::Openai | AiProvider::OpenaiOauth => input + output,
        AiProvider::Anthropic => input + output + cached + created,
    };
    Ok(AiResponse {
        text,
        integrationId: config.id.clone(),
        provider: config.provider.clone(),
        model: body["model"].as_str().unwrap_or(&config.model).into(),
        responseId: body["id"].as_str().map(str::to_owned),
        usage: AiTokenUsage {
            inputTokens: input,
            outputTokens: output,
            totalTokens: total,
            cacheReadInputTokens: cached,
            cacheCreationInputTokens: created,
        },
        rateLimits: Default::default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(provider: AiProvider) -> AiIntegration {
        AiIntegration {
            id: "test".into(),
            provider,
            model: "selected-model".into(),
            maxOutputTokens: 2048,
            reasoningEffort: None,
        }
    }

    #[test]
    fn parses_openai_text_and_reasoning_token_usage() {
        let result = parse_response(&config(AiProvider::Openai), &json!({
            "id": "response-id", "model": "resolved-model", "status": "completed",
            "output": [{"type": "reasoning"}, {"type": "message", "content": [
                {"type": "output_text", "text": "First"}, {"type": "output_text", "text": "Second"}
            ]}],
            "usage": {"input_tokens": 100, "output_tokens": 20, "input_tokens_details": {"cached_tokens": 40}}
        })).unwrap();
        assert_eq!(result.text, "First\nSecond");
        assert_eq!(result.model, "resolved-model");
        assert_eq!(result.usage.totalTokens, 120);
        assert_eq!(result.usage.cacheReadInputTokens, 40);
    }

    #[test]
    fn parses_claude_without_returning_thinking_blocks() {
        let result = parse_response(&config(AiProvider::Anthropic), &json!({
            "stop_reason": "end_turn", "content": [{"type": "thinking", "thinking": "private"}, {"type": "text", "text": "Answer"}],
            "usage": {"input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 20, "cache_creation_input_tokens": 30}
        })).unwrap();
        assert_eq!(result.text, "Answer");
        assert_eq!(result.usage.totalTokens, 65);
    }

    #[test]
    fn refuses_partial_or_refused_answers() {
        assert_eq!(
            parse_response(
                &config(AiProvider::Openai),
                &json!({"status": "incomplete"})
            )
            .err()
            .unwrap()
            .code,
            "incomplete"
        );
        assert_eq!(
            parse_response(
                &config(AiProvider::Anthropic),
                &json!({"stop_reason": "max_tokens"})
            )
            .err()
            .unwrap()
            .code,
            "incomplete"
        );
        assert_eq!(parse_response(&config(AiProvider::Openai), &json!({"status": "completed", "output": [{"type": "message", "content": [{"type": "refusal"}]}]})).err().unwrap().code, "provider");
    }

    #[test]
    fn effort_is_serialized_for_the_selected_provider_and_omitted_by_default() {
        let client = Client::new();
        for provider in [
            AiProvider::Openai,
            AiProvider::OpenaiOauth,
            AiProvider::Anthropic,
        ] {
            let mut integration = config(provider);
            let default = provider
                .prompt_request(&client, "test-key", &integration, "Prompt")
                .build()
                .unwrap();
            let body: Value =
                serde_json::from_slice(default.body().unwrap().as_bytes().unwrap()).unwrap();
            assert!(body.get("reasoning").is_none());
            assert!(body.get("output_config").is_none());
            integration.reasoningEffort = Some("high".into());
            let request = provider
                .prompt_request(&client, "test-key", &integration, "Prompt")
                .build()
                .unwrap();
            let body: Value =
                serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
            let field = if provider == AiProvider::Anthropic {
                "output_config"
            } else {
                "reasoning"
            };
            assert_eq!(body[field]["effort"], "high");
        }
    }
    #[test]
    fn requests_use_the_selected_model_and_provider_specific_protocol() {
        let client = Client::new();
        for provider in [AiProvider::Openai, AiProvider::Anthropic] {
            let config = config(provider);
            let request = config
                .provider
                .prompt_request(&client, "test-key", &config, "My prompt")
                .build()
                .unwrap();
            let body: Value =
                serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
            assert_eq!(body["model"], "selected-model");
            match config.provider {
                AiProvider::Openai | AiProvider::OpenaiOauth => {
                    assert_eq!(
                        request.url().as_str(),
                        "https://api.openai.com/v1/responses"
                    );
                    assert_eq!(body["store"], false);
                    assert_eq!(body["input"], "My prompt");
                    assert!(request.headers().contains_key("authorization"));
                }
                AiProvider::Anthropic => {
                    assert_eq!(
                        request.url().as_str(),
                        "https://api.anthropic.com/v1/messages"
                    );
                    assert_eq!(body["messages"][0]["content"], "My prompt");
                    assert_eq!(body["max_tokens"], 2048);
                    assert!(request.headers().contains_key("x-api-key"));
                }
            }
        }
    }
}
