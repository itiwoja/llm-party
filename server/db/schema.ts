/** 08 DB設計の v1。配列の添字＋1 が PRAGMA user_version になる */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE models (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    hf_repo TEXT,
    architecture TEXT NOT NULL,
    quantization TEXT,
    size_bytes INTEGER NOT NULL,
    train_context INTEGER,
    sha256 TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE adapters (
    id TEXT PRIMARY KEY,
    base_model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    architecture TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
    sampling TEXT NOT NULL,
    system_prompt TEXT,
    thinking INTEGER NOT NULL DEFAULT 0,
    context_size INTEGER NOT NULL DEFAULT 32768,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE preset_adapters (
    preset_id TEXT NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
    adapter_id TEXT NOT NULL REFERENCES adapters(id) ON DELETE RESTRICT,
    scale REAL NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (preset_id, adapter_id)
  );
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE RESTRICT,
    last_preset_id TEXT REFERENCES presets(id) ON DELETE SET NULL,
    auto_approve INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX threads_updated ON threads(updated_at DESC, id DESC);
  CREATE TABLE turns (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    preset_id TEXT REFERENCES presets(id) ON DELETE SET NULL,
    status TEXT NOT NULL,
    step_count INTEGER NOT NULL DEFAULT 0,
    step_limit INTEGER NOT NULL DEFAULT 40,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    started_at TEXT,
    finished_at TEXT,
    error TEXT
  );
  CREATE INDEX turns_thread ON turns(thread_id);
  CREATE TABLE tool_calls (
    id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    call_ref TEXT NOT NULL,
    tool TEXT NOT NULL,
    args TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    decision_note TEXT,
    output TEXT,
    exit_code INTEGER,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX tool_calls_turn ON tool_calls(turn_id);
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    reasoning TEXT,
    tool_call_id TEXT REFERENCES tool_calls(id),
    pinned INTEGER NOT NULL DEFAULT 0,
    compacted_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (thread_id, seq)
  );
  CREATE TABLE file_changes (
    id TEXT PRIMARY KEY,
    tool_call_id TEXT NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    before_content TEXT,
    after_content TEXT,
    after_sha256 TEXT,
    reverted_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE eval_sets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    fixtures_dir TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE eval_cases (
    id TEXT PRIMARY KEY,
    eval_set_id TEXT NOT NULL REFERENCES eval_sets(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL,
    input TEXT NOT NULL,
    fixture TEXT,
    grader TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (eval_set_id, name)
  );
  CREATE TABLE eval_runs (
    id TEXT PRIMARY KEY,
    eval_set_id TEXT NOT NULL REFERENCES eval_sets(id) ON DELETE CASCADE,
    preset_id TEXT REFERENCES presets(id) ON DELETE SET NULL,
    preset_name TEXT NOT NULL,
    preset_snapshot TEXT NOT NULL,
    backend TEXT NOT NULL,
    tag_filter TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    pass_rate REAL,
    avg_score REAL,
    avg_tokens_per_sec REAL,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE eval_results (
    id TEXT PRIMARY KEY,
    eval_run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
    eval_case_id TEXT REFERENCES eval_cases(id) ON DELETE SET NULL,
    case_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    answer TEXT,
    transcript TEXT,
    test_output TEXT,
    score INTEGER,
    reviewed_at TEXT,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    tokens_per_sec REAL,
    duration_ms INTEGER
  );
  CREATE TABLE downloads (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    hf_repo TEXT NOT NULL,
    files TEXT NOT NULL,
    dest_dir TEXT NOT NULL,
    status TEXT NOT NULL,
    received_bytes INTEGER NOT NULL DEFAULT 0,
    total_bytes INTEGER,
    retry_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    result_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE runtime_packs (
    id TEXT PRIMARY KEY,
    backend TEXT NOT NULL,
    cuda_version TEXT,
    llama_build TEXT,
    path TEXT NOT NULL,
    sha256 TEXT,
    installed_at TEXT NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- 検索（D-58）。題名は source_id = スレッド ID、本文は source_id = メッセージ ID の行で持つ
  CREATE VIRTUAL TABLE threads_fts USING fts5(thread_id UNINDEXED, source_id UNINDEXED, body, tokenize='trigram');
  CREATE TRIGGER threads_ai AFTER INSERT ON threads BEGIN
    INSERT INTO threads_fts(thread_id, source_id, body) VALUES (new.id, new.id, new.title);
  END;
  CREATE TRIGGER threads_au AFTER UPDATE OF title ON threads BEGIN
    DELETE FROM threads_fts WHERE source_id = old.id;
    INSERT INTO threads_fts(thread_id, source_id, body) VALUES (new.id, new.id, new.title);
  END;
  CREATE TRIGGER threads_ad AFTER DELETE ON threads BEGIN
    DELETE FROM threads_fts WHERE thread_id = old.id;
  END;
  CREATE TRIGGER messages_ai AFTER INSERT ON messages WHEN new.role IN ('user', 'assistant') BEGIN
    INSERT INTO threads_fts(thread_id, source_id, body) VALUES (new.thread_id, new.id, new.content);
  END;
  CREATE TRIGGER messages_au AFTER UPDATE OF content ON messages WHEN new.role IN ('user', 'assistant') BEGIN
    DELETE FROM threads_fts WHERE source_id = old.id;
    INSERT INTO threads_fts(thread_id, source_id, body) VALUES (new.thread_id, new.id, new.content);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    DELETE FROM threads_fts WHERE source_id = old.id;
  END;
  `,
  // v2：作業フォルダをプロジェクトとして設定できるようにする（TBL-005）。auto_approve の NULL は設定 defaultAutoApprove に従う
  `
  ALTER TABLE workspaces ADD COLUMN hidden_at TEXT;
  ALTER TABLE workspaces ADD COLUMN instructions TEXT;
  ALTER TABLE workspaces ADD COLUMN default_preset_id TEXT REFERENCES presets(id) ON DELETE SET NULL;
  ALTER TABLE workspaces ADD COLUMN auto_approve INTEGER;
  `,
  // v3：画像生成（D-72）。models.kind で画像モデルを区別し、生成結果は images に持つ。
  // スレッドの履歴には role = 'image' で入れるので、チャットの文脈（user / assistant / summary だけを読む）には入らない
  `
  ALTER TABLE models ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat';
  CREATE TABLE images (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    model_name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    steps INTEGER NOT NULL,
    seed INTEGER NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  // v4：複数の部品でできた画像モデル（MOSS-Image, D-73）。parts は { diffusion, llm, vae, tokenizer } の絶対パス（JSON）。単一ファイルの画像モデルは NULL
  `
  ALTER TABLE models ADD COLUMN parts TEXT;
  `,
  // v5：思考の段階（D-76）。models の2列はチャットテンプレートから読んだ対応で、NULL はまだ読んでいない（起動時に読む）
  `
  ALTER TABLE models ADD COLUMN supports_thinking INTEGER;
  ALTER TABLE models ADD COLUMN supports_effort INTEGER;
  ALTER TABLE presets ADD COLUMN effort TEXT NOT NULL DEFAULT 'medium';
  `,
];
