# Contracts: src/address-book/

> Global invariants and the rule of engagement live in [../INTERFACES.md](../INTERFACES.md). Update this file before changing any contract surface in this subsystem.

## src/address-book/

### `store.ts`
**Purpose:** Read and write this node's address book. The book labels recipients in gate specs and CLI output, resolves `otzi btc send <label>`, and can serve as the policy recipient allowlist (`allowed_recipients = "address-book"`).

**File:** `/etc/otzi/address-book.otzi.json`, Ötzi's `AddressBookFile` format (`{ kind: 'otzi-address-book', version: 1, network, entries }`, see [otzi.md](otzi.md) `address-book.ts`). Ownership `root:otzi`, mode 0640. One book per node; nodes do not share or sync books.

**Public surface:**
- `const DEFAULT_ADDRESS_BOOK_PATH = '/etc/otzi/address-book.otzi.json'`

- `async readAddressBook(path: string, network: NetworkName): Promise<AddressBookEntry[]>`
  - **Pre:** `network` is the configured network.
  - **Post:** Returns the validated entries (`parseAddressBookFile(JSON, network)`). Returns `[]` when `path` does not exist (ENOENT); the CLI and spec labelling rely on this. The policy loader (`loadAddressBook`) does not: it treats a missing file as a failure (see below).
  - **Throws:** `Error('address book <path>: <reason>')` for an unreadable file (`cannot be read: <filesystem error>`), invalid JSON (`not valid JSON`), wrong `kind` / `version`, any invalid entry, or a file network ≠ `network` (`<reason>` is then the message from `parseAddressBookFile`). Every error names the book that failed.

- `async writeAddressBook(path: string, network: NetworkName, entries: AddressBookEntry[]): Promise<void>`
  - **Pre:** Caller has write access to the directory (root on a `.deb` install).
  - **Post:** `validateEntries(entries, network)` passes; `addressBookFile(validated, network)` is written as pretty JSON to a temporary file in the same directory with mode 0640, then renamed over `path`. Readers see either the old book or the new one, never a partial file.
  - **Throws:** On the first invalid entry (`validateEntries` message) — nothing is written — or on a filesystem error (the temporary file is removed).

- `resolveRecipient(entries: AddressBookEntry[], labelOrAddress: string, network: NetworkName): string`
  - **Post:** The address of the first entry whose `label` equals `labelOrAddress` exactly; otherwise `labelOrAddress` itself when it is a valid address for `network`.
  - **Throws:** `Error('unknown label or invalid address: <labelOrAddress>')`.

**Invariants:**
- The file network always equals the configured network; a mismatched book is an error, never silently ignored.
- Every write validates the full entry list (Ötzi rules: trimmed label 1–64 chars, valid address, unique addresses, note ≤ 256 chars, at most 1000 entries).
- Writes are atomic (temp file + rename) and land at mode 0640.
- The book can widen a policy allowlist, so writing it takes the same privilege as editing `daemon.toml`; reading takes `otzi` group membership.
- The book is Ötzi's file format: `otzi book export` output imports into web Ötzi and Ötzi exports import here.

**Cross-component contracts:**
- Depends on: `validateEntries`, `parseAddressBookFile`, `addressBookFile` (`src/otzi/lib/address-book.ts`), `isValidAddress` (`src/otzi/lib/bitcoin.ts`).
- Used by:
  - `Daemon`: `addressBook = () => readAddressBook(DEFAULT_ADDRESS_BOOK_PATH, network)` for the orchestrator and leader (spec labels via `labelFor`), and `loadAddressBook` for `PolicyGate`: the entries' addresses, throwing when the file does not exist (ENOENT) or is invalid, so `allowed_recipients = "address-book"` rejects every signing spec on a node without a book.
  - `src/cli/cmd/book.ts` (all verbs), `src/cli/cmd/btc.ts` (`resolveRecipient` for `btc send`, labels in the `btc send` / `btc sign` summaries; `bookPath` option, default `DEFAULT_ADDRESS_BOOK_PATH`).
  - `src/cli/cmd/backup.ts` / `restore.ts` (tar path `etc/otzi/address-book.otzi.json`, restored at 0640).

**Notes / gotchas:**
- The daemon reads the book at each use (each spec build, each `"address-book"` policy evaluation); edits take effect without a restart.
- In the daemon, a missing or invalid book means no labels for spec building and a reject for the `"address-book"` policy rule (strict by default). In `btc sign`, an unreadable book means no labels and a warning; in `btc send`, it is an error naming the book (a missing file is an empty book).
- The `"address-book"` rule compares addresses by exact string (see [gate.md](gate.md)): a book entry in another letter case than the lowercase bech32 the analysis produces never matches.
- Labels are not required to be unique; `resolveRecipient` takes the first match, so keep labels unique for `btc send`.
