#[derive(Debug, Clone, Copy)]
pub struct ModelRates {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

impl ModelRates {
    const fn new(input: f64, output: f64, cache_read: f64, cache_write: f64) -> Self {
        Self { input, output, cache_read, cache_write }
    }
}

pub fn model_rates(model: &str) -> Option<ModelRates> {
    let name = model.to_lowercase();
    // Preserve the original local Spool rate card and its alias precedence.
    Some(if name.contains("gpt-6-astra") || name.contains("astra") ||
        name.contains("gpt-5.4") || name.contains("gpt-5-turbo") || name.contains("gpt-4o") {
        ModelRates::new(2.50, 10.00, 1.25, 2.50)
    } else if name.contains("gpt-5-mini") || name.contains("gpt-4o-mini") || name.contains("-mini") {
        ModelRates::new(0.15, 0.60, 0.075, 0.15)
    } else if name.contains("opus") {
        ModelRates::new(15.00, 75.00, 1.50, 18.75)
    } else if name.contains("sonnet") {
        ModelRates::new(3.00, 15.00, 0.30, 3.75)
    } else if name.contains("haiku") {
        ModelRates::new(0.80, 4.00, 0.08, 1.00)
    } else if name.contains("flash") {
        ModelRates::new(0.10, 0.40, 0.025, 0.10)
    } else if name.contains("gemini-3") || name.contains("gemini-pro") {
        ModelRates::new(1.25, 5.00, 0.3125, 1.25)
    } else { return None })
}
