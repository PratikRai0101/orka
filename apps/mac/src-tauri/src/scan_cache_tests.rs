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
    f.db.execute("DELETE FROM outbox", []).unwrap();
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

#[test]
fn codex_segment_index_handles_non_ascii_filenames_without_panicking() {
    let f = Fixture::new();
    let sessions_dir = native::codex_home().unwrap().join("sessions/2026/11/24");
    fs::create_dir_all(&sessions_dir).unwrap();
    // 2-byte UTF-8 'é' + 35 ASCII 'a's => 37-byte stem where len - 36 == 1 splits 'é'.
    let non_ascii = sessions_dir.join(format!("é{}.jsonl", "a".repeat(35)));
    fs::write(&non_ascii, "{}\n").unwrap();

    let codex_id = uuid::Uuid::new_v4().to_string();
    write_session(
        &f,
        "codex",
        &codex_id,
        &[json!({"type":"event_msg","payload":{"type":"user_message","message":"Hello"}})],
    );

    indexer::scan(&f.db, &f.project).unwrap();
    assert!(f
        .resources()
        .iter()
        .any(|r| r["kind"] == "session" && r["source"] == "codex"));
}

#[test]
fn cached_session_plan_refs_reject_swapped_symlink_ancestor_directories() {
    let f = Fixture::new();
    let global_plans = plans::native_directory("claude").unwrap();
    fs::create_dir_all(&global_plans).unwrap();
    let claude_plan = global_plans.join("steady-plan.md");

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
                    "input": {"planFilePath": claude_plan}
                }]
            }
        })],
    );

    // Scan 1 caches session with plan_refs containing ~/.claude/plans/steady-plan.md (absent so far).
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(history::read_counts(&claude_path), (1, 0));
    assert!(!f.resources().iter().any(|r| r["kind"] == "plan"));

    // Swap ~/.claude/plans with a symlink pointing to an external directory with a secret .md file.
    let outside = f._home.path().join("outside-plans");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("steady-plan.md"), "# Secret outside file\n").unwrap();
    fs::remove_dir_all(&global_plans).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, &global_plans).unwrap();

    // Scan 2 hits CachedSession; ancestor symlink check must reject the external file.
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(!f.resources().iter().any(|r| r["kind"] == "plan"));
    let errors = db::rows(
        &f.db,
        "SELECT json_object('source',source,'error',error) FROM errors",
        &[],
    )
    .unwrap();
    assert!(
        errors
            .iter()
            .any(|e| e["error"] == "Symlinked plans are excluded"),
        "expected symlink rejection error, got {errors:?}"
    );
}

#[test]
fn malformed_worktree_claude_settings_records_session_plan_error_without_aborting_scan() {
    let f = Fixture::new();
    let run_git = |dir: &Path, args: &[&str]| {
        let status = std::process::Command::new("git")
            .current_dir(dir)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    };
    run_git(&f.root, &["init", "--quiet"]);
    fs::write(f.root.join("README.md"), "# repo\n").unwrap();
    run_git(&f.root, &["add", "README.md"]);
    run_git(
        &f.root,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-q",
            "-m",
            "init",
        ],
    );
    let wt = f._home.path().join("linked-wt");
    run_git(
        &f.root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "wt-branch",
            wt.to_str().unwrap(),
        ],
    );
    fs::create_dir_all(wt.join(".claude")).unwrap();
    fs::write(wt.join(".claude/settings.local.json"), "{invalid json").unwrap();

    // Write a session in the malformed worktree and another in the healthy main checkout.
    let wt_id = uuid::Uuid::new_v4().to_string();
    let claude_wt_dir = native::claude_home().unwrap().join("projects/wt-proj");
    fs::create_dir_all(&claude_wt_dir).unwrap();
    let wt_session = claude_wt_dir.join(format!("{wt_id}.jsonl"));
    fs::write(
        &wt_session,
        format!(
            "{}\n",
            json!({"sessionId": wt_id, "cwd": wt, "type": "user", "message": {"content": "wt"}})
        ),
    )
    .unwrap();
    let main_id = uuid::Uuid::new_v4().to_string();
    write_session(
        &f,
        "claude",
        &main_id,
        &[json!({"type":"user","message":{"content":"main"}})],
    );

    // Scan must succeed (not abort), collect both sessions, and record the worktree plan error.
    indexer::scan(&f.db, &f.project).unwrap();
    let session_count = f
        .resources()
        .iter()
        .filter(|r| r["kind"] == "session")
        .count();
    assert_eq!(session_count, 2);
    let errors = db::rows(
        &f.db,
        "SELECT json_object('source',source,'error',error) FROM errors",
        &[],
    )
    .unwrap();
    assert!(
        errors.iter().any(|e| e["source"]
            .as_str()
            .is_some_and(|s| s.contains(":scan:plans:"))),
        "expected per-session plan error, got {errors:?}"
    );
}

