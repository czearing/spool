use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use super::rates::model_rates;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub uncached_input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

impl Tokens {
    pub fn read(metric: &Value) -> Result<Self> {
        if let Some(details) = metric.get("tokenDetails") {
            let details = details.as_object().context("Invalid model token details")?;
            anyhow::ensure!(!details.is_empty() && details.keys().all(|key|
                matches!(key.as_str(), "input" | "output" | "cache_read" | "cache_write")), "Unsupported model token category");
            let count = |name: &str| -> Result<u64> {
                let value = details.get(name).map(|value| value["tokenCount"].as_u64()
                    .context("Invalid model token detail")).transpose()?.unwrap_or(0);
                anyhow::ensure!(value <= 9_007_199_254_740_991, "Model token count exceeds supported range");
                Ok(value)
            };
            // Billing-category counters remain populated when coarse usage reports zeros.
            return Ok(Self { uncached_input_tokens: count("input")?, output_tokens: count("output")?,
                cache_read_tokens: count("cache_read")?, cache_write_tokens: count("cache_write")? });
        }
        let count = |name| -> Result<u64> {
            let value = metric["usage"][name].as_u64().context("Missing or invalid model token count")?;
            anyhow::ensure!(value <= 9_007_199_254_740_991, "Model token count exceeds supported range");
            Ok(value)
        };
        let (input, output, read, write) = (count("inputTokens")?, count("outputTokens")?,
            count("cacheReadTokens")?, count("cacheWriteTokens")?);
        let uncached = input.checked_sub(read).and_then(|value| value.checked_sub(write))
            .context("Model cache tokens exceed total input tokens")?;
        Ok(Self { uncached_input_tokens: uncached, output_tokens: output, cache_read_tokens: read, cache_write_tokens: write })
    }

    pub fn delta(&self, previous: &Self) -> Result<Self> {
        let subtract = |now: u64, before| now.checked_sub(before).context("Model token counter decreased");
        Ok(Self {
            uncached_input_tokens: subtract(self.uncached_input_tokens, previous.uncached_input_tokens)?,
            output_tokens: subtract(self.output_tokens, previous.output_tokens)?,
            cache_read_tokens: subtract(self.cache_read_tokens, previous.cache_read_tokens)?,
            cache_write_tokens: subtract(self.cache_write_tokens, previous.cache_write_tokens)?,
        })
    }

    pub fn cost(&self, model: &str) -> Option<f64> {
        let rates = model_rates(model)?;
        Some((self.uncached_input_tokens as f64 * rates.input + self.output_tokens as f64 * rates.output +
            self.cache_read_tokens as f64 * rates.cache_read + self.cache_write_tokens as f64 * rates.cache_write) / 1e6)
    }
}
