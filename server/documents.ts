import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * P8's own tables, in the same SQLite file as the durable-jobs tables. Document text is kept
 * here, not in the job payload, so job events and logs never carry it.
 */
export const P8_SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('sample','upload')),
  sha256     TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS documents_user ON documents (user_id);
CREATE TABLE IF NOT EXISTS exports (
  job_id      TEXT NOT NULL,
  approval_ts TEXT NOT NULL,
  exported_at TEXT NOT NULL,
  file        TEXT NOT NULL
);
`;

export interface DocumentRow {
  id: string;
  user_id: string;
  name: string;
  source: "sample" | "upload";
  sha256: string;
  text: string;
  created_at: number;
}

export const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Store a document for a user. The id is derived from user, name, source and text, so the same
 * upload twice gives the same id; that keeps a replayed POST /jobs body identical for the
 * idempotency check.
 */
export function putDocument(db: DatabaseSync, userId: string, name: string, source: "sample" | "upload", text: string): DocumentRow {
  const sha = sha256Hex(text);
  const id = `doc_${sha256Hex(`${userId}\n${source}\n${name}\n${sha}`).slice(0, 16)}`;
  const now = Date.now();
  db.prepare("INSERT INTO documents (id, user_id, name, source, sha256, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING").run(id, userId, name, source, sha, text, now);
  return getDocument(db, id)!;
}

export function getDocument(db: DatabaseSync, id: string): DocumentRow | undefined {
  return db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as DocumentRow | undefined;
}

export function recordExport(db: DatabaseSync, jobId: string, approvalTs: string, exportedAt: string, file: string) {
  db.prepare("INSERT INTO exports (job_id, approval_ts, exported_at, file) VALUES (?, ?, ?, ?)").run(jobId, approvalTs, exportedAt, file);
}

/** Latest export made under the given approval, if any. */
export function lastExport(db: DatabaseSync, jobId: string, approvalTs: string): string | null {
  const r = db.prepare("SELECT exported_at FROM exports WHERE job_id = ? AND approval_ts = ? ORDER BY rowid DESC LIMIT 1").get(jobId, approvalTs) as { exported_at: string } | undefined;
  return r?.exported_at ?? null;
}
