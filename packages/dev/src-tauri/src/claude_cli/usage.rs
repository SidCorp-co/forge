use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliCredentials {
    pub subscription_type: Option<String>,
    pub rate_limit_tier: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub request_count: u64,
    pub estimated_cost: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceUsageSummary {
    pub subscription_type: Option<String>,
    pub rate_limit_tier: Option<String>,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cache_read_tokens: u64,
    pub total_cache_creation_tokens: u64,
    pub total_requests: u64,
    pub total_estimated_cost: f64,
    pub session_count: u64,
    pub by_model: Vec<ModelUsage>,
}

/// Per-million-token pricing
fn model_pricing(model: &str) -> Option<(f64, f64)> {
    // Strip provider prefix (e.g. "anthropic/claude-opus-4-6" → "claude-opus-4-6")
    let m = match model.find('/') {
        Some(i) => &model[i + 1..],
        None => model,
    };
    if m.starts_with("claude-opus-4") {
        Some((15.0, 75.0))
    } else if m.starts_with("claude-sonnet-4") {
        Some((3.0, 15.0))
    } else if m.starts_with("claude-haiku-4") {
        Some((1.0, 5.0))
    } else {
        None
    }
}

fn estimate_cost(model: &str, input: u64, output: u64) -> f64 {
    match model_pricing(model) {
        Some((ip, op)) => (input as f64 * ip + output as f64 * op) / 1_000_000.0,
        None => 0.0,
    }
}

#[derive(Deserialize)]
struct JsonlEntry {
    #[serde(rename = "type")]
    msg_type: Option<String>,
    message: Option<JsonlMessage>,
    model: Option<String>,
}

#[derive(Deserialize)]
struct JsonlMessage {
    id: Option<String>,
    role: Option<String>,
    usage: Option<JsonlUsage>,
}

#[derive(Deserialize)]
struct JsonlUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
}

fn read_credentials() -> CliCredentials {
    let home = match dirs_next::home_dir() {
        Some(h) => h,
        None => return CliCredentials { subscription_type: None, rate_limit_tier: None },
    };
    let creds_path = home.join(".claude").join(".credentials.json");
    let content = match std::fs::read_to_string(&creds_path) {
        Ok(c) => c,
        Err(_) => return CliCredentials { subscription_type: None, rate_limit_tier: None },
    };

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RawCreds {
        subscription_type: Option<String>,
        rate_limit_tier: Option<String>,
    }

    match serde_json::from_str::<RawCreds>(&content) {
        Ok(r) => CliCredentials {
            subscription_type: r.subscription_type,
            rate_limit_tier: r.rate_limit_tier,
        },
        Err(_) => CliCredentials { subscription_type: None, rate_limit_tier: None },
    }
}

fn find_jsonl_files(base: &std::path::Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(base) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                files.extend(find_jsonl_files(&path));
            } else if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                files.push(path);
            }
        }
    }
    files
}

fn parse_session_file(content: &str) -> Option<(String, u64, u64, u64, u64, u64)> {
    let mut input = 0u64;
    let mut output = 0u64;
    let mut cache_read = 0u64;
    let mut cache_creation = 0u64;
    let mut request_count = 0u64;
    let mut model = String::from("unknown");
    let mut seen_ids = HashSet::new();

    for line in content.lines() {
        if line.is_empty() || !line.contains("\"assistant\"") {
            continue;
        }
        let entry: JsonlEntry = match serde_json::from_str(line) {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.msg_type.as_deref() != Some("assistant") {
            continue;
        }
        let msg = match &entry.message {
            Some(m) => m,
            None => continue,
        };
        let usage = match &msg.usage {
            Some(u) => u,
            None => continue,
        };
        // Dedup by message ID
        if let Some(id) = &msg.id {
            if !seen_ids.insert(id.clone()) {
                continue;
            }
        }

        input += usage.input_tokens.unwrap_or(0);
        output += usage.output_tokens.unwrap_or(0);
        cache_read += usage.cache_read_input_tokens.unwrap_or(0);
        cache_creation += usage.cache_creation_input_tokens.unwrap_or(0);
        request_count += 1;
        if let Some(m) = &entry.model {
            model = m.clone();
        }
    }

    if request_count == 0 {
        return None;
    }
    Some((model, input, output, cache_read, cache_creation, request_count))
}

pub fn get_cli_usage() -> DeviceUsageSummary {
    let creds = read_credentials();

    let home = dirs_next::home_dir().unwrap_or_default();
    let projects_dir = home.join(".claude").join("projects");
    let jsonl_files = find_jsonl_files(&projects_dir);

    let mut by_model: HashMap<String, ModelUsage> = HashMap::new();
    let mut total_input = 0u64;
    let mut total_output = 0u64;
    let mut total_cache_read = 0u64;
    let mut total_cache_creation = 0u64;
    let mut total_requests = 0u64;
    let mut session_count = 0u64;

    for file in &jsonl_files {
        let content = match std::fs::read_to_string(file) {
            Ok(c) => c,
            Err(_) => continue,
        };
        if let Some((model, inp, out, cr, cc, reqs)) = parse_session_file(&content) {
            total_input += inp;
            total_output += out;
            total_cache_read += cr;
            total_cache_creation += cc;
            total_requests += reqs;
            session_count += 1;

            let entry = by_model.entry(model.clone()).or_insert_with(|| ModelUsage {
                model: model.clone(),
                ..Default::default()
            });
            entry.input_tokens += inp;
            entry.output_tokens += out;
            entry.cache_read_tokens += cr;
            entry.cache_creation_tokens += cc;
            entry.request_count += reqs;
            entry.estimated_cost += estimate_cost(&model, inp, out);
        }
    }

    let total_estimated_cost = estimate_cost("claude-opus-4-6", total_input, total_output);
    let mut models: Vec<ModelUsage> = by_model.into_values().collect();
    models.sort_by(|a, b| b.estimated_cost.partial_cmp(&a.estimated_cost).unwrap_or(std::cmp::Ordering::Equal));

    DeviceUsageSummary {
        subscription_type: creds.subscription_type,
        rate_limit_tier: creds.rate_limit_tier,
        total_input_tokens: total_input,
        total_output_tokens: total_output,
        total_cache_read_tokens: total_cache_read,
        total_cache_creation_tokens: total_cache_creation,
        total_requests,
        total_estimated_cost,
        session_count,
        by_model: models,
    }
}
