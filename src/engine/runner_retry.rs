use std::time::Duration;

#[derive(Default)]
pub(super) struct RetryBudget {
    attempts: u32,
}

impl RetryBudget {
    pub fn next(&mut self, stable: bool) -> Option<Duration> {
        if stable {
            self.attempts = 0;
        }
        self.attempts += 1;
        if self.attempts > 8 {
            return None;
        }
        let seconds = (5u64 << (self.attempts - 1)).min(300);
        let jitter = u64::from(uuid::Uuid::new_v4().as_bytes()[0]) * seconds / 5;
        Some(Duration::from_secs(seconds) + Duration::from_millis(jitter))
    }
}

pub(super) fn permanent_exit(code: Option<i32>) -> bool {
    matches!(code, Some(64 | 65 | 77 | 78))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_budget_increases_caps_and_resets_after_stability() {
        let mut budget = RetryBudget::default();
        for seconds in [5, 10, 20, 40, 80, 160, 300, 300] {
            let delay = budget.next(false).unwrap();
            assert!(delay >= Duration::from_secs(seconds));
            assert!(delay < Duration::from_secs(seconds + 16));
        }
        assert!(budget.next(false).is_none());
        assert!(budget.next(true).unwrap() < Duration::from_secs(6));
        assert!(permanent_exit(Some(77)));
        assert!(permanent_exit(Some(78)));
        assert!(!permanent_exit(Some(1)));
    }
}
