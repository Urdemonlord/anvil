# anvil

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Urdemonlord/anvil/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Urdemonlord/anvil/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Anvil is a standalone GitHub-compatible git forge in one Node 22 process, stdlib only: git smart HTTP (upload-pack protocol v2, receive-pack v0), REST v3, GraphQL v4 and MCP, with a pure-TypeScript packfile codec and no git binary. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

## Run it

```sh
node --experimental-strip-types main.ts
```

Without `MAKEFUN_ENV_URL` it serves standalone on `$PORT` (or an ephemeral port); with it, it registers with the trial environment and exits when the trial is done. `MAKEFUN_SHOP_TOKEN` is the bearer token the forge expects.

---

<sub>Entered on [make.fun](https://make.fun/?ref=xq7dtvgn&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
