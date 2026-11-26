<script setup lang="ts">
// The oIDE home page, built from the "oIDE Website" design artifact (Main, Features and More
// artboards). Used by index.md through `layout: landing` (see ./index.ts). Every other page keeps the
// default VitePress theme, restyled in ./custom.css.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useData, withBase } from 'vitepress';

const repo = 'https://github.com/frostlogic-ab/oIDE';
const releases = `${repo}/releases/latest`;
// Direct links to the newest installer. release.yml uploads a copy of every installer without the
// version in its name (oIDE-mac-arm64.dmg, oIDE-linux-x64.deb, ...) next to the versioned file, so
// GitHub's /releases/latest/download/<name> redirect always serves the latest stable release.
type Arch = 'x64' | 'arm64';
const file = (name: string) => `${releases}/download/oIDE-${name}`;

const { isDark } = useData();

type Os = 'mac' | 'win' | 'linux';
const NAME: Record<Os, string> = { mac: 'macOS', win: 'Windows', linux: 'Linux' };

// The visitor's system, to name it on the download buttons. Phones and tablets get no guess.
const os = ref<Os | null>(null);
onMounted(() => {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const hint = nav.userAgentData?.platform || nav.platform || '';
  const ua = nav.userAgent || '';
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return;
  os.value = /Win/i.test(hint) ? 'win' : /Mac/i.test(hint) ? 'mac' : /Linux|X11|CrOS/i.test(hint + ua) ? 'linux' : null;
});

// Apple silicon, x64 Windows and x64 Linux unless the browser says otherwise (Chromium only).
const arch = ref<Record<Os, Arch>>({ mac: 'arm64', win: 'x64', linux: 'x64' });
onMounted(async () => {
  const uad = (navigator as Navigator & {
    userAgentData?: { getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }> };
  }).userAgentData;
  if (!os.value || !uad?.getHighEntropyValues) return;
  try {
    const { architecture } = await uad.getHighEntropyValues(['architecture']);
    if (architecture === 'arm' || architecture === 'x86') {
      arch.value = { ...arch.value, [os.value]: architecture === 'arm' ? 'arm64' : 'x64' };
    }
  } catch {
    // Keep the defaults.
  }
});

// The main installer for each system, and where the big Download button goes.
const installer = computed<Record<Os, string>>(() => ({
  mac: file(`mac-${arch.value.mac}.dmg`),
  win: file(`win-${arch.value.win}.exe`),
  linux: file(`linux-${arch.value.linux}.AppImage`),
}));
const dlHref = computed(() => (os.value ? installer.value[os.value] : '#download'));

const dlLong = computed(() => (os.value ? `Download for ${NAME[os.value]}` : 'Download oIDE'));
const alsoFor = computed(() => {
  if (!os.value) return 'For macOS, Windows and Linux.';
  const rest = (['mac', 'win', 'linux'] as Os[]).filter((k) => k !== os.value);
  return `Also for ${NAME[rest[0]]} and ${NAME[rest[1]]}.`;
});

// One split-button menu open at a time; Escape or a click elsewhere closes it.
const menu = ref<'nav' | 'hero' | 'close' | null>(null);
function toggle(id: 'nav' | 'hero' | 'close') {
  menu.value = menu.value === id ? null : id;
}
function onDocClick(e: MouseEvent) {
  if (menu.value && !(e.target as Element).closest?.('.dl')) menu.value = null;
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') menu.value = null;
}
onMounted(() => {
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onKey);
});

const platforms = [
  { os: 'mac' as Os, label: 'macOS', note: 'Apple silicon · Intel' },
  { os: 'win' as Os, label: 'Windows', note: 'x64 · ARM64' },
  { os: 'linux' as Os, label: 'Linux', note: 'AppImage · .deb · .rpm' },
];

