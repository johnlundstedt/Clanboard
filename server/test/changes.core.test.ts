import { describe, expect, it, beforeEach } from "vitest";
import { ChangeLog } from "../src/core/changes.js";

// Portable change-log tests. The ChangeLog is the same code the /api/changes
// pollers hit in both the Node container and the future Workers entry, so these
// assert the exact contract a smart-polling client depends on:
//
//   * fresh client (no since/epoch) -> tables [], anchor rev+epoch
//   * incremental: since=rev -> distinct tables touched after it
//   * epoch mismatch / stale / future rev -> "*" (full refresh)
//   * nothing changed since -> tables []
//   * mutation between polls is visible on the FOLLOWING poll, not the one that
//     recorded it

describe("ChangeLog", () => {
  let log: ChangeLog;

  beforeEach(() => {
    log = new ChangeLog();
    log.begin();
  });

  it("fresh client gets the current anchor and no pending tables", () => {
    const snap = log.snapshot({});
    expect(snap.tables).toEqual([]);
    expect(snap.rev).toBe(log.currentRev());
    expect(snap.epoch).toBeDefined();
  });

  it("records distinct tables changed after a revision", () => {
    log.record("lists");
    log.record("tasks");
    const first = log.snapshot({});
    log.record("lists");
    log.record("meal_plan");
    const snap = log.snapshot({ since: first.rev, sinceEpoch: first.epoch });
    expect(snap.tables).toEqual(expect.arrayContaining(["lists", "meal_plan"]));
    expect(snap.tables).not.toContain("tasks");
    expect(snap.rev).toBeGreaterThan(first.rev);
  });

  it("merges duplicate tables into one entry per poll", () => {
    const a = log.snapshot({});
    log.record("lists");
    log.record("lists");
    const snap = log.snapshot({ since: a.rev, sinceEpoch: a.epoch });
    expect(new Set(snap.tables).size).toBe(snap.tables.length);
  });

  it("nothing changed -> empty tables, same rev", () => {
    const a = log.snapshot({});
    const snap = log.snapshot({ since: a.rev, sinceEpoch: a.epoch });
    expect(snap.tables).toEqual([]);
    expect(snap.rev).toBe(a.rev);
  });

  it("epoch mismatch -> '*' (client from an earlier boot/restart)", () => {
    const a = log.snapshot({});
    const snap = log.snapshot({ since: a.rev, sinceEpoch: a.epoch + 1 });
    expect(snap.tables).toBe("*");
  });

  it("rev newer than current rev -> '*'", () => {
    const snap = log.snapshot({ since: 999, sinceEpoch: log.currentEpoch() });
    expect(snap.tables).toBe("*");
  });

  it("rev older than the retained ring -> '*' (fell out of our buffer)", () => {
    log.record("lists");
    const a = log.snapshot({});
    // Simulate the client had a rev before this ring's oldest entry.
    const snap = log.snapshot({ since: a.rev - 10000, sinceEpoch: a.epoch });
    expect(snap.tables).toBe("*");
  });

  it("a mutation is reported on the following poll, not the recording one", () => {
    // snapshot() never includes the revision it records at — mirror of the
    // layer serving a poll taken *after* the mutation.
    const a = log.snapshot({});
    const mid = log.record("tasks");
    const pollAfter = log.snapshot({ since: a.rev, sinceEpoch: a.epoch });
    expect(pollAfter.tables).toContain("tasks");
    expect(pollAfter.rev).toBe(mid);
  });
});
