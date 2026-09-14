#[derive(Debug, Clone, Copy)]
pub struct ModelRates {
    pub prompt_per_million: f64,
    pub completion_per_million: f64,
    pub cache_read_per_million: f64,
    pub cache_write_per_million: f64,
}

impl ModelRates {
    pub const fn new(prompt: f64, completion: f64, cache_read: f64, cache_write: f64) -> Self {
        Self {
            prompt_per_million: prompt,
            completion_per_million: completion,
            cache_read_per_million: cache_read,
            cache_write_per_million: cache_write,
        }
    }
}

pub fn get_model_rates(model: &str) -> ModelRates {
    let lower = model.to_lowercase();
    if lower.contains("gpt-6-astra") || lower.contains("astra") {
        ModelRates::new(2.50, 10.00, 1.25, 2.50)
    } else if lower.contains("gpt-5.4") || lower.contains("gpt-5-turbo") || lower.contains("gpt-4o") {
        ModelRates::new(2.50, 10.00, 1.25, 2.50)
    } else if lower.contains("gpt-5-mini") || lower.contains("gpt-4o-mini") || lower.contains("mini") {
        ModelRates::new(0.15, 0.60, 0.075, 0.15)
    } else if lower.contains("opus") {
        ModelRates::new(15.00, 75.00, 1.50, 18.75)
    } else if lower.contains("sonnet") {
        ModelRates::new(3.00, 15.00, 0.30, 3.75)
    } else if lower.contains("haiku") {
        ModelRates::new(0.80, 4.00, 0.08, 1.00)
    } else if lower.contains("gemini-3.7-flash") || lower.contains("flash") {
        ModelRates::new(0.10, 0.40, 0.025, 0.10)
    } else if lower.contains("gemini-3") || lower.contains("gemini-pro") {
        ModelRates::new(1.25, 5.00, 0.3125, 1.25)
    } else {
        // Conservative default (matching GPT-4o class rates)
        ModelRates::new(2.50, 10.00, 1.25, 2.50)
    }
}
