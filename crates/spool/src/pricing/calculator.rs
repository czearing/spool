use crate::models::TaskCost;
use crate::pricing::rates::get_model_rates;

pub fn calculate_cost(
    model: &str,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
) -> TaskCost {
    let rates = get_model_rates(model);
    
    // Normal input is total input minus cached
    let uncached_input = input_tokens.saturating_sub(cache_read_tokens);

    let prompt_cost = (uncached_input as f64 / 1_000_000.0) * rates.prompt_per_million;
    let completion_cost = (output_tokens as f64 / 1_000_000.0) * rates.completion_per_million;
    let cache_read_cost = (cache_read_tokens as f64 / 1_000_000.0) * rates.cache_read_per_million;
    let cache_write_cost = (cache_write_tokens as f64 / 1_000_000.0) * rates.cache_write_per_million;

    let total = prompt_cost + completion_cost + cache_read_cost + cache_write_cost;

    TaskCost {
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        total_cost_usd: total,
    }
}
