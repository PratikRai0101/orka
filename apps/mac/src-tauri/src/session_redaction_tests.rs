use super::*;

#[test]
fn new_snapshots_redact_conversations_and_nested_tools_without_editing_sources() {
    let f = Fixture::new();
    let secrets = [
        format!("sk-{}", "a".repeat(24)),
        format!("sk-ant-api03-{}", "a".repeat(24)),
        format!("ghp_{}", "a".repeat(36)),
        format!("gho_{}", "a".repeat(36)),
        format!("github_pat_{}", "a".repeat(30)),
        format!("AKIA{}", "A".repeat(16)),
        format!("AIza{}", "a".repeat(35)),
        format!("xoxb-{}", "1".repeat(24)),
        format!("sk_live_{}", "a".repeat(24)),
        format!("rk_live_{}", "a".repeat(24)),
    ]
    .into_iter()
    .map(|s| (s, "[REDACTED]"))
    .chain([
        ("Bearer opaque.token+/==".into(), "Bearer [REDACTED]"),
        (
            "-----BEGIN RSA PRIVATE KEY-----\nprivate material\n-----END RSA PRIVATE KEY-----"
                .into(),
            "[REDACTED]",
        ),
        ("API_KEY=arbitrary-value".into(), "API_KEY=[REDACTED]"),
        (
            "  export SERVICE_TOKEN = 'arbitrary-value'".into(),
            "  export SERVICE_TOKEN = [REDACTED]",
        ),
        ("PASSWORD: arbitrary-value".into(), "PASSWORD: [REDACTED]"),
    ]);
    for (secret, expected) in secrets {
        let record = json!({"user":secret,"assistant":secret,"tool":{"input":[{"text":secret}],"output":{"text":secret}}});
        let path = f.root.join("redaction.jsonl");
        let original = native::encode(&[record]);
        fs::write(&path, &original).unwrap();
        let files = crate::history::session_files("claude", &path, None).unwrap();
        let bytes = db::blob_read(files[0]["hash"].as_str().unwrap()).unwrap();
        let output = native::complete_records(&bytes).unwrap().remove(0);
        for value in [
            &output["user"],
            &output["assistant"],
            &output["tool"]["input"][0]["text"],
            &output["tool"]["output"]["text"],
        ] {
            assert_eq!(value, expected);
        }
        assert_eq!(fs::read(&path).unwrap(), original);
        fs::write(&path, &bytes).unwrap();
        assert_eq!(
            crate::history::session_files("claude", &path, None).unwrap(),
            files
        );
    }
    let record = json!({"API_KEY":"opaque", "service_TOKEN":"opaque", "Secret":"opaque", "password":"opaque", "PRIVATE_KEY":"opaque", "nested":[{"token":"opaque"}], "ordinary":"sk-short ghp_short AKIA123 AIza123 xoxo-123 sk_live_short\nPORT=3000\nTOKENIZER: enabled\nMONKEY=banana", "tokenizer":"unchanged", "secretary":"unchanged", "count":42});
    let path = f.root.join("fields.jsonl");
    fs::write(&path, native::encode(std::slice::from_ref(&record))).unwrap();
    let files = crate::history::session_files("claude", &path, None).unwrap();
    let output =
        native::complete_records(&db::blob_read(files[0]["hash"].as_str().unwrap()).unwrap())
            .unwrap()
            .remove(0);
    for key in [
        "API_KEY",
        "service_TOKEN",
        "Secret",
        "password",
        "PRIVATE_KEY",
    ] {
        assert_eq!(output[key], "[REDACTED]");
    }
    assert_eq!(output["nested"][0]["token"], "[REDACTED]");
    for key in ["ordinary", "tokenizer", "secretary", "count"] {
        assert_eq!(output[key], record[key]);
    }
}

#[test]
fn new_codex_snapshots_rebase_redacted_ancestors_and_preserve_native_files() {
    let f = Fixture::new();
    let (mut resource, paths) = paginated_chain(&f);
    let mut offset = 0;
    for (index, path) in paths.iter().enumerate() {
        let mut records = native::complete_records(&fs::read(path).unwrap()).unwrap();
        records[1]["payload"]["redaction_fixture"] =
            json!(format!("Bearer ancestor-credential-{index}"));
        if index > 0 {
            records[0]["payload"]["history_base"]["end_byte_offset"] = json!(offset);
        }
        let bytes = native::encode(&records);
        offset = bytes.len();
        fs::write(path, bytes).unwrap();
    }
    let originals: Vec<_> = paths.iter().map(|p| fs::read(p).unwrap()).collect();
    resource["files"] =
        json!(
            crate::history::session_files("codex", paths.last().unwrap(), Some(&f.root)).unwrap()
        );
    let snapshot = History::resource(&resource).unwrap();
    assert_eq!(snapshot.rollouts.len(), paths.len());
    for (index, rollout) in snapshot.rollouts.iter().enumerate() {
        assert_eq!(
            rollout.records[1]["payload"]["redaction_fixture"],
            "Bearer [REDACTED]"
        );
        assert_eq!(fs::read(&paths[index]).unwrap(), originals[index]);
    }
}
