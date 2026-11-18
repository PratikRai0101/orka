use crate::db::{self, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

pub(crate) struct Interval(Duration);

impl Interval {
    const JITTER_DIVISOR: u32 = 5;

    pub(crate) fn from_config(config: &Value) -> Self {
        Self(Duration::from_secs(
            config["syncMinutes"].as_u64().unwrap_or(15).clamp(1, 1440) * 60,
        ))
    }

    pub(crate) fn stale_after(&self) -> Duration {
        // Keep the existing two-interval allowance and add at most one jitter window.
        (2 * self.0 + self.0 / Self::JITTER_DIVISOR).max(Duration::from_secs(300))
    }
}

struct ProjectClock {
    hash: u32,
    since: Instant,
    delay: Delay,
}

#[derive(Clone, Copy)]
enum Delay {
    Initial,
    Interval,
    Retry(Duration),
}

impl ProjectClock {
    fn new(device: &str, project: &str, now: Instant) -> Self {
        let digest = Sha256::digest(format!("{device}:{project}"));
        Self {
            hash: u32::from_be_bytes(digest[..4].try_into().unwrap()),
            since: now,
            delay: Delay::Initial,
        }
    }

    fn due(&self, now: Instant, interval: &Interval) -> bool {
        let base = match self.delay {
            Delay::Initial => interval.0,
            Delay::Interval => interval.0,
            Delay::Retry(retry) => retry.min(interval.0),
        };
        let bound = (base / Interval::JITTER_DIVISOR).as_millis() as u64;
        let jitter = Duration::from_millis(u64::from(self.hash) * bound / u64::from(u32::MAX));
        let wait = if matches!(self.delay, Delay::Initial) {
            jitter
        } else {
            base + jitter
        };
        now.duration_since(self.since) >= wait
    }
}

#[derive(Default)]
pub(super) struct Schedule {
    device: String,
    projects: HashMap<String, ProjectClock>,
}

impl Schedule {
    pub(super) fn observe(&mut self, db: &rusqlite::Connection, now: Instant) -> Result<()> {
        let device = db::device(db)?;
        if self.device != device {
            self.projects.clear();
            self.device = device;
        }
        let mut query = db
            .prepare_cached(&format!(
                "SELECT id FROM projects WHERE {}",
                crate::projects::ACTIVE
            ))
            .map_err(|e| e.to_string())?;
        let ids = query
            .query_map([], |row| row.get::<_, String>(0))
            .and_then(|rows| rows.collect::<rusqlite::Result<HashSet<_>>>())
            .map_err(|e| e.to_string())?;
        self.observe_projects(ids, now);
        Ok(())
    }

    fn observe_projects(&mut self, mut ids: HashSet<String>, now: Instant) {
        // An empty cache still needs a turn to discover projects from the service.
        if ids.is_empty() {
            ids.insert(String::new());
        }
        self.projects.retain(|id, _| ids.contains(id));
        for id in ids {
            let clock = || ProjectClock::new(&self.device, &id, now);
            self.projects.entry(id.clone()).or_insert_with(clock);
        }
    }

    pub(super) fn turn(&self, now: Instant, interval: &Interval, requested: bool) -> Option<Turn> {
        if requested {
            return Some(Turn::All);
        }
        let due: HashSet<_> = self
            .projects
            .iter()
            .filter(|(id, clock)| {
                (id.is_empty() && matches!(clock.delay, Delay::Initial)) || clock.due(now, interval)
            })
            .map(|(id, _)| id.clone())
            .collect();
        (!due.is_empty()).then_some(Turn::Due(due))
    }

    pub(super) fn finish(
        &mut self,
        turn: &Turn,
        now: Instant,
        interval: &Interval,
        result: &Result<bool>,
    ) {
        for (id, clock) in &mut self.projects {
            // Back off all projects when the service is unavailable.
            if result.is_err() || turn.includes(id) {
                clock.since = now;
                clock.delay = if matches!(result, Ok(false)) {
                    Delay::Interval
                } else {
                    let retry = match clock.delay {
                        Delay::Retry(previous) => previous * 2,
                        _ => Duration::from_secs(30),
                    };
                    Delay::Retry(retry.min(interval.0))
                };
            }
        }
    }
}

pub(super) enum Turn {
    All,
    Due(HashSet<String>),
}

impl Turn {
    pub(super) fn includes(&self, id: &str) -> bool {
        match self {
            Self::All => true,
            Self::Due(ids) => ids.contains(id) || ids.contains(""),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_deadlines_are_stable_and_spread_inside_timer_and_retry_bounds() {
        fn deadlines(device: &str, delay: Delay, base: u64) -> Vec<u64> {
            let now = Instant::now();
            let interval = Interval(Duration::from_secs(900));
            (0..12)
                .map(|project| {
                    let mut clock = ProjectClock::new(device, &project.to_string(), now);
                    clock.delay = delay;
                    assert!(!clock.due(now + Duration::from_millis(base - 1), &interval));
                    (base..=base + base / 5)
                        .find(|ms| clock.due(now + Duration::from_millis(*ms), &interval))
                        .expect("project must be due by the jitter bound")
                })
                .collect()
        }
        for (delay, base) in [
            (Delay::Interval, 900_000),
            (Delay::Retry(Duration::from_secs(30)), 30_000),
        ] {
            let first = deadlines("mac-a", delay, base);
            assert_eq!(first, deadlines("mac-a", delay, base));
            assert_ne!(first, deadlines("mac-b", delay, base));
            assert!(first.windows(2).any(|pair| pair[0] != pair[1]));
        }
    }

    #[test]
    fn sync_now_includes_projects_even_during_backoff() {
        let now = Instant::now();
        let interval = Interval(Duration::from_secs(900));
        let mut schedule = Schedule::default();
        schedule.observe_projects(HashSet::from(["first".into(), "second".into()]), now);
        let turn = schedule.turn(now, &interval, true).unwrap();
        schedule.finish(&turn, now, &interval, &Err("offline".into()));
        assert!(schedule.turn(now, &interval, false).is_none());
        let turn = schedule.turn(now, &interval, true).unwrap();
        assert!(turn.includes("first") && turn.includes("second"));
    }
}
