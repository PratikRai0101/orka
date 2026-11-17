use regex::{Captures, Regex};
use serde_json::Value;
use std::sync::LazyLock;

pub(crate) struct SessionRedactor;

static SECRET_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[^a-z0-9])(?:api[_ -]?key|token|secret|password|private[_ -]?key)(?:$|[^a-z0-9])").unwrap()
});
static CREDENTIAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|",
        r"AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,}|",
        r"[sr]k_live_[A-Za-z0-9]{16,})"
    ))
    .unwrap()
});
static BEARER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(Bearer[ \t]+)[A-Za-z0-9._~+/-]+=*").unwrap());
static PRIVATE_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----.*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----").unwrap()
});
static ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)^([ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*[=:][ \t]*)("[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)"#).unwrap()
});

impl SessionRedactor {
    pub(crate) fn redact(value: &mut Value) {
        match value {
            Value::String(text) => *text = Self::text(text),
            Value::Array(values) => values.iter_mut().for_each(Self::redact),
            Value::Object(fields) => {
                for (key, value) in fields {
                    if value.is_string() && SECRET_NAME.is_match(key) {
                        *value = Value::String("[REDACTED]".into());
                    } else {
                        Self::redact(value);
                    }
                }
            }
            _ => (),
        }
    }

    pub(crate) fn text(text: &str) -> String {
        let text = PRIVATE_KEY.replace_all(text, "[REDACTED]");
        let text = ASSIGNMENT.replace_all(&text, |c: &Captures<'_>| {
            if SECRET_NAME.is_match(&c[2]) {
                format!("{}[REDACTED]", &c[1])
            } else {
                c[0].to_owned()
            }
        });
        let text = CREDENTIAL.replace_all(&text, "[REDACTED]");
        BEARER.replace_all(&text, "${1}[REDACTED]").into_owned()
    }
}
