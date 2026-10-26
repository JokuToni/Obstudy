#![allow(non_snake_case)]
use super::{AiError, AiIntegration, AiModel, AiProvider, AiState};
use serde_json::Value;

const LEVELS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max"];

// Match aliases and dated snapshots, never unrelated variants such as -chat or -pro.
fn matches_model(id: &str, base: &str) -> bool {
    id == base
        || id.strip_prefix(base).is_some_and(|suffix| {
            let bytes = suffix.as_bytes();
            bytes.len() == 11
                && bytes[0] == b'-'
                && bytes[5] == b'-'
                && bytes[8] == b'-'
                && bytes
                    .iter()
                    .enumerate()
                    .all(|(index, byte)| matches!(index, 0 | 5 | 8) || byte.is_ascii_digit())
        })
}

pub fn effort_levels(provider: AiProvider, id: &str, metadata: &Value) -> Vec<String> {
    if provider == AiProvider::Anthropic {
        // The Models API explicitly advertises per-level support.
        if let Some(effort) = metadata.pointer("/capabilities/effort") {
            return LEVELS
                .iter()
                .filter(|level| effort[**level]["supported"] == true && effort["supported"] == true)
                .map(|level| (*level).into())
                .collect();
        }
        // Older API versions may omit capabilities. Unknown models stay untunable.
        return Vec::new();
    }
    // OAuth model catalogs may advertise per-model reasoning choices directly.
    if let Some(levels) = metadata
        .get("supported_reasoning_levels")
        .and_then(Value::as_array)
    {
        return LEVELS
            .iter()
            .filter(|level| {
                levels
                    .iter()
                    .any(|item| item.as_str().or_else(|| item["effort"].as_str()) == Some(**level))
            })
            .map(|level| (*level).into())
            .collect();
    }
    let groups: &[(&[&str], &[&str])] = &[
        (
            &["gpt-6-astra", "gpt-6.1-sol"],
            &["low", "medium", "high", "xhigh", "max"],
        ),
        (
            &["gpt-6-sol", "gpt-6-luna", "gpt-5.6", "gpt-5.6-sol"],
            &["none", "low", "medium", "high", "xhigh", "max"],
        ),
        (
            &["gpt-5.2", "gpt-5.4", "gpt-5.5"],
            &["none", "low", "medium", "high", "xhigh"],
        ),
        (&["gpt-5.1"], &["none", "low", "medium", "high"]),
        (&["gpt-5"], &["minimal", "low", "medium", "high"]),
        (&["o3", "o3-mini", "o4-mini"], &["low", "medium", "high"]),
    ];
    groups
        .iter()
        .find(|(models, _)| models.iter().any(|base| matches_model(id, base)))
        .map(|(_, levels)| levels.iter().map(|level| (*level).into()).collect())
        .unwrap_or_default()
}

pub fn cache_models(
    state: &AiState,
    provider: AiProvider,
    models: &[AiModel],
) -> Result<(), AiError> {
    state
        .modelCatalogs
        .lock()
        .map_err(|_| AiError::new("configuration", "Unable to cache model capabilities."))?
        .insert(provider, models.to_vec());
    Ok(())
}

pub fn validate_effort(state: &AiState, integration: &AiIntegration) -> Result<(), AiError> {
    let Some(effort) = integration.reasoningEffort.as_ref() else {
        return Ok(());
    };
    let catalogs = state
        .modelCatalogs
        .lock()
        .map_err(|_| AiError::new("configuration", "Unable to read model capabilities."))?;
    let levels = catalogs
        .get(&integration.provider)
        .and_then(|models| models.iter().find(|model| model.id == integration.model))
        .map(|model| model.effortLevels.clone())
        .unwrap_or_else(|| effort_levels(integration.provider, &integration.model, &Value::Null));
    if !levels.contains(effort) {
        return Err(AiError::new(
            "configuration",
            "This effort level is not supported by the selected model. Reload available models and choose a supported level.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn saved_effort_round_trips_and_invalid_levels_are_rejected() {
        let state = AiState::default();
        let legacy = json!({"id":"openai", "provider":"openai", "model":"gpt-6.1-sol", "maxOutputTokens":100});
        let mut integration: AiIntegration = serde_json::from_value(legacy).unwrap();
        assert!(integration.reasoningEffort.is_none());
        assert!(validate_effort(&state, &integration).is_ok());
        integration.reasoningEffort = Some("high".into());
        let saved = serde_json::to_value(&integration).unwrap();
        assert_eq!(saved["reasoningEffort"], "high");
        let restored: AiIntegration = serde_json::from_value(saved).unwrap();
        assert!(validate_effort(&state, &restored).is_ok());
        integration.reasoningEffort = Some("none".into());
        assert!(validate_effort(&state, &integration).is_err());
        integration.provider = AiProvider::Anthropic;
        integration.model = "catalog-model".into();
        integration.reasoningEffort = Some("high".into());
        assert!(validate_effort(&state, &integration).is_err());
        cache_models(
            &state,
            AiProvider::Anthropic,
            &[AiModel {
                id: "catalog-model".into(),
                name: "Catalog model".into(),
                effortLevels: vec!["high".into()],
            }],
        )
        .unwrap();
        assert!(validate_effort(&state, &integration).is_ok());
    }
    #[test]
    fn capabilities_are_model_specific_and_metadata_takes_precedence() {
        assert!(
            effort_levels(AiProvider::Openai, "gpt-6.1-sol", &Value::Null).contains(&"max".into())
        );
        assert!(
            !effort_levels(AiProvider::Openai, "gpt-6.1-sol", &Value::Null)
                .contains(&"none".into())
        );
        assert!(
            effort_levels(AiProvider::Openai, "gpt-5.1-2025-11-13", &Value::Null)
                .contains(&"none".into())
        );
        for model in ["gpt-4.1", "gpt-5-chat-latest", "gpt-5-pro", "unknown"] {
            assert!(effort_levels(AiProvider::Openai, model, &Value::Null).is_empty());
        }
        assert_eq!(
            effort_levels(
                AiProvider::OpenaiOauth,
                "gpt-6.1-sol",
                &json!({"supported_reasoning_levels":[{"effort":"low"},{"effort":"high"}]})
            ),
            vec!["low", "high"]
        );
        assert_eq!(
            effort_levels(
                AiProvider::Anthropic,
                "claude",
                &json!({"capabilities":{"effort":{"supported":true,"low":{"supported":true},"high":{"supported":true},"max":{"supported":false}}}})
            ),
            vec!["low", "high"]
        );
        assert!(effort_levels(AiProvider::Anthropic, "claude", &Value::Null).is_empty());
    }
}
