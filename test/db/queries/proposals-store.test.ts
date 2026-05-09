/**
 * Integration tests for src/db/queries/proposals-store.ts.
 *
 * Coverage focus: regression for the JSON-payload double-stringify bug
 * (#115) where `${JSON.stringify(payload)}::jsonb` stored payloads as a
 * JSON string of the JSON object (jsonb_typeof = 'string') rather than
 * as the object itself (jsonb_typeof = 'object'). Surfaced in E2E test
 * 4 — approve-pending caught it via Zod validation on
 * `CreateIssuePayloadSchema.parse(proposal.payload)`.
 *
 * Skips when DATABASE_URL is unreachable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { getDb } from "../../../src/db";
import {
  findAwaitingByTarget,
  findById,
  insertProposal,
} from "../../../src/db/queries/proposals-store";

let dbAvailable = false;
beforeAll(async () => {
  const db = getDb();
  if (db === null) return;
  try {
    await db`SELECT 1 FROM chat_proposals LIMIT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

const skipIfNoDb = (): boolean => !dbAvailable;

beforeEach(async () => {
  const db = getDb();
  if (db === null || !dbAvailable) return;
  await db`DELETE FROM chat_proposals WHERE owner = 'test-proposals-owner'`;
});

afterAll(async () => {
  const db = getDb();
  if (db === null || !dbAvailable) return;
  await db`DELETE FROM chat_proposals WHERE owner = 'test-proposals-owner'`;
});

describe("insertProposal — payload roundtrip", () => {
  it("stores payload as a jsonb OBJECT, not a stringified jsonb string (regression: #115)", async () => {
    if (skipIfNoDb()) return;
    const payload = {
      title: "feat: a follow-up issue",
      body: "Body of the issue",
      labels: ["follow-up", "bot"],
    };
    const row = await insertProposal({
      owner: "test-proposals-owner",
      repo: "test-repo",
      targetType: "pr",
      targetNumber: 999,
      threadId: null,
      proposalCommentId: 12345,
      proposalKind: "action:create-issue",
      payload,
      askerLogin: "test-user",
      ttlHours: 24,
    });

    expect(row.payload).toEqual(payload);

    // SQL-level probe: the column must be a jsonb OBJECT, not a
    // jsonb-encoded STRING. The pre-#115 bug stored payloads as JSON
    // strings of the JSON object (jsonb_typeof = 'string'); post-fix
    // is jsonb_typeof = 'object', and `payload->>'title'` resolves
    // verbatim. This is the most reliable regression assertion since
    // it inspects the on-disk encoding the bug actually broke.
    const db = getDb();
    if (db === null) throw new Error("DB connection lost mid-test");
    const probe = await db<{ jsonb_type: string; title: string }[]>`
      SELECT jsonb_typeof(payload) AS jsonb_type, payload->>'title' AS title
      FROM chat_proposals WHERE id = ${row.id}
    `;
    expect(probe[0]?.jsonb_type).toBe("object");
    expect(probe[0]?.title).toBe("feat: a follow-up issue");
  });

  it("findById returns the same payload object shape that was inserted", async () => {
    if (skipIfNoDb()) return;
    const payload = { title: "t", body: "b", labels: [] as string[] };
    const inserted = await insertProposal({
      owner: "test-proposals-owner",
      repo: "test-repo",
      targetType: "pr",
      targetNumber: 999,
      threadId: null,
      proposalCommentId: 999_001,
      proposalKind: "action:create-issue",
      payload,
      askerLogin: "test-user",
      ttlHours: 24,
    });
    const found = await findById(inserted.id);
    expect(found).not.toBeNull();
    expect(found?.payload).toEqual(payload);
  });

  it("findAwaitingByTarget returns the row keyed by (owner, repo, target_number)", async () => {
    if (skipIfNoDb()) return;
    const inserted = await insertProposal({
      owner: "test-proposals-owner",
      repo: "test-repo",
      targetType: "pr",
      targetNumber: 1234,
      threadId: null,
      proposalCommentId: 999_002,
      proposalKind: "action:create-issue",
      payload: { title: "x", body: "y", labels: [] as string[] },
      askerLogin: "test-user",
      ttlHours: 24,
    });
    const found = await findAwaitingByTarget({
      owner: "test-proposals-owner",
      repo: "test-repo",
      targetType: "pr",
      targetNumber: 1234,
      threadId: null,
    });
    expect(found?.id).toBe(inserted.id);
    expect(found?.status).toBe("awaiting");
  });
});
