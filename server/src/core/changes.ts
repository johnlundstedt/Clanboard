// Portable, dependency-free change log backing the /api/changes polling
// endpoint. Every state mutation bumps a global revision and records the table
// it touched. Pollers ask "what changed after revision N?" and we answer with
// the distinct tables touched since then — or "*" when we can't reconcile
// (different server generation/epoch, or the revision fell out of our ring
// window), meaning "refresh everything".
//
// Portable and pure: no imports. Same code runs in the Node container (where
// this complements ws) and the future Workers entry (where /api/changes is the
// primary realtime mechanism).

export interface ChangesEntry {
  rev: number;
  table: string;
}

export interface ChangesRequest {
  /** Highest revision the client has seen, or undefined for a fresh client. */
  since?: number;
  /** Epoch the client's `since` belongs to, or undefined for a fresh client. */
  sinceEpoch?: number;
}

export interface ChangesSnapshot {
  epoch: number;
  rev: number;
  /** Tables changed after `since`; "*" means "refresh everything". */
  tables: string[] | "*";
}

const RING_CAPACITY = 256;

export class ChangeLog {
  // Bumped at boot. A client whose revision numbers belong to an older
  // generation/epoch can't trust them, so it must refresh everything.
  private epoch = 0;
  // Global monotonically-increasing revision counter.
  private rev = 0;
  // Ring buffer of recent (rev, table) entries, oldest first.
  private entries: ChangesEntry[] = [];

  // Call once at boot, before handling any requests.
  begin(): void {
    this.epoch += 1;
    this.rev = 0;
    this.entries = [];
  }

  currentEpoch(): number {
    return this.epoch;
  }

  currentRev(): number {
    return this.rev;
  }

  // Record a change to `table`; advances the global revision and returns it.
  record(table: string): number {
    this.rev += 1;
    this.entries.push({ rev: this.rev, table });
    if (this.entries.length > RING_CAPACITY) {
      this.entries.shift();
    }
    return this.rev;
  }

  // Compute what changed after `since` on `sinceEpoch`. The ring holds every
  // rev from `oldest` through `this.rev` (it only drops the very oldest entry
  // when full), so a `since` of `oldest-1` is the farthest back we can still
  // answer precisely; below that (or a mismatched epoch) the client must
  // refresh everything.
  snapshot(req: ChangesRequest): ChangesSnapshot {
    const { since, sinceEpoch } = req;

    // Fresh client (no since): it recently fetched everything at mount, so it
    // needs no extra work now — just hand it the current epoch+rev to anchor.
    if (since === undefined || sinceEpoch === undefined) {
      return { epoch: this.epoch, rev: this.rev, tables: [] };
    }

    // Already fully up to date: nothing changed, same rev.
    if (since === this.rev && sinceEpoch === this.epoch) {
      return { epoch: this.epoch, rev: this.rev, tables: [] };
    }

    // Mismatched epoch or the ring can't answer this `since` (fell out of the
    // window, or it's from the future) → the client must refresh everything.
    const oldest = this.entries[0]?.rev ?? this.rev + 1;
    if (sinceEpoch !== this.epoch || since < oldest - 1 || since > this.rev) {
      return { epoch: this.epoch, rev: this.rev, tables: "*" };
    }

    const tables = new Set(
      this.entries.filter((e) => e.rev > since).map((e) => e.table)
    );
    return { epoch: this.epoch, rev: this.rev, tables: [...tables] };
  }
}

// Shared instance for the server. Same instance powers /api/changes in both
// the container and the future Workers entry.
export const changeLog = new ChangeLog();