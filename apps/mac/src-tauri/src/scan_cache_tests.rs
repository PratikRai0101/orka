use super::*;
use crate::{history, plans, scan_cache};

fn write_session(f: &Fixture, source: &str, id: &str, records: &[Value]) -> PathBuf {
    let directory = if source == "codex" {
        native::codex_home().unwrap().join("sessions")
    } else {
        native::claude_home().unwrap().join("projects/test")
    };
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join(if source == "codex" {
        format!("rollout-{id}.jsonl")
    } else {
        format!("{id}.jsonl")
    });
    let metadata = if source == "codex" {
        json!({"type":"session_meta","payload":{"id":id,"cwd":f.root,"cli_version":"0.159.2","history_mode":"legacy","source":"cli"}})
    } else {
        json!({"type":"user","cwd":f.root,"sessionId":id,"version":"2.1.286","message":{"role":"user","content":"Build this feature"}})
    };
    let records = std::iter::once(metadata)
        .chain(records.iter().cloned())
        .collect::<Vec<_>>();
    fs::write(&path, native::encode(&records)).unwrap();
    path
}

#[test]
fn matching_session_cache_skips_unchanged_sessions_and_rechecks_only_edited_ones() {
    let f = Fixture::new();
    let codex_a = write_session(
        &f,
        "codex",
        &uuid::Uuid::new_v4().to_string(),
        &[json!({"type":"event_msg","payload":{"message":"codex a"}})],
    );
    let codex_b = write_session(
        &f,
        "codex",
        &uuid::Uuid::new_v4().to_string(),
        &[json!({"type":"event_msg","payload":{"message":"codex b"}})],
    );
    let claude_a = write_session(
        &f,
        "claude",
        &uuid::Uuid::new_v4().to_string(),
        &[json!({"type":"assistant","message":{"role":"assistant","content":"claude a"}})],
    );
    let claude_b = write_session(
        &f,
        "claude",
        &uuid::Uuid::new_v4().to_string(),
        &[json!({"type":"assistant","message":{"role":"assistant","content":"claude b"}})],
    );

    indexer::scan(&f.db, &f.project).unwrap();
    f.db.execute("DELETE FROM outbox", []).unwrap();
    assert_eq!(history::read_counts(&codex_a), (1, 1));
    assert_eq!(history::read_counts(&codex_b), (1, 1));
    assert_eq!(history::read_counts(&claude_a), (1, 0));
    assert_eq!(history::read_counts(&claude_b), (1, 0));

    // Repeat scan with 0 changes: none of the matching transcripts are re-read.
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(f.outbox().is_empty());
    assert_eq!(history::read_counts(&codex_a), (1, 1));
    assert_eq!(history::read_counts(&codex_b), (1, 1));
    assert_eq!(history::read_counts(&claude_a), (1, 0));
    assert_eq!(history::read_counts(&claude_b), (1, 0));

    // Edit only codex_a (same byte length, newer mtime/ctime): only codex_a re-reads.
    let updated = fs::read_to_string(&codex_a)
        .unwrap()
        .replace("codex a", "codex A");
    assert_eq!(updated.len(), fs::read(&codex_a).unwrap().len());
    fs::write(&codex_a, updated).unwrap();

    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(f.outbox().len(), 1);
    assert_eq!(history::read_counts(&codex_a), (2, 2));
    assert_eq!(history::read_counts(&codex_b), (1, 1));
    assert_eq!(history::read_counts(&claude_a), (1, 0));
    assert_eq!(history::read_counts(&claude_b), (1, 0));

    // Deleting claude_b still emits a deletion even though sibling sessions stayed cached.
    f.db.execute("DELETE FROM outbox", []).unwrap();
    fs::remove_file(&claude_b).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(f.outbox().len(), 1);
    assert_eq!(f.outbox()[0]["resource"]["deleted"], true);
    assert_eq!(history::read_counts(&claude_a), (1, 0));
    assert_eq!(history::read_counts(&codex_b), (1, 1));
}