// Download cards. Builds are on GitHub Releases with a SHA256SUMS file (.github/workflows/release.yml).
const cards = computed(() => [
  {
    os: 'mac' as Os, id: 'dl-mac', title: 'macOS', button: 'Download .dmg',
    alt: [
      { label: 'Apple silicon', href: file('mac-arm64.dmg') },
      { label: 'Intel', href: file('mac-x64.dmg') },
      { label: '.zip', href: file(`mac-${arch.value.mac}.zip`) },
    ],
    cmd: 'shasum -a 256 -c SHA256SUMS --ignore-missing', req: 'macOS 12 or later.',
  },
  {
    os: 'win' as Os, id: 'dl-win', title: 'Windows', button: 'Download installer',
    alt: [
      { label: 'x64', href: file('win-x64.exe') },
      { label: 'ARM64', href: file('win-arm64.exe') },
      { label: '.zip', href: file(`win-${arch.value.win}.zip`) },
    ],
    cmd: 'Get-FileHash .\\oIDE-*-win-x64.exe', req: 'Windows 10 or 11.',
  },
  {
    os: 'linux' as Os, id: 'dl-linux', title: 'Linux', button: 'Download AppImage',
    alt: [
      { label: '.deb', href: file(`linux-${arch.value.linux}.deb`) },
      { label: '.rpm', href: file(`linux-${arch.value.linux}.rpm`) },
      arch.value.linux === 'arm64'
        ? { label: 'x64', href: file('linux-x64.AppImage') }
        : { label: 'ARM64', href: file('linux-arm64.AppImage') },
    ],
    cmd: 'sha256sum -c SHA256SUMS --ignore-missing', req: 'Ubuntu 22.04, Fedora 39 or newer.',
  },
]);

const copied = ref<Os | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
async function copy(key: Os, text: string) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = key;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.value = null), 1400);
  } catch {
    // Clipboard blocked: the command stays visible to select by hand.
  }
}

type Cell = { v: 'yes' | 'no' | 'some'; t: string };
const y = (t = 'Yes'): Cell => ({ v: 'yes', t });
const n = (t = 'No'): Cell => ({ v: 'no', t });
const s = (t: string): Cell => ({ v: 'some', t });
const compare: { row: string; cells: [Cell, Cell, Cell, Cell] }[] = [
  { row: 'Uses your Claude plan through the official CLI', cells: [y(), s('Often API pricing'), y(), y()] },
  { row: 'Agents from many projects in one window', cells: [y(), n('One project per window'), s('Some'), s('By hand')] },
  { row: 'A worktree per agent, with overlap warnings', cells: [y(), s('Some'), s('Worktrees, no warnings'), n('By hand')] },
  { row: 'A marketplace of tools made for agents', cells: [y(), s('Editor extensions'), n(), n()] },
  { row: 'claude.ai designs, docs and whiteboards inside', cells: [y(), n(), n(), n()] },
  { row: 'Model routing per subagent task', cells: [y(), s('One model picker'), s('One model picker'), s('Flags and config')] },
  { row: 'Free and open source', cells: [y('Yes, MIT'), n('Mostly not'), s('Some'), y()] },
];

const faq = [
  {
    q: 'Do I need an Anthropic API key?',
    a: 'No. oIDE runs the Claude Code CLI you already use, so it works with whatever that CLI is signed in to: a Claude Pro or Max plan, or an API key if you prefer one. Usage counts against that account the same way it does in your terminal.',
  },
  {
    q: 'Can oIDE see my credentials?',
    a: "No. You sign in through Anthropic's own flow in the CLI. oIDE starts the CLI and reads its event stream. It does not touch tokens and it does not modify the CLI.",
  },
  {
    q: 'Is oIDE made by Anthropic?',
    a: 'No. oIDE is an independent open-source project that works with Claude Code. It is not affiliated with or endorsed by Anthropic.',
  },
  {
    q: 'Can I still edit files myself?',
    a: 'Yes. There is a file editor with tabs, search and a terminal. It is simple on purpose, because most of your time in oIDE goes into directing and reviewing agents.',
  },
  {
    q: 'How many agents can I run at once?',
    a: "As many as your machine and your plan's limits allow. Settings › Agents › Max running (3 by default) queues the rest. The status bar shows session and weekly usage, so you can see how fast you are spending it.",
  },
  {
    q: 'Does it work with local models?',
    a: "Yes, through the CLI's own environment variables. Add an endpoint under Settings › Models and it appears next to the built-in models. A model needs tool use to work well as an agent.",
  },
];