#[test]
fn governed_cached_session_still_persists_active_context_sources_when_handoffs_exist() {
    let mut f = Fixture::new();
    let project_id = f.project["id"].as_str().unwrap().to_owned();
    f.project["governed"] = json!(true);
    db::upsert(&f.db, "projects", &project_id, "", &f.project).unwrap();

    // Record an unrelated handoff so has_handoffs is true for the project.
    let handoff_file = f.root.join(".orka/handoff.md");
    fs::create_dir_all(handoff_file.parent().unwrap()).unwrap();
    fs::write(&handoff_file, "# Handoff\n").unwrap();
    native::record_handoff(
        &f.db,
        &f.project,
        &json!({"resourceId": "mem-handoff", "contextSources": ["mem-handoff"]}),
        &handoff_file,
    )
    .unwrap();

    let claude_id = uuid::Uuid::new_v4().to_string();
    let claude_path = write_session(
        &f,
        "claude",
        &claude_id,
        &[json!({"type":"user","message":{"content":"Governed session"}})],
    );

    // Scan 1 caches the session under the current handoff_scope.
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(history::read_counts(&claude_path), (1, 0));

    // Hook adds new active.contextSources while transcript stays untouched.
    f.db.execute(
        "INSERT OR REPLACE INTO active VALUES(?,?)",
        rusqlite::params![
            &claude_id,
            json!({"project": project_id, "contextSources": ["mem-live-1"]}).to_string()
        ],
    )
    .unwrap();

    // Scan 2 hits CachedSession; active.contextSources must still be persisted to sessionSources.
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(history::read_counts(&claude_path), (1, 0));

    // After session closes (active row removed), sessionSources must still retain mem-live-1.
    f.db.execute("DELETE FROM active WHERE native_id=?", [&claude_id])
        .unwrap();
    let persisted = native::session_sources(&f.db, &project_id, &claude_id).unwrap();
    assert_eq!(persisted, json!(["mem-live-1"]));
}

#[test]
fn claude_referenced_plan_file_skips_invalid_inline_fallback_until_file_is_deleted() {
    let f = Fixture::new();
    let global_plans = plans::native_directory("claude").unwrap();
    fs::create_dir_all(&global_plans).unwrap();
    let claude_plan = global_plans.join("valid-file.md");
    fs::write(&claude_plan, "# Valid File Plan\n\nBody.\n").unwrap();

    let claude_id = uuid::Uuid::new_v4().to_string();
    let claude_path = write_session(
        &f,
        "claude",
        &claude_id,
        &[json!({
            "type": "assistant",
            "slug": "valid-file",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "name": "ExitPlanMode",
                    "input": {"plan": "invalid\0nul-inline", "planFilePath": claude_plan}
                }]
            }
        })],
    );

    // With referenced plan file present, invalid inline fallback must be skipped (no error, cached).
    indexer::scan(&f.db, &f.project).unwrap();
    let errors = db::rows(
        &f.db,
        "SELECT json_object('source',source,'error',error) FROM errors",
        &[],
    )
    .unwrap();
    assert!(errors.is_empty(), "unexpected errors: {errors:?}");
    assert_eq!(history::read_counts(&claude_path), (1, 0));

    // Repeat scan hits cache with zero errors.
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(history::read_counts(&claude_path), (1, 0));

    // Deleting the referenced plan file invalidates cache and evaluates the inline fallback.
    fs::remove_file(&claude_plan).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(history::read_counts(&claude_path), (2, 0));
    let errors = db::rows(
        &f.db,
        "SELECT json_object('source',source,'error',error) FROM errors",
        &[],
    )
    .unwrap();
    assert!(
        errors.iter().any(|e| e["source"]
            .as_str()
            .is_some_and(|s| s.contains(":scan:plan:"))),
        "expected inline fallback validation error after plan file deletion, got {errors:?}"
    );
}