#[test]
fn cached_session_still_detects_referenced_plan_edits_and_enabling_plan_sharing() {
    let f = Fixture::new();
    let global_plans = plans::native_directory("claude").unwrap();
    fs::create_dir_all(&global_plans).unwrap();
    let claude_plan = global_plans.join("steady-plan.md");
    fs::write(&claude_plan, "# Initial plan\n\nStep 1.\n").unwrap();

    let claude_id = uuid::Uuid::new_v4().to_string();
    let claude_path = write_session(
        &f,
        "claude",
        &claude_id,
        &[json!({
            "type": "assistant",
            "slug": "steady-plan",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "name": "ExitPlanMode",
                    "input": {"plan": "Inline fallback", "planFilePath": claude_plan}
                }]
            }
        })],
    );

    // First scan with plan sharing OFF caches the session with plans_checked = false.
    let mut sessions_only = f.project.clone();
    sessions_only["sharing"] =
        json!({"memory":false,"skill":false,"session":true,"plan":false,"env":false});
    indexer::scan(&f.db, &sessions_only).unwrap();
    assert_eq!(history::read_counts(&claude_path), (1, 0));
    assert!(!f.resources().iter().any(|r| r["kind"] == "plan"));

    // Enabling plan sharing invalidates the plan-less cache entry and discovers the plan.
    let mut with_plans = f.project.clone();
    with_plans["sharing"] =
        json!({"memory":false,"skill":false,"session":true,"plan":true,"env":false});
    indexer::scan(&f.db, &with_plans).unwrap();
    assert_eq!(history::read_counts(&claude_path), (2, 0));
    for r in f.resources() {
        f.accept(&r);
    }
    assert_eq!(
        f.resources().iter().filter(|r| r["kind"] == "plan").count(),
        1
    );
    assert_eq!(scan_cache::plan_file_reads(&claude_plan), 1);

    // Repeat scan with 0 changes reads neither the transcript nor the plan file.
    indexer::scan(&f.db, &with_plans).unwrap();
    assert!(f.outbox().is_empty());
    assert_eq!(history::read_counts(&claude_path), (2, 0));
    assert_eq!(scan_cache::plan_file_reads(&claude_plan), 1);

    // Editing only the referenced plan file detects the plan edit WITHOUT re-reading the transcript.
    fs::write(&claude_plan, "# Updated plan\n\nStep 2.\n").unwrap();
    indexer::scan(&f.db, &with_plans).unwrap();
    assert_eq!(history::read_counts(&claude_path), (2, 0));
    assert_eq!(scan_cache::plan_file_reads(&claude_plan), 2);
    assert_eq!(f.outbox().len(), 1);
    assert_eq!(f.outbox()[0]["resource"]["kind"], "plan");
    assert_eq!(f.outbox()[0]["resource"]["title"], "Updated plan");
}

#[test]
fn paginated_session_cache_invalidates_when_ancestor_segment_changes() {
    let f = Fixture::new();
    let (_, paths) = segmented_chain(&f);
    indexer::scan(&f.db, &f.project).unwrap();
    f.db.execute("DELETE FROM outbox", []).unwrap();
    let leaf = &paths[2];
    assert_eq!(history::read_counts(leaf), (1, 1));

    // Unchanged repeat scan hits the cache.
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(f.outbox().is_empty());
    assert_eq!(history::read_counts(leaf), (1, 1));

    // Modifying an ancestor segment (same byte length, same ordinal boundary) invalidates the leaf cache.
    let ancestor = &paths[0];
    let original = fs::read_to_string(ancestor).unwrap();
    let mut records = native::complete_records(original.as_bytes()).unwrap();
    let msg = records
        .iter_mut()
        .find_map(|r| {
            r["payload"]["content"][0]["text"]
                .as_str()
                .map(str::to_owned)
        })
        .expect("ancestor message text");
    let mut replacement = msg.clone();
    replacement.replace_range(..1, if msg.starts_with('Z') { "Y" } else { "Z" });
    let mutated = original.replacen(&msg, &replacement, 1);
    assert_ne!(mutated, original);
    assert_eq!(mutated.len(), original.len());
    fs::write(ancestor, mutated).unwrap();

    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(history::read_counts(leaf), (2, 2));
    assert_eq!(f.outbox().len(), 1);
    assert_eq!(f.outbox()[0]["resource"]["kind"], "session");
}

