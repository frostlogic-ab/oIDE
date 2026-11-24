# Constraints

Hard requirements from Anthropic's terms for running Claude Code on a Pro or Max plan inside another
product. Breaking any of them puts users' accounts at risk. Mirrored in [CLAUDE.md](../../../CLAUDE.md).

| Rule | In code |
| --- | --- |
| Drive the user's own, unmodified `claude` CLI | Find the binary on PATH or a user-set path and spawn it. Never bundle or patch it. |
| Sign-in only through Anthropic's flow | No login screen. Signed out → open a terminal running `claude`. |
| Never read, store or forward Claude credentials | No code touches `~/.claude/.credentials.json` or Claude keychain items. Env from an allow-list. `test/no-credentials.test.ts` enforces it. |
| No direct calls to Anthropic's API | Every model call goes through the CLI process. |
| No "Claude" in the product name or logo | The product is oIDE. |
| Respect plan limits | Queue beyond Max running (default 3); no tight retry loops on rate limits. |

Non-goals for v1: a full manual-editing IDE, other agent CLIs, cloud or multi-user features, a hosted
marketplace backend. See [open-questions.md](open-questions.md) #1 (Anthropic's confirmation).