#[test]
fn git_instruction_discovery_catches_broken_nested_git_and_top_level_ignored_nested_repo() {
    let f = Fixture::new();
    let run_git = |dir: &Path, args: &[&str]| {
        let status = std::process::Command::new("git")
            .current_dir(dir)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    };
    run_git(&f.root, &["init", "--quiet"]);
    fs::write(f.root.join(".gitignore"), "subapp/\n").unwrap();

    // Top-level ignored nested Git repo should still be discovered using its own ignore rules.
    let subapp = f.root.join("subapp");
    fs::create_dir_all(&subapp).unwrap();
    run_git(&subapp, &["init", "--quiet"]);
    fs::write(subapp.join("AGENTS.md"), "# Subapp instructions\n").unwrap();
    let found = indexer::instruction_files(&f.root).unwrap();
    assert!(found.contains(Path::new("subapp/AGENTS.md")));

    // Broken untracked nested .git whose .gitignore ignores private/ must fail instead of returning Ok.
    let broken = f.root.join("broken-nested");
    fs::create_dir_all(broken.join("private")).unwrap();
    fs::write(broken.join(".git"), "gitdir: missing-repository\n").unwrap();
    fs::write(broken.join(".gitignore"), "private/\n").unwrap();
    fs::write(broken.join("private/AGENTS.md"), "# Hidden\n").unwrap();
    let err = indexer::instruction_files(&f.root).unwrap_err();
    assert!(
        err.contains("Cannot verify Git ignore rules"),
        "expected git ignore verification error, got {err}"
    );
}

#[test]
fn paginated_cache_detects_new_ambiguous_ancestor_segment_and_remove_local_prunes_cache() {
    let f = Fixture::new();
    let project_id = f.project["id"].as_str().unwrap().to_owned();
    let (_, paths) = segmented_chain(&f);
    let ancestor = &paths[0];
    let leaf = &paths[2];

    // Scan 1 caches the paginated session.
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(history::read_counts(leaf), (1, 1));
    let before_errors = db::rows(
        &f.db,
        "SELECT json_object('source',source,'error',error) FROM errors",
        &[],
    )
    .unwrap();
    assert!(
        before_errors.is_empty(),
        "unexpected errors: {before_errors:?}"
    );

    // Add a conflicting sibling segment for the ancestor ID in archived_sessions with the same byte length.
    let archive_dir = native::codex_home().unwrap().join("archived_sessions");
    fs::create_dir_all(&archive_dir).unwrap();
    let original = fs::read_to_string(ancestor).unwrap();
    let records = native::complete_records(original.as_bytes()).unwrap();
    let ancestor_id = records[0]["payload"]["id"].as_str().unwrap();
    let msg = records
        .iter()
        .find_map(|r| r["payload"]["content"][0]["text"].as_str())
        .expect("ancestor message text");
    let mut replacement = msg.to_owned();
    replacement.replace_range(..1, if msg.starts_with('Z') { "Y" } else { "Z" });
    let mutated = original.replacen(msg, &replacement, 1);
    assert_eq!(mutated.len(), original.len());
    let sibling = archive_dir.join(format!(
        "rollout-2026-11-24T00-00-01-{ancestor_id}_000.jsonl"
    ));
    fs::write(&sibling, mutated).unwrap();

    // Scan 2 must invalidate the cached leaf and report ambiguous inherited history.
    indexer::scan(&f.db, &f.project).unwrap();
    let errors = db::rows(
        &f.db,
        "SELECT json_object('source',source,'error',error) FROM errors",
        &[],
    )
    .unwrap();
    assert!(
        errors
            .iter()
            .any(|e| e["error"] == "Ambiguous inherited history; original sources preserved"),
        "expected ambiguity error, got {errors:?}"
    );

    // Removing the local project prunes its scanCache session entries.
    let before_cache: i64 =
        f.db.query_row(
            "SELECT count(*) FROM meta WHERE key LIKE ?",
            [format!("scanCache:%:session:{project_id}:%")],
            |r| r.get(0),
        )
        .unwrap();
    assert!(before_cache > 0);
    crate::projects::remove_local(&f.db, &project_id).unwrap();
    let after_cache: i64 =
        f.db.query_row(
            "SELECT count(*) FROM meta WHERE key LIKE ?",
            [format!("scanCache:%:session:{project_id}:%")],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(after_cache, 0);
}

fn run_git(dir: &Path, args: &[&str]) {
    let status = std::process::Command::new("git")
        .current_dir(dir)
        .args(args)
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?} failed");
}

