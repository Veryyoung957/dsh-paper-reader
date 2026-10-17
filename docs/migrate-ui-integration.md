# Migration panel integration record

## Outcome

Final independent review: **PASS**, `docs/migrate-ui-review.md` round 4 (t12), with captain visual sign-off. Historical needs_revision sections are superseded by that final verdict. No open blocker remains. This approves integration only, not deployment.

Implementation commit on `feat/migrate-prompt`: **e0f19d89b0f766b2fe58e629d008b746465b0cab** — `feat: 迁移状态面板重做 + 迁移/删除一次点击确认`.

This record is committed separately so it can name the immutable implementation commit and its post-commit evidence without a self-referential hash.

## Commit manifest (`git show --stat --oneline e0f19d8`)

22 files changed, 1246 insertions, 279 deletions:

- README.md, README_EN.md
- docs/darkmode-subtopic-plan.md
- docs/features.md, docs/features_EN.md
- docs/migrate-prompt-plan.md
- docs/migrate-ui-requirements.md (new; authoritative frozen design)
- docs/migrate-ui-review.md (new; final independent PASS)
- docs/migrate-ui-verification.md (new)
- docs/reader-ux-requirements.md
- lib/client.js
- src/host.ts, src/library-manage.ts, src/migrate-prompt.ts, src/tools.ts
- src/library-status.ts (new)
- test/library-clear-and-busy.test.mjs
- test/migrate-prompt.test.mjs
- test/mutation-probe.mjs
- test/paper-status.test.mjs (new)
- test/reader-ux-verification.test.mjs, test/reader-ux.test.mjs

All paths were staged explicitly; no `git commit -a`. The five new implementation/design/evidence files above are tracked. No dist/, reader/index.html, .probe/, package-lock.json, .gitignore or src/translate.ts was staged.

## Findings disposition

| Finding | Status and evidence |
| --- | --- |
| R1: new need paired with stale prompt; migrated still asks, unknown records asked | Fixed. Complete authoritative need/prompt/state pair; epochs reject stale responses; unknown cannot record asked. P25c/d and independent authority probes passed. Old stale probe assumed contradictory authoritative endpoints, formally rejected by reviewer. |
| R2: zero migratable items shown as unreadable failure | Fixed. Normal zero-item `migNothingToExecute` differs from unknown `migNotExecutable`. |
| F1: missing frozen four-column table, column alignment, group actions | Fixed. Four headers, shared grid tracks, topic groups and collapse/expand. Independent 900px three rows all x=[53,351.5625,519.375,687.1875]. |
| F2: reachable pagination snapshot change retains old N/list | Fixed. Snapshot change immediately clears data before restarting page zero. Independent real load-more probe held reload pending and observed intro=null, rows=0. |
| F3: stacked narrow-screen states lack axis labels | Fixed. At 420px every row shows Translation/MinerU/Migration labels; labels inline, no overflow. Desktop labels hidden. Captain visually signed off independent screenshots. |

Remaining non-blocking limitations: screenshots use an equivalent DOM hook harness rather than a deployed host. Host theme/contrast must be checked after separately authorized deployment. Existing unrelated dead keys and 36 environment-dependent skips remain unchanged.

## Post-commit verification on e0f19d8

Tracked working tree was clean. `git status --porcelain` returned only the captain-approved baseline exception:

```text
?? package-lock.json
```

This pre-existing installation artifact is deliberately retained untracked, not deleted or moved.

| Exact command (workdir `.worktrees/migrate-ui-report`) | Exit | Raw result |
| --- | --- | --- |
| `git status --porcelain` | 0 | only `?? package-lock.json` |
| `npm run build` | 0 | `tsc -p tsconfig.json` |
| `npm test` | 0 | tests 582; pass 546; fail 0; cancelled 0; skipped 36; todo 0 |
| `node --test test/merge-readme-parity.test.mjs test/library-clear-and-busy.test.mjs` | 0 | tests 30; pass 30; fail 0; skipped 0 |

Local raw outputs: integration-full.log and integration-guards.log (ignored). Added `t.skip`/`test.skip` scan of committed test diff: `[]`.

README/features describe the status panel and warning + single-click flow. `docs/migrate-prompt-plan.md` lines 7–11 explicitly supersede historical typed-migrate UI statements, leaving CLI/read-only report APIs intact. README does not reference the new requirements document; the plan's requirements links resolve to a tracked file. README documentation-reference and version guards passed.

## Main-workspace preservation

SHA-256 of `git diff -- <path>` in `/home/vr/My_Projects/dsh-paper-reader`, before and after implementation commit, unchanged:

- `.gitignore`: `8cf561cb640d98809939f56db3397759262b28b357184a2c0ac35a33ade52ba3`
- `src/translate.ts`: `9c7a617ef8e0990e8acac221578bfd02a2e4203fbedba577d856df5b4267a17f`

No push, no PR, no deployment, no real-library migration or deletion was performed. Integration does not authorize any of those actions.
