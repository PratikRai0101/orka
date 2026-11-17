use crate::{auth, db, sync};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::io::Write;

#[derive(Clone, Copy)]
enum Verdict {
    Pass,
    Warn,
    Fail,
}
type Finding = db::Result<(Verdict, String)>;
#[derive(Default)]
pub struct Doctor {
    pub(crate) output: String,
    pub(crate) code: i32,
}
impl Doctor {
    pub fn run() -> i32 {
        let db = db::open();
        let report = Self::collect(db.as_ref().ok(), auth::session());
        std::io::stdout()
            .write_all(report.output.as_bytes())
            .map_or(1, |_| report.code)
    }
    pub(crate) fn collect(db: Option<&rusqlite::Connection>, session: db::Result<Value>) -> Self {
        let mut report = Self::default();
        report.record("Login", Self::login(db, session), "Open Orka, allow Keychain access, and sign in to the selected service; choose Sync now to refresh an expired session.");
        report.record("Sync", Self::sync(db), "Open Orka's sync menu, review issues, and choose Retry uploads or Sync now. If sync is in progress, wait and rerun doctor.");
        report
    }
    fn record(&mut self, name: &str, finding: Finding, next: &str) {
        let (verdict, detail) =
            finding.unwrap_or((Verdict::Fail, "Local status unavailable.".into()));
        let (label, code) = match verdict {
            Verdict::Pass => ("PASS", 0),
            Verdict::Warn => ("WARN", 2),
            Verdict::Fail => ("FAIL", 1),
        };
        if self.code != 1 && code != 0 {
            self.code = code;
        }
        self.output.push_str(&format!("{label} {name}: {detail}\n"));
        if code != 0 {
            self.output.push_str(&format!("  Next: {next}\n"));
        }
    }
    fn time(value: &Value) -> Option<DateTime<Utc>> {
        value.as_str()?.parse().ok()
    }
    fn stamp(time: Option<DateTime<Utc>>) -> String {
        time.map(|t| t.to_rfc3339())
            .unwrap_or_else(|| "none".into())
    }
    fn login(db: Option<&rusqlite::Connection>, session: db::Result<Value>) -> Finding {
        let db = db.ok_or("Local database unavailable")?;
        let session = session?;
        let user = db::get(db, "user")?;
        let config = db::get(db, "config")?;
        let service = config["apiUrl"].as_str().unwrap_or("");
        let valid = user
            .as_str()
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
            && session["user"]["id"] == user
            && db::validate_url(service).is_ok()
            && session["apiUrl"].as_str().unwrap_or(service) == service
            && ["access_token", "refresh_token"]
                .iter()
                .all(|key| session[key].as_str().is_some_and(|v| !v.is_empty()));
        let expires = session["expires_at"].as_i64().unwrap_or(0);
        let (verdict, detail) = match (valid, expires <= Utc::now().timestamp() + 60) {
            (false, _) => (Verdict::Fail, "Saved login is invalid or mismatched."),
            (true, true) => (Verdict::Warn, "Saved session needs refresh."),
            (true, false) => (
                Verdict::Pass,
                "Saved session available; server login unverified.",
            ),
        };
        Ok((verdict, detail.into()))
    }
    fn sync(db: Option<&rusqlite::Connection>) -> Finding {
        let db = db.ok_or("Local database unavailable")?;
        let summary = sync::Summary::read(db, db::daemon_running()?)?;
        let config = db::get(db, "config")?;
        let last = Self::time(&summary.status["lastSync"]);
        let updated = Self::time(&summary.status["updatedAt"]);
        let error = &summary.status["error"];
        let has_error = error.as_str().is_some_and(|e| !e.is_empty());
        let stale_after =
            (config["syncMinutes"].as_u64().unwrap_or(15).clamp(1, 1440) * 120).max(300);
        let invalid = (!summary.status.is_null() && !summary.status.is_object())
            || (!error.is_null() && !error.is_string())
            || (!summary.status["lastSync"].is_null() && last.is_none())
            || (!summary.status["updatedAt"].is_null() && updated.is_none());
        let (verdict, reason) =
            if invalid || summary.issues > 0 || has_error || summary.status["online"] == false {
                (Verdict::Fail, "recorded sync needs attention")
            } else if summary.pending > 0 {
                (Verdict::Warn, "queued work")
            } else if !summary.progress.is_null() {
                (Verdict::Warn, "sync in progress")
            } else if last.is_none() {
                (Verdict::Warn, "never synced")
            } else if last.is_some_and(|t| {
                Utc::now().signed_duration_since(t) > chrono::Duration::seconds(stale_after as i64)
            }) {
                (Verdict::Warn, "last success is stale")
            } else {
                (Verdict::Pass, "last recorded sync succeeded")
            };
        let error = match (has_error, invalid) {
            (true, _) => "present (review in Orka)",
            (_, true) => "unverified",
            _ => "none",
        };
        let (pending, issues) = (summary.pending, summary.issues);
        let (last, updated) = (Self::stamp(last), Self::stamp(updated));
        Ok((verdict, format!("{reason}; {pending} queued; {issues} issues; last success {last}; updated {updated}; recorded error {error}.")))
    }
}
