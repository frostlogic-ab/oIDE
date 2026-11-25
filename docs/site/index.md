---
layout: home

hero:
  name: oIDE
  text: Mission Control for coding agents
  tagline: Run many Claude Code CLI agents in parallel, across many projects, in one window. Each agent is your own, unmodified claude CLI in its own git worktree.
  image:
    light: /logo-mark-light.svg
    dark: /logo-mark.svg
    alt: oIDE logo
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Write an extension
      link: /extensions/
    - theme: alt
      text: GitHub
      link: https://github.com/oide-dev/oide

features:
  - title: The Wall
    details: One tile per agent with status, context ring, live activity, diff counts and inline permission prompts. Press N to jump to the next agent that needs you, then Y or D to answer.
    link: /guide/screens/wall
  - title: Your own CLI, your own sign-in
    details: oIDE starts the claude CLI you installed and signed in to. It never reads your Claude credentials and never calls Anthropic's API itself.
    link: /guide/security-model
  - title: A worktree per agent
    details: Every agent works on its own oide/<slug> branch. Review its diff, leave inline comments that go back to the agent, then open a PR or merge locally. oIDE warns when two worktrees touch the same file.
    link: /guide/worktrees-and-review
  - title: Subagents you can see
    details: Routed presets (Cheap, Balanced, Quality) let a lead model hand tasks to cheaper subagents. Focus shows each subagent's transcript, tokens and context.
    link: /guide/screens/focus
  - title: Extensions that give agents tools
    details: Extensions are npm packages with an oide manifest. They add MCP tools with risk labels, commands, panels and settings. Install from the marketplace index or add your own MCP server.
    link: /extensions/
  - title: Open source, MIT
    details: Electron, TypeScript and React. Settings a team should share live in a project's .oide/ folder, in git.
    link: /contributing
---

<div class="vp-doc" style="max-width: 760px; margin: 48px auto 0; padding: 0 24px;">

oIDE is an independent open-source project. It is not made, endorsed or supported by Anthropic.
"Claude" and "Claude Code" are trademarks of Anthropic. oIDE is pre-1.0; see the
[FAQ](/faq) for what that means for your account and for the project's status.

</div>
