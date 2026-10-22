use chrono::NaiveDate;

#[derive(Debug, PartialEq, Eq)]
pub enum PeriodPhase {
    Future,
    Current { elapsed_days: u32, remaining_days: u32, total_days: u32 },
    Past,
}

pub fn phase(start: NaiveDate, end: NaiveDate, today: NaiveDate) -> PeriodPhase {
    if today < start { return PeriodPhase::Future; }
    if today >= end { return PeriodPhase::Past; }
    PeriodPhase::Current {
        elapsed_days: (today - start).num_days() as u32 + 1,
        remaining_days: (end - today).num_days() as u32 - 1,
        total_days: (end - start).num_days() as u32,
    }
}

// Money stays in integer minor units; a negative net rate does not predict future refunds.
pub fn remaining_from_current_rate(variable_spent: i64, elapsed_days: u32, remaining_days: u32) -> Option<i64> {
    if elapsed_days == 0 { return None; }
    let positive = variable_spent.max(0) as i128;
    let numerator = positive.checked_mul(remaining_days as i128)?;
    let rounded = numerator.checked_add((elapsed_days / 2) as i128)? / elapsed_days as i128;
    i64::try_from(rounded).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leap_month_progress_uses_calendar_days() {
        let start = NaiveDate::from_ymd_opt(2028, 2, 1).unwrap();
        let end = NaiveDate::from_ymd_opt(2028, 3, 1).unwrap();
        assert_eq!(phase(start, end, NaiveDate::from_ymd_opt(2028, 2, 8).unwrap()), PeriodPhase::Current { elapsed_days: 8, remaining_days: 21, total_days: 29 });
        assert_eq!(phase(start, end, NaiveDate::from_ymd_opt(2028, 3, 1).unwrap()), PeriodPhase::Past);
    }

    #[test]
    fn current_rate_uses_exact_minor_units_and_no_negative_projection() {
        assert_eq!(remaining_from_current_rate(2_001, 8, 21), Some(5_253));
        assert_eq!(remaining_from_current_rate(-100, 8, 21), Some(0));
        assert_eq!(remaining_from_current_rate(i64::MAX, 1, 29), None);
    }
}