const img = (name: string) => withBase(`/shots/${name}`);
</script>

<template>
  <div class="site">
    <a class="skip" href="#top">Skip to content</a>

    <header class="nav">
      <div class="wrap">
        <a class="brand" :href="withBase('/')"><img class="on-dark" :src="withBase('/logo-mark.svg')" width="24" height="24" alt="" /><img class="on-light" :src="withBase('/logo-mark-light.svg')" width="24" height="24" alt="" />oIDE</a>
        <nav class="nav-links" aria-label="Main">
          <a href="#direct">Features</a>
          <a href="#extend">Extensions</a>
          <a href="#how">How it works</a>
          <a href="#compare">Compare</a>
          <a :href="withBase('/guide/getting-started')">Docs</a>
        </nav>
        <a class="nav-gh" :href="repo">
          <svg class="ic solid" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" /></svg>
          <span>GitHub</span>
        </a>
        <button class="theme-toggle" type="button" aria-label="Switch between dark and light theme" @click="isDark = !isDark">
          <svg class="ic on-dark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
          <svg class="ic on-light" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></svg>
        </button>
        <div class="dl">
          <a class="btn btn-primary dl-main" :href="dlHref">
            <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg><span>Download<span v-if="os" class="os-name"> for {{ NAME[os] }}</span></span>
          </a>
          <button class="btn btn-primary dl-caret" type="button" :aria-expanded="menu === 'nav'" aria-label="Choose another platform" @click="toggle('nav')">
            <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
          </button>
          <div v-if="menu === 'nav'" class="dl-menu">
            <a v-for="p in platforms" :key="p.os" :href="`#dl-${p.os}`" @click="menu = null">{{ p.label }} <small>{{ p.note }}</small></a>
            <a class="all" :href="releases">All downloads on GitHub Releases</a>
          </div>
        </div>
      </div>
    </header>

    <main id="top">
      <!-- HERO: the moat, then proof -->
      <section class="hero">
        <div class="wrap">
          <span class="label go"><i></i>Open source · agent-first IDE · v0.1 preview</span>
          <h1><span>Six agents.</span> <span>Three projects.</span> <span class="punch">One window.</span></h1>
          <div class="hero-row">
            <p class="lede">
              oIDE is a desktop app for directing coding agents instead of typing code. Run many Claude Code sessions side by side
              across all your repos, <b>on the Claude plan you already have</b>.
            </p>
            <div class="cta">
              <div class="cta-btns">
                <div class="dl">
                  <a class="btn btn-primary btn-lg dl-main" :href="dlHref">
                    <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg><span>{{ dlLong }}</span>
                  </a>
                  <button class="btn btn-primary btn-lg dl-caret" type="button" :aria-expanded="menu === 'hero'" aria-label="Choose another platform" @click="toggle('hero')">
                    <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                  </button>
                  <div v-if="menu === 'hero'" class="dl-menu">
                    <a v-for="p in platforms" :key="p.os" :href="`#dl-${p.os}`" @click="menu = null">{{ p.label }} <small>{{ p.note }}</small></a>
                    <a class="all" :href="releases">All downloads on GitHub Releases</a>
                  </div>
                </div>
                <a class="btn btn-ghost btn-lg" :href="repo">Star on GitHub</a>
              </div>
              <small>Free, MIT licensed. {{ alsoFor }}</small>
            </div>
          </div>

          <ol class="moat">
            <li><i class="pin" aria-hidden="true">1</i><b>Runs on your Claude plan</b><span>oIDE drives your own signed-in <span class="mono">claude</span> CLI. No API key, and it never sees your credentials.</span></li>
            <li><i class="pin" aria-hidden="true">2</i><b>Every project in one window</b><span>Agents from all your repos on one wall, each working in its own git worktree.</span></li>
            <li><i class="pin" aria-hidden="true">3</i><b>A marketplace of agent tools</b><span>Extensions give agents new abilities. Any MCP server works too, listed or not.</span></li>
            <li><i class="pin" aria-hidden="true">4</i><b>claude.ai artifacts built in</b><span>Designs, docs and whiteboards that your agents can read and write.</span></li>
          </ol>
        </div>

        <div class="hero-shot">
          <div class="window">
            <img :src="img('wall.jpg')" width="2880" height="1928" fetchpriority="high" alt="The oIDE agent wall. Six agent tiles from three projects show live activity, subagents and context use. One tile asks permission to run npm install, one has a question, one is ready for review. A projects list is on the left, artifacts and the marketplace on the right, and plan usage in the status bar." />
            <span class="needs-you" aria-hidden="true"></span>
            <i class="pin" style="left: 64.2%; top: 98.6%" aria-hidden="true">1</i>
            <i class="pin" style="left: 11.2%; top: 7.6%" aria-hidden="true">2</i>
            <i class="pin" style="left: 97.1%; top: 82.7%" aria-hidden="true">3</i>
            <i class="pin" style="left: 87.6%; top: 8%" aria-hidden="true">4</i>
          </div>
        </div>
      </section>

      <!-- DIRECT -->
      <section class="sec alt" id="direct">
        <div class="wrap">
          <div class="sec-head">
            <span class="label go"><i></i>Direct</span>
            <h2><span class="s">Hand out goals.</span> <span class="s">Step in only when asked.</span></h2>
            <p>The wall shows every agent you have running. Most of the time you just watch. When one of them needs you, it says so.</p>
          </div>

          <article class="feat">
            <div class="feat-head">
              <span class="label hold"><i></i>The wall</span>
              <h3>An agent that needs you shows it on its tile</h3>
              <div class="feat-body">
                <p>Three things stop an agent: it wants permission, it has a question, or it is finished. Each one shows up in color on the wall, and you deal with it right there. <span class="kbd">N</span> jumps to the next agent that is waiting.</p>
              </div>
            </div>
            <div class="fig tiles">
              <figure class="tile">
                <div class="shot"><img :src="img('tile-permission.jpg')" width="836" height="592" loading="lazy" alt="Agent tile marked Needs permission: a subagent wants to run npm install node-pty. Buttons: Allow once, Always in oide, Deny." /></div>
                <b><i></i>Needs permission</b>
                <span>Allow once, always allow in this project, or deny. The prompt names the subagent that asked.</span>
              </figure>
              <figure class="tile">
                <div class="shot"><img :src="img('tile-question.jpg')" width="836" height="540" loading="lazy" alt="Agent tile marked Has a question, asking whether invoice dates should use the customer's timezone or UTC, with a reply box and a Send button." /></div>
                <b><i></i>Has a question</b>
                <span>Type the answer on the tile. The agent picks up where it stopped.</span>
              </figure>
              <figure class="tile">
                <div class="shot"><img :src="img('tile-review.jpg')" width="836" height="540" loading="lazy" alt="Agent tile marked Ready for review with a summary, 8 files changed, and buttons Review diff and Open PR." /></div>
                <b class="review"><i></i>Ready for review</b>
                <span>Read the agent's summary, then open the diff or go straight to a pull request.</span>
              </figure>
            </div>
          </article>

          <article class="feat split">
            <div class="feat-copy">
              <span class="label"><i></i>Spawn</span>
              <h3>Start an agent with a goal, a mode and a budget</h3>
              <p>Describe the outcome and attach what the agent should read. Then choose how much freedom it gets and how much of your plan it may spend.</p>
              <ul class="ticks">
                <li>Attach a design, a doc, a file or a URL as context.</li>
                <li>Every Claude Code permission mode, from Manual to Bypass. Auto is the default.</li>
                <li>Cheap, Balanced or Quality decides which model leads and which ones do the subagent work.</li>
                <li>Run the same goal as several parallel attempts and keep the best one.</li>
              </ul>
            </div>
            <figure class="fig">
              <div class="shot fade"><img :src="img('spawn.jpg')" width="1440" height="1160" loading="lazy" alt="Spawn an agent dialog: a goal, context chips, project and worktree pickers, five permission modes with Auto selected, and model presets Cheap, Balanced, Quality and Custom." /></div>
            </figure>
          </article>

          <article class="feat">
            <div class="feat-head">
              <span class="label"><i></i>Focus view</span>
              <h3><span class="s">Open one agent.</span> <span class="s">Keep the other five in reach.</span></h3>
              <div class="feat-body">
                <p>The focus view has the full transcript, the plan, the changed files and a real terminal. Subagents get their own cards and a timeline, each with its model, effort and token count.</p>
                <ul class="ticks">
                  <li><span class="kbd">J</span> <span class="kbd">K</span> move between agents without going back to the wall.</li>
                  <li>A context ring per agent. Compact the conversation when it fills up.</li>
                </ul>
              </div>
            </div>
            <figure class="fig">
              <div class="shot"><img :src="img('focus.jpg')" width="2334" height="1520" loading="lazy" alt="Focus view of the agent 'Wire the Claude Code CLI bridge': the transcript with file edits and three subagent cards, and a Subagents panel with a timeline and each subagent's model, status and tokens." /></div>
              <figcaption><b>Focus view.</b> The lead agent's transcript on the left, its three subagents on the right.</figcaption>
            </figure>
          </article>
        </div>
      </section>

      <!-- REVIEW -->
      <section class="sec" id="review">
        <div class="wrap">
          <div class="sec-head">
            <span class="label review"><i></i>Review</span>
            <h2>Nothing reaches main until you say so.</h2>
            <p>Every agent works on its own branch in its own git worktree. You review the result the way you would review a teammate's pull request.</p>
          </div>

          <article class="feat">
            <div class="feat-head">
              <span class="label review"><i></i>Source control</span>
              <h3>Every project, every worktree, one screen</h3>
              <div class="feat-body">
                <p>See what each agent changed, which branches are behind, and what is ready for review. oIDE warns you when two agents edit the same file, before it turns into a merge conflict.</p>
              </div>
            </div>
            <figure class="fig">
              <div class="shot"><img :src="img('source-control.jpg')" width="2766" height="992" loading="lazy" alt="Source control screen: the oide project with its main branch state and three agent worktrees with status and diff stats, a review queue, and a heads-up that two worktrees change the same file." /></div>
              <figcaption><b>Source control.</b> One card per repository. The heads-up on the right appeared because two agents both edited <span class="mono">package.json</span>.</figcaption>
            </figure>
          </article>

          <article class="feat split rev">
            <div class="feat-copy">
              <span class="label review"><i></i>Review</span>
              <h3><span class="s">Comment on the diff.</span> <span class="s">The agent fixes it.</span></h3>
              <p>Leave comments on lines and send them back as one round of feedback. The agent revises in the same worktree. When you are happy, open a pull request or merge locally.</p>
              <ul class="ticks">
                <li>The agent's own summary and the checks it ran sit next to the diff.</li>
                <li>Unified or split view, with a Viewed mark per file.</li>
              </ul>
            </div>
            <figure class="fig">
              <div class="shot"><img :src="img('review.jpg')" width="1646" height="1172" loading="lazy" alt="A diff of retry.ts with added lines in green, and an inline comment box on line 12 saying: Add jitter so retries from many events don't line up. Button: Add to feedback." /></div>
            </figure>
          </article>
        </div>
      </section>

      <!-- EXTEND -->
      <section class="sec alt" id="extend">
        <div class="wrap">
          <div class="sec-head">
            <span class="label hold"><i></i>Extend</span>
            <h2>Give agents better tools and better context.</h2>
            <p>An agent is only as good as what it can reach. oIDE has a marketplace of tools made for agents, and it brings your designs and docs into the project.</p>
          </div>

          <article class="feat">
            <div class="feat-head">
              <span class="label hold"><i></i>Marketplace</span>
              <h3>A marketplace where the customer is the agent</h3>
              <div class="feat-body">
                <p>Extensions add tools that agents can call: inspect a database, preview the app in a browser, deploy a branch. Every extension declares what its tools do. Read-only tools just run. Tools that change things ask first.</p>
              </div>
            </div>
            <figure class="fig">
              <div class="shot"><img :src="img('marketplace.jpg')" width="2766" height="1120" loading="lazy" alt="Extension marketplace listing agent tools: Postgres inspector, Browser preview, Preview deploys, Git, Error tracker and a custom Team wiki. A detail panel lists the three read-only tools Postgres inspector gives agents and the projects it is enabled for." /></div>
              <figcaption><b>Marketplace.</b> Install per project. The panel on the right lists exactly which tools an extension hands to agents.</figcaption>
            </figure>
          </article>

          <article class="feat split">
            <div class="feat-copy">
              <span class="label hold"><i></i>Custom tools</span>
              <h3><span class="s">Not in the marketplace?</span> <span class="s">Paste the URL.</span></h3>
              <p>Give oIDE the address of any MCP server. It works out how to connect, how to sign in and which tools the server offers.</p>
              <ul class="ticks">
                <li>Imports the servers you already set up in other apps on this computer.</li>
                <li>Switch single tools off, or make one ask first.</li>
                <li>Keep it to yourself, or share it with the project through git.</li>
              </ul>
            </div>
            <figure class="fig">
              <div class="shot fade"><img :src="img('add-custom.jpg')" width="1440" height="1280" loading="lazy" alt="Add a custom tool dialog. After pasting an MCP server URL, oIDE reports the server it reached, that it uses OAuth sign-in, and six tools found, each labelled read only or asks first." /></div>
            </figure>
          </article>

          <article class="feat">
            <div class="feat-head">
              <span class="label hold"><i></i>Artifacts</span>
              <h3>Designs, docs and whiteboards next to the code</h3>
              <div class="feat-body">
                <p>Import artifacts from claude.ai or let an agent write one. Hand a design to an agent as its spec, and see which agents are reading or writing each artifact.</p>
              </div>
            </div>
            <figure class="fig">
              <div class="shot"><img :src="img('artifacts.jpg')" width="2766" height="972" loading="lazy" alt="Artifacts library with design, doc and whiteboard cards from three projects. The selected design, Main window v2, is synced from claude.ai and read by two agents, with buttons Open, Give to an agent and Open in claude.ai." /></div>
              <figcaption><b>Artifacts.</b> "Give to an agent" starts a new agent with the artifact attached.</figcaption>
            </figure>
          </article>

          <article class="feat split rev">
            <div class="feat-copy">
              <span class="label hold"><i></i>Models</span>
              <h3>Decide where your usage goes</h3>
              <p>A preset sets which model leads and which models take the simple, standard and complex subagent tasks, each with its own effort level. Add a local or self-hosted model and it shows up in every picker.</p>
              <div class="usage">
                <div class="shot"><img :src="img('statusbar.jpg')" width="1008" height="52" loading="lazy" alt="Status bar reading: Max plan, Session 62 percent, Week 38 percent, 3 projects open." /></div>
                <span>Session and weekly usage stay in the status bar, so you see what a wall of agents costs you.</span>
              </div>
            </div>
            <figure class="fig">
              <div class="shot"><img :src="img('models.jpg')" width="1584" height="1000" loading="lazy" alt="Models settings. The Balanced preset uses Opus as orchestrator and routes simple subagent tasks to Haiku, standard tasks to Sonnet and complex tasks to Opus, each with an effort level." /></div>
            </figure>
          </article>
        </div>
      </section>

      <!-- HOW IT WORKS -->
      <section class="sec" id="how">
        <div class="wrap">
          <div class="sec-head">
            <span class="label"><i></i>How it works</span>
            <h2><span class="s">oIDE directs.</span> <span class="s">Your own CLI does the work.</span></h2>
            <p>oIDE has no model of its own and no sign-in of its own. It starts the Claude Code CLI you already installed, one process per agent, and shows you what each one is doing.</p>
          </div>
          <div class="flow">
            <div class="node"><span class="who">You</span><b>Set the goals</b><p>Spawn agents, answer them, review what they made.</p></div>
            <div class="link">goals, answers</div>
            <div class="node hub"><span class="who">oIDE</span><b>Runs the wall</b><p>Creates a worktree for each agent, starts a CLI process in it, and turns its event stream into a tile.</p></div>
            <div class="link">starts it, reads its events</div>
            <div class="yours">
              <span class="yours-tag">Your side: sign-in and tokens stay here</span>
              <div class="node"><span class="who">Your <code>claude</code> CLI</span><b>Does the work</b><p>The official CLI, unmodified, with its own permission modes, hooks and settings.</p></div>
              <div class="link">your sign-in</div>
              <div class="node"><span class="who">Anthropic</span><b>Your Claude plan</b><p>Usage counts against your account the same way it does in a terminal.</p></div>
            </div>
          </div>
          <ul class="facts">
            <li><b>oIDE never holds your credentials</b><span>You sign in through Anthropic's own flow in the CLI. oIDE does not read, store or send tokens.</span></li>
            <li><b>The same rules as your terminal</b><span>Permissions, hooks and project settings are Claude Code's own. oIDE only shows the prompts.</span></li>
            <li><b>Local first</b><span>Sessions, history and settings live on your machine and in each project's <span class="mono">.oide/</span> folder.</span></li>
          </ul>
        </div>
      </section>

      <!-- COMPARE -->
      <section class="sec alt" id="compare">
        <div class="wrap">
          <div class="sec-head">
            <span class="label"><i></i>Compare</span>
            <h2>Where oIDE fits</h2>
            <p>Plenty of tools run one coding agent well, and several run a few in parallel. oIDE is for running many across all your projects, and for giving them better tools.</p>
          </div>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col"><span class="sr-only">Capability</span></th>
                  <th scope="col" class="us">oIDE</th>
                  <th scope="col">AI code editors</th>
                  <th scope="col">Agent desktop apps</th>
                  <th scope="col">Terminal tabs</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in compare" :key="r.row">
                  <th scope="row">{{ r.row }}</th>
                  <td v-for="(c, i) in r.cells" :key="i" :class="{ us: i === 0 }"><span :class="c.v">{{ c.t }}</span></td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="fine">These are categories, not specific products. Last checked November 2026. <a :href="`${repo}/issues`">Open an issue</a> if a row is out of date.</p>
        </div>
      </section>

      <!-- DOWNLOAD -->
      <section class="sec" id="download">
        <div class="wrap">
          <div class="sec-head">
            <span class="label go"><i></i>Download · v0.1 preview</span>
            <h2>Get oIDE for your desktop</h2>
            <p>The same app on all three platforms. It checks for updates and asks before it installs one.</p>
          </div>
          <div class="os-grid">
            <div v-for="c in cards" :id="c.id" :key="c.id" class="os" :class="{ 'yours-os': os === c.os }">
              <div class="os-top"><h3>{{ c.title }}</h3><span v-if="os === c.os" class="os-flag">Your system</span></div>
              <a class="btn btn-primary" :href="installer[c.os]">{{ c.button }}</a>
              <div class="os-alt"><a v-for="a in c.alt" :key="a.label" :href="a.href">{{ a.label }}</a></div>
              <span class="cmd-label">Check the download against SHA256SUMS</span>
              <div class="cmd">
                <code>{{ c.cmd }}</code>
                <button type="button" :aria-label="`Copy the ${c.title} checksum command`" @click="copy(c.os, c.cmd)">{{ copied === c.os ? 'Copied' : 'Copy' }}</button>
              </div>
              <p class="os-req">{{ c.req }}</p>
            </div>
          </div>
          <p class="need">
            <i aria-hidden="true"></i>
            <span><b>You also need Claude Code.</b> oIDE uses the Claude Code CLI that you install and sign in to yourself, with a Claude Pro or Max plan or your own API key. On first launch oIDE looks for it and points you to Anthropic's install guide if it is missing. <a :href="withBase('/guide/getting-started')">Getting started</a></span>
          </p>
        </div>
      </section>

      <!-- OPEN SOURCE -->
      <section class="sec alt" id="open">
        <div class="wrap">
          <div class="sec-head">
            <span class="label"><i></i>Open source</span>
            <h2>Built in the open, extended by anyone</h2>
            <p>oIDE is MIT licensed. The app, the marketplace index and every first-party extension live on GitHub.</p>
          </div>
          <div class="doors">
            <a :href="withBase('/guide/getting-started')"><b>Read the docs</b><span>Getting started, keyboard shortcuts, settings, and how agents, worktrees and permissions fit together.</span><code>Guide →</code></a>
            <a :href="withBase('/extensions/')"><b>Write an extension</b><span>Package an MCP server or a view, declare its tools and what they are allowed to do, and publish it.</span><code>Extension author guide →</code></a>
            <a :href="withBase('/contributing')"><b>Contribute</b><span>Pick up a good first issue, propose a feature, or share the techniques that make your agents better.</span><code>Contributing →</code></a>
          </div>
        </div>
      </section>

      <!-- FAQ -->
      <section class="sec">
        <div class="wrap faq-grid">
          <div class="sec-head"><span class="label"><i></i>FAQ</span><h2>Questions people ask first</h2></div>
          <div class="faq">
            <details v-for="(f, i) in faq" :key="f.q" :open="i === 0"><summary>{{ f.q }}</summary><p>{{ f.a }}</p></details>
            <p class="faq-more">More in the <a :href="withBase('/faq')">full FAQ</a>.</p>
          </div>
        </div>
      </section>

      <!-- CLOSE -->
      <section class="sec alt">
        <div class="wrap close">
          <h2><span class="s">Stop babysitting terminals.</span> <span class="s">Run your agents from one window.</span></h2>
          <div class="dl">
            <a class="btn btn-primary btn-lg dl-main" :href="dlHref">
              <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg><span>{{ dlLong }}</span>
            </a>
            <button class="btn btn-primary btn-lg dl-caret" type="button" :aria-expanded="menu === 'close'" aria-label="Choose another platform" @click="toggle('close')">
              <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
            </button>
            <div v-if="menu === 'close'" class="dl-menu up">
              <a v-for="p in platforms" :key="p.os" :href="`#dl-${p.os}`" @click="menu = null">{{ p.label }} <small>{{ p.note }}</small></a>
            </div>
          </div>
        </div>
      </section>
    </main>

    <footer class="foot-band">
      <div class="wrap">
        <div class="foot">
          <div>
            <a class="brand" :href="withBase('/')"><img class="on-dark" :src="withBase('/logo-mark.svg')" width="24" height="24" alt="" /><img class="on-light" :src="withBase('/logo-mark-light.svg')" width="24" height="24" alt="" />oIDE</a>
            <p>The open desktop app for running teams of coding agents.</p>
          </div>
          <div>
            <h4>Product</h4>
            <ul>
              <li><a href="#direct">Features</a></li>
              <li><a href="#extend">Extensions</a></li>
              <li><a href="#download">Download</a></li>
              <li><a :href="`${repo}/releases`">Release notes</a></li>
            </ul>
          </div>
          <div>
            <h4>Docs</h4>
            <ul>
              <li><a :href="withBase('/guide/getting-started')">Getting started</a></li>
              <li><a :href="withBase('/guide/using-oide#keyboard')">Keyboard shortcuts</a></li>
              <li><a :href="withBase('/extensions/')">Writing extensions</a></li>
              <li><a :href="`${repo}/blob/main/docs/wiki/index.md`">Architecture wiki</a></li>
            </ul>
          </div>
          <div>
            <h4>Community</h4>
            <ul>
              <li><a :href="repo">GitHub</a></li>
              <li><a :href="`${repo}/discussions`">Discussions</a></li>
              <li><a :href="`${repo}/issues`">Issues</a></li>
              <li><a :href="`${repo}/blob/main/SECURITY.md`">Security policy</a></li>
            </ul>
          </div>
        </div>
        <p class="legal">oIDE is an independent open-source project released under the MIT License. It is not affiliated with, sponsored by or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC, and are used here only to describe compatibility.</p>
      </div>
    </footer>
  </div>
</template>

<style scoped src="./site.css"></style>