#[test]
fn excludes_instructions_outside_connected_folder() {
    let f = Fixture::new();
    run_git(&f.root, &["init", "--quiet"]);
    let relative = Path::new("docs/AGENTS.md");
    let docs = f.root.join("docs");
    fs::create_dir(&docs).unwrap();
    fs::write(f.root.join(relative), "# In scope\n").unwrap();
    run_git(&f.root, &["add", "docs/AGENTS.md"]);
    assert!(indexer::instruction_files(&f.root)
        .unwrap()
        .contains(relative));

    let outside = f._home.path().join("another-project");
    fs::create_dir(&outside).unwrap();
    let outside_bytes = b"# Separate fixture\n";
    fs::write(outside.join("AGENTS.md"), outside_bytes).unwrap();
    fs::remove_dir_all(&docs).unwrap();
    std::os::unix::fs::symlink(&outside, &docs).unwrap();

    indexer::scan(&f.db, &f.project).unwrap();
    let outside_hash = db::digest(outside_bytes);
    assert!(
        !f.outbox()
            .iter()
            .any(|q| q["resource"]["files"][0]["hash"] == outside_hash),
        "scan queued a memory backed by bytes outside the connected folder"
    );
}

#[test]
fn discovers_nested_repos_below_an_ignored_directory() {
    let f = Fixture::new();
    run_git(&f.root, &["init", "--quiet"]);
    fs::write(f.root.join(".gitignore"), "build/\n").unwrap();
    let nested = f.root.join("build/nested");
    fs::create_dir_all(&nested).unwrap();
    run_git(&nested, &["init", "--quiet"]);
    fs::write(nested.join("AGENTS.md"), "# Nested project\n").unwrap();
    assert!(
        indexer::instruction_files(&f.root)
            .unwrap()
            .contains(Path::new("build/nested/AGENTS.md")),
        "nested repository has its own Git ignore scope"
    );
}

#[test]
fn falls_back_to_inline_plan_when_reference_turns_invalid() {
    let f = Fixture::new();
    let plans_dir = crate::plans::native_directory("claude").unwrap();
    fs::create_dir_all(&plans_dir).unwrap();
    let path = plans_dir.join("valid-file.md");
    fs::write(&path, "# Valid File Plan\n\nBody.\n").unwrap();
    let sid = uuid::Uuid::new_v4().to_string();
    write_session(
        &f,
        "claude",
        &sid,
        &[json!({
            "type":"assistant", "slug":"valid-file", "message":{"content":[{
                "type":"tool_use", "name":"ExitPlanMode",
                "input":{"plan":"# Inline fallback\n\nStill valid.", "planFilePath":path}
            }]}
        })],
    );
    let inline_exists = || {
        f.resources().iter().any(|r| {
            r["kind"] == "plan"
                && r["logicalPath"]
                    .as_str()
                    .is_some_and(|p| p.starts_with("claude/sessions/"))
        })
    };
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(
        !inline_exists(),
        "valid external plan should take precedence"
    );
    fs::write(&path, [0xff, 0xfe]).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(
        inline_exists(),
        "referenced file is invalid and the inline plan is still valid"
    );
}

