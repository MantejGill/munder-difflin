# Lab mode

Lab mode turns the office into the live view of a research lab. An external orchestration loop (the lab) drives the floor over a
loopback control server; the app stays the only writer of the hive. It is **off by default**; with it off the app behaves exactly as
before.

Turn it on with `MD_LAB_CONTROL=1` in the environment, or `"lab": { "enabled": true }` in `config.json`:

```jsonc
{
  "lab": {
    "enabled": true,
    "godName": "Dwight",                    // default "Dwight"; MD_LAB_GOD_NAME overrides
    "godRole": "Lab orchestrator (Opus)",   // MD_LAB_GOD_ROLE overrides
    "godPrompt": "..."                      // the orchestrator's contract; written to agents/god/identity.md
  }
}
```

## What changes

| | |
| --- | --- |
| The god seat | A PTY-less agent named from the lab config. No Claude CLI process in the CEO room, no `/remote-control`, no orientation prompt, no wake nudge (those loops only visit agents that own a PTY). The monitor tab shows no engine, model or restart control for it. |
| Lab agents | Registered over the control server with provider `lab`: a floor avatar, status, context gauge, cost, kanban assignee. No terminal. `archiveOrphanedAgents` never archives them. They are not offered in the hire pickers. |
| Control server | `src/main/labControl.ts`: HTTP on `127.0.0.1`, random port, bearer token. It writes `<hive>/lab-control.json` (`{ version, host, port, url, token }`, mode 0600, gitignored). Every request needs `Authorization: Bearer <token>`; the `Host` header must be the loopback address and port; a request with an `Origin` header (a browser) is refused; JSON only, 1 MiB cap; every field is validated (`src/shared/labControlProtocol.ts`). |
| The lab tab | Progress curve (best so far over trials), ladder rung and escalation history, reframe proposals with predicted versus measured, ruled-out list, held-out lesson gate counts, budget including reframe trials owed and tested, violations, and pending human gates with an Approve button. Data: the `lab-v4-progress/1` snapshot the lab posts. English-only strings. |
| Human gates | `POST /lab/gate` makes a blocked card with a `humanQA` question (it shows on the kanban and on the ASK ME board). Answering it there, or `POST /lab/approve` (the lab tab's button), resolves it and moves the card to done. |

## Endpoints

`LAB_ROUTES` in `src/main/labControl.ts` is the list. All bodies are JSON.

| | |
| --- | --- |
| `GET /lab/health`, `GET /lab/state` | liveness; phase (`idle`/`running`/`paused`), the god seat, the gates |
| `POST /lab/start`, `/lab/pause`, `/lab/finish`, `/lab/approve`, `/lab/gate` | the lab verbs |
| `POST /lab/agents` | register (upsert) a lab agent: `{ id, name, role, character?, accent?, capabilities? }`. The god seat's name and role always come from the config. |
| `POST /lab/tasks`, `PATCH`/`DELETE /lab/tasks/:id` | cards, through `HiveManager.addTask/patchTask/deleteTask` (merge-safe; an existing id is updated, its `createdAt` kept) |
| `POST /lab/messages` | a hive message, routed and logged by `HiveManager.send`; lab agents' mail is then acknowledged |
| `POST /lab/status` | `{ agentId, event?, tool?, message?, context? }`: an avatar event and/or the context gauge |
| `POST /lab/cost` | one call's tokens and cost; the app keeps cumulative totals per (agent, session) and appends the ledger row |
| `POST /lab/progress`, `GET /lab/progress` | the snapshot the lab tab draws |
| `POST /lab/board`, `/lab/agent-files`, `/lab/log` | one fenced section of `board.md`; one fenced section of a **lab** agent's `identity.md`/`memory.md` (refused for any other agent); a `log.jsonl` line |

## Try it without a lab

```bash
MD_LAB_CONTROL=1 npm run dev
# in another shell, with the hive directory the app opened:
TOKEN=$(node -p "require('<hive>/lab-control.json').token"); PORT=$(node -p "require('<hive>/lab-control.json').port")
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/lab/state
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"id":"lab-e1","name":"Kevin","role":"Trial Executor"}' http://127.0.0.1:$PORT/lab/agents
```

## Tests

`npm run test:focused` includes `test/lab-*.test.cjs`: the provider, the control server (auth, loopback only, validation), the host
against the real `HiveManager`, the god seat, and the panel reducers (fed with recorded `lab-v4-progress/1` snapshots in
`test/fixtures/lab-v4-progress.json`). No test calls a model.

The theme, cast and tilesets are untouched; the LimeZu attribution in `src/renderer/src/assets/ATTRIBUTION.md` and the README stays as
it is.