#[test]
fn file_skill_and_codex_summary_caches_re_read_only_modified_entries_and_recover_missing_blobs() {
    let f = Fixture::new();
    let agents_a = f.root.join("AGENTS.md");
    let agents_b = f.root.join("CLAUDE.md");
    fs::write(&agents_a, "# Agents A\n").unwrap();
    fs::write(&agents_b, "# Claude B\n").unwrap();

    let skill_a = f.root.join(".agents/skills/alpha");
    let skill_b = f.root.join(".agents/skills/beta");
    for (dir, name) in [(&skill_a, "alpha"), (&skill_b, "beta")] {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("SKILL.md"), format!("# {name}\n")).unwrap();
        fs::write(dir.join("run.sh"), "#!/bin/sh\necho hi\n").unwrap();
    }

    let plan_a = f.root.join(".codex/plans/one.md");
    let plan_b = f.root.join(".codex/plans/two.md");
    fs::create_dir_all(plan_a.parent().unwrap()).unwrap();
    fs::write(&plan_a, "# Plan One\n").unwrap();
    fs::write(&plan_b, "# Plan Two\n").unwrap();

    let summaries = native::codex_home()
        .unwrap()
        .join("memories/rollout_summaries");
    fs::create_dir_all(&summaries).unwrap();
    let summary_match = summaries.join("match.md");
    let summary_other = summaries.join("other.md");
    fs::write(
        &summary_match,
        format!(
            "thread_id: {}\ncwd: {}\nupdated_at: 2026-11-24T00:00:00Z\n\nFact\n",
            uuid::Uuid::new_v4(),
            f.root.display()
        ),
    )
    .unwrap();
    fs::write(
        &summary_other,
        format!(
            "thread_id: {}\ncwd: /unrelated/repo\nupdated_at: 2026-11-24T00:00:00Z\n\nOther\n",
            uuid::Uuid::new_v4()
        ),
    )
    .unwrap();

    // Cold scan reads each item once.
    indexer::scan(&f.db, &f.project).unwrap();
    f.db.execute("DELETE FROM outbox", []).unwrap();
    assert_eq!(scan_cache::package_file_reads(&agents_a), 1);
    assert_eq!(scan_cache::package_file_reads(&agents_b), 1);
    assert_eq!(scan_cache::skill_dir_reads(&skill_a), 1);
    assert_eq!(scan_cache::skill_dir_reads(&skill_b), 1);
    assert_eq!(scan_cache::plan_file_reads(&plan_a), 1);
    assert_eq!(scan_cache::plan_file_reads(&plan_b), 1);
    assert_eq!(scan_cache::codex_summary_reads(&summary_match), 1);
    assert_eq!(scan_cache::codex_summary_reads(&summary_other), 1);

    // Warm scan with 0 changes reads nothing again.
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(f.outbox().is_empty());
    assert_eq!(scan_cache::package_file_reads(&agents_a), 1);
    assert_eq!(scan_cache::package_file_reads(&agents_b), 1);
    assert_eq!(scan_cache::skill_dir_reads(&skill_a), 1);
    assert_eq!(scan_cache::skill_dir_reads(&skill_b), 1);
    assert_eq!(scan_cache::plan_file_reads(&plan_a), 1);
    assert_eq!(scan_cache::plan_file_reads(&plan_b), 1);
    assert_eq!(scan_cache::codex_summary_reads(&summary_match), 1);
    assert_eq!(scan_cache::codex_summary_reads(&summary_other), 1);

    // Edit only agents_a, chmod +x inside skill_a, edit only plan_a.
    fs::write(&agents_a, "# Agents A updated\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(skill_a.join("run.sh"), fs::Permissions::from_mode(0o755)).unwrap();
    }
    fs::write(&plan_a, "# Plan One updated\n").unwrap();

    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(scan_cache::package_file_reads(&agents_a), 2);
    assert_eq!(scan_cache::package_file_reads(&agents_b), 1);
    assert_eq!(scan_cache::skill_dir_reads(&skill_a), 2);
    assert_eq!(scan_cache::skill_dir_reads(&skill_b), 1);
    assert_eq!(scan_cache::plan_file_reads(&plan_a), 2);
    assert_eq!(scan_cache::plan_file_reads(&plan_b), 1);
    assert_eq!(scan_cache::codex_summary_reads(&summary_match), 1);
    assert_eq!(scan_cache::codex_summary_reads(&summary_other), 1);
    assert_eq!(f.outbox().len(), 3);

    // Removing a cached blob from disk forces a cache miss and restores the blob.
    let hash = db::digest(b"# Claude B\n");
    let blob = db::blob_path(&hash).unwrap();
    fs::remove_file(&blob).unwrap();
    assert!(!blob.exists());
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(scan_cache::package_file_reads(&agents_b), 2);
    assert!(blob.exists());
}