#[test]
fn detects_edits_to_existing_alternate_ancestor() {
    let f = Fixture::new();
    let project_id = f.project["id"].as_str().unwrap();
    let (_, paths) = segmented_chain(&f);
    let original = fs::read_to_string(&paths[0]).unwrap();
    let records = native::complete_records(original.as_bytes()).unwrap();
    let id = records[0]["payload"]["id"].as_str().unwrap();
    let msg = records
        .iter()
        .find_map(|r| r["payload"]["content"][0]["text"].as_str())
        .unwrap();
    let mut replacement = msg.to_owned();
    replacement.replace_range(..1, if msg.starts_with('Z') { "Y" } else { "Z" });
    let mutated = original.replacen(msg, &replacement, 1);
    assert_eq!(mutated.len(), original.len());
    let directory = native::codex_home().unwrap().join("archived_sessions");
    fs::create_dir_all(&directory).unwrap();
    let sibling = directory.join(format!("rollout-2026-11-24T00-00-01-{id}_000.jsonl"));
    fs::write(&sibling, &original).unwrap();

    let errors = || {
        db::rows(
            &f.db,
            "SELECT json_object('source',source,'error',error) FROM errors WHERE source LIKE ?",
            &[&format!("{project_id}:%")],
        )
        .unwrap()
    };
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(
        errors().is_empty(),
        "identical ancestor candidates are safe: {:?}",
        errors()
    );

    fs::write(&sibling, mutated).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(
        errors()
            .iter()
            .any(|e| e["error"] == "Ambiguous inherited history; original sources preserved"),
        "conflicting ancestor candidate must be visible: {:?}",
        errors()
    );
}

#[test]
fn local_scan_repairs_same_length_blob_corruption() {
    let f = Fixture::new();
    let bytes = b"# Local instructions\n";
    fs::write(f.root.join("AGENTS.md"), bytes).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let hash = db::digest(bytes);
    let path = db::blob_path(&hash).unwrap();
    assert_eq!(db::blob_read(&hash).unwrap(), bytes);
    indexer::scan(&f.db, &f.project).unwrap();
    fs::write(path, vec![b'X'; bytes.len()]).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(
        db::blob_read(&hash).as_deref(),
        Ok(bytes.as_slice()),
        "scan should repair cache from intact local source"
    );
}

#[test]
fn paginated_scan_resolves_compact_codex_ancestor_ids() {
    let f = Fixture::new();
    let (_, paths) = segmented_chain(&f);
    let mut previous_size = 0;
    for path in paths {
        let mut records = native::complete_records(&fs::read(&path).unwrap()).unwrap();
        let payload = &mut records[0]["payload"];
        let id = payload["id"].as_str().unwrap().to_owned();
        let compact = uuid::Uuid::parse_str(&id).unwrap().simple().to_string();
        payload["id"] = json!(compact);
        payload["session_id"] = json!(compact);
        if payload["history_base"].is_object() {
            payload["history_base"]["thread_id"] = json!(compact);
            payload["history_base"]["end_byte_offset"] = json!(previous_size);
        }
        let bytes = native::encode(&records);
        previous_size = bytes.len();
        let next = path.with_file_name(
            path.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .replace(&id, &compact),
        );
        fs::remove_file(path).unwrap();
        fs::write(next, bytes).unwrap();
    }

    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(
        f.outbox()
            .iter()
            .filter(|entry| entry["resource"]["kind"] == "session")
            .count(),
        1
    );
    let errors = db::rows(&f.db, "SELECT json_quote(error) FROM errors", &[]).unwrap();
    assert!(
        errors.is_empty(),
        "compact ancestor identities should resolve: {errors:?}"
    );
}
