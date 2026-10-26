#![allow(non_snake_case)]

use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

static BROAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\*\*(.+?)\*\*\s*$").unwrap());
static SUB: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\d+\. +\*\*(.+?)\*\*(?:[ \t]+(.*))?$").unwrap());
static STUDY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|\s)#STUDY(?:$|[\s.,;:!?])").unwrap());

#[derive(Clone, Debug, Serialize)]
pub struct ParsedBroadTopic {
    pub title: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct ParsedSubtopic {
    pub title: String,
    pub text: String,
    pub broadTopicIndex: Option<usize>,
}
#[derive(Clone, Debug, Serialize)]
pub struct TopicParseResult {
    pub broadTopics: Vec<ParsedBroadTopic>,
    pub subtopics: Vec<ParsedSubtopic>,
    pub coverage: f64,
    pub warnings: Vec<String>,
}

pub fn split_frontmatter(text: &str) -> Result<(Option<serde_yaml_ng::Value>, &str), String> {
    let text = text.trim_start_matches('\u{feff}');
    let firstEnd = text.find('\n').unwrap_or(text.len());
    if text[..firstEnd].trim_end() != "---" {
        return Ok((None, text));
    }
    let mut offset = firstEnd + 1;
    for line in text.get(offset..).unwrap_or("").split_inclusive('\n') {
        if matches!(line.trim(), "---" | "...") {
            let yaml = serde_yaml_ng::from_str(&text[firstEnd + 1..offset])
                .map_err(|_| "The YAML frontmatter is invalid.".to_string())?;
            return Ok((Some(yaml), &text[offset + line.len()..]));
        }
        offset += line.len();
    }
    Err("The YAML frontmatter has no closing delimiter.".into())
}

pub fn has_study_tag(text: &str) -> Result<bool, String> {
    let (frontmatter, body) = split_frontmatter(text)?;
    if let Some(frontmatter) = frontmatter {
        let tags = &frontmatter["tags"];
        let matches = |tag: &str| tag.trim().trim_start_matches('#') == "STUDY";
        if tags.as_str().is_some_and(|tags| {
            tags.split(|c: char| c.is_whitespace() || c == ',')
                .any(matches)
        }) || tags
            .as_sequence()
            .is_some_and(|tags| tags.iter().filter_map(|tag| tag.as_str()).any(matches))
        {
            return Ok(true);
        }
    }
    let mut inCode = false;
    let mut inLink = false;
    for event in Parser::new(body) {
        match event {
            Event::Start(Tag::CodeBlock(_)) => inCode = true,
            Event::End(TagEnd::CodeBlock) => inCode = false,
            Event::Start(Tag::Link { .. } | Tag::Image { .. }) => inLink = true,
            Event::End(TagEnd::Link | TagEnd::Image) => inLink = false,
            Event::Text(text) if !inCode && !inLink && STUDY.is_match(&text) => return Ok(true),
            _ => {}
        }
    }
    Ok(false)
}

pub fn extract_topics(text: &str) -> Result<TopicParseResult, String> {
    let (_, body) = split_frontmatter(text)?;
    let mut result = TopicParseResult {
        broadTopics: Vec::new(),
        subtopics: Vec::new(),
        coverage: 0.0,
        warnings: Vec::new(),
    };
    // Topic titles start at column zero; code blocks and HTML are never titles.
    let excluded: Vec<_> = Parser::new(body)
        .into_offset_iter()
        .filter_map(|(event, range)| {
            matches!(event, Event::Start(Tag::CodeBlock(_)) | Event::Html(_)).then_some(range)
        })
        .collect();
    let mut parent = None;
    let mut activeSubtopic: Option<usize> = None;
    let mut bodyLines = 0;
    let mut coveredLines = 0;
    let mut offset = 0;
    for line in body.split_inclusive('\n') {
        let inExcluded = excluded.iter().any(|range| range.contains(&offset));
        offset += line.len();
        let trimmed = line.trim();
        if !trimmed.is_empty() && trimmed != "#STUDY" {
            bodyLines += 1;
        }
        if !inExcluded {
            if let Some(captures) = SUB.captures(line.trim_end()) {
                let title = captures[1].trim().trim_matches('"').trim().to_string();
                if !title.is_empty() {
                    let annotation = captures
                        .get(2)
                        .map(|value| value.as_str().trim())
                        .unwrap_or("");
                    result.subtopics.push(ParsedSubtopic {
                        title,
                        text: if annotation.is_empty() {
                            String::new()
                        } else {
                            format!("{annotation}\n")
                        },
                        broadTopicIndex: parent,
                    });
                    activeSubtopic = Some(result.subtopics.len() - 1);
                    coveredLines += 1;
                    continue;
                }
            }
            if let Some(captures) = BROAD.captures(line.trim_end()) {
                let title = captures[1].trim().trim_matches('"').trim().to_string();
                if !title.is_empty() {
                    result.broadTopics.push(ParsedBroadTopic { title });
                    parent = Some(result.broadTopics.len() - 1);
                    activeSubtopic = None;
                    coveredLines += 1;
                    continue;
                }
            }
        }
        if let Some(index) = activeSubtopic {
            result.subtopics[index].text.push_str(line);
            if !trimmed.is_empty() {
                coveredLines += 1;
            }
        }
    }
    if result.subtopics.is_empty() {
        return Err("No numbered bold subtopics were found. Use **Broad topic** followed by 1. **Subtopic** and its content.".into());
    }
    for subtopic in &mut result.subtopics {
        subtopic.text = subtopic.text.trim().to_string();
    }
    result.coverage = coveredLines as f64 / bodyLines.max(1) as f64;
    if result.coverage < 0.5 {
        result
            .warnings
            .push("Less than 50% of the note follows the topic structure.".into());
    }
    if result
        .subtopics
        .iter()
        .any(|item| item.broadTopicIndex.is_none())
    {
        result
            .warnings
            .push("Some subtopics have no broad topic.".into());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tags_require_real_tags_and_ignore_code() {
        assert!(has_study_tag("---\ntags: [STUDY, math]\n---\nText").unwrap());
        assert!(has_study_tag("---\ntags:\n  - STUDY\n---\nText").unwrap());
        assert!(has_study_tag("Text #STUDY").unwrap());
        for text in [
            "#STUDYING",
            "`#STUDY`",
            "```\n#STUDY\n```",
            "[link](https://example.com/#STUDY)",
            "#study",
        ] {
            assert!(!has_study_tag(text).unwrap(), "{text}");
        }
    }
    #[test]
    fn topics_keep_markdown_and_assign_parents() {
        let result = extract_topics("---\ntags: STUDY\n---\n**Math**\n1. **Derivatives**\n    - Rate of change\n    - $x^2$\n**Physics**\n2. **Force**\n    F = ma\n").unwrap();
        assert_eq!(result.broadTopics.len(), 2);
        assert_eq!(result.subtopics[0].text, "- Rate of change\n    - $x^2$");
        assert_eq!(result.subtopics[1].broadTopicIndex, Some(1));
    }
    #[test]
    fn documented_structure_has_unindented_titles_and_indented_content() {
        let result = extract_topics(
            "**\"Broad topic 1\"** \n1. **\"Subtopic 1\"**\n    - First line\n    - Second line\n2. **\"Subtopic 2\"**\n**\"Broad topic 2\"** \n3. **\"Subtopic 3\"**\n    - Third line\n4. **\"Subtopic 4\"**\n",
        ).unwrap();
        assert_eq!(result.broadTopics.len(), 2);
        assert_eq!(result.broadTopics[0].title, "Broad topic 1");
        assert_eq!(result.subtopics.len(), 4);
        assert_eq!(result.subtopics[0].title, "Subtopic 1");
        assert_eq!(result.subtopics[0].text, "- First line\n    - Second line");
        assert_eq!(result.subtopics[1].text, "");
        assert_eq!(result.subtopics[1].broadTopicIndex, Some(0));
        assert_eq!(result.subtopics[2].broadTopicIndex, Some(1));
        assert_eq!(result.coverage, 1.0);
        assert!(result.warnings.is_empty());

        for text in [
            "    **Broad topic**\n    1. **Subtopic**\n        - Content",
            "\t**Broad topic**\n\t1. **Subtopic**\n\t\t- Content",
            "**Broad topic**\n1) **Subtopic**\n    - Content",
        ] {
            assert!(extract_topics(text).is_err(), "{text}");
        }
    }
    #[test]
    fn real_note_accepts_annotations_after_bold_subtopic_titles() {
        let result = extract_topics(include_str!("fixtures/real_note.md")).unwrap();
        assert_eq!(result.broadTopics.len(), 1);
        assert_eq!(result.broadTopics[0].title, "JOUKKO-OPPI");
        assert_eq!(result.subtopics.len(), 2);
        assert_eq!(result.subtopics[0].title, "Joukot ja lukujoukot");
        assert_eq!(result.subtopics[1].title, "Välit ja päätepisteet");
        assert!(
            result
                .subtopics
                .iter()
                .all(|topic| topic.broadTopicIndex == Some(0))
        );
        assert!(
            result.subtopics[0]
                .text
                .contains("★ (moniste 1.1.1, s. 5–6)")
        );
        assert!(result.subtopics[0].text.contains(r"$x\in A$"));
        assert!(result.subtopics[1].text.contains("**Ratkaisu:**"));
        assert_eq!(result.coverage, 1.0);
        assert!(result.warnings.is_empty());
    }
    #[test]
    fn code_is_not_a_topic_and_low_coverage_warns() {
        assert!(extract_topics("```\n**Fake**\n1. **Fake child**\n```").is_err());
        let result = extract_topics("intro\nintro\nintro\nintro\n1. **Orphan**\ncontent").unwrap();
        assert!(result.coverage < 0.5);
        assert_eq!(result.warnings.len(), 2);
    }
}
