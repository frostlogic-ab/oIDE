# Changelog

All notable changes to oIDE are recorded here. The project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); pre-1.0 minor versions may break things.
The detailed build history lives in [docs/wiki/log.md](docs/wiki/log.md).

New entries are written by [release-please](https://github.com/googleapis/release-please) from the
Conventional Commit titles of merged pull requests, in the release pull request it keeps open on
`main`. Do not add entries by hand; give your pull request a good title instead. The pipeline is
described in [docs/wiki/pages/release-pipeline.md](docs/wiki/pages/release-pipeline.md).

## [0.8.0](https://github.com/frostlogic-ab/oIDE/compare/v0.7.0...v0.8.0) (2026-11-28)


### Added

* **accounts:** run agents on several Claude Code accounts, with per-account usage in the status bar ([#71](https://github.com/frostlogic-ab/oIDE/issues/71)) ([a2b1ff6](https://github.com/frostlogic-ab/oIDE/commit/a2b1ff6f272709b468d27a1c1d7fd9877d1b426a))
* **artifacts:** kanban boards that people and agents work together ([#76](https://github.com/frostlogic-ab/oIDE/issues/76)) ([810e57a](https://github.com/frostlogic-ab/oIDE/commit/810e57ad12c014413b82e531e04990296dc302dc))
* **attachments:** click a pending image's thumbnail to preview it ([#79](https://github.com/frostlogic-ab/oIDE/issues/79)) ([4ea0b1c](https://github.com/frostlogic-ab/oIDE/commit/4ea0b1cc7c0795c6f65829a43c4a32baf21500fb))
* **files:** grey out git-ignored files and folders in the tree ([#70](https://github.com/frostlogic-ab/oIDE/issues/70)) ([ba758ef](https://github.com/frostlogic-ab/oIDE/commit/ba758ef7b0426a288a4b6efd879d2100acca6ded))
* **files:** offer to install missing language servers, and ship the common ones ([#68](https://github.com/frostlogic-ab/oIDE/issues/68)) ([42592ff](https://github.com/frostlogic-ab/oIDE/commit/42592ff4c8f643887f8100cdbea00f075a2f70de))
* **files:** show newer npm versions inline in package.json, click to start an upgrade agent ([#75](https://github.com/frostlogic-ab/oIDE/issues/75)) ([3084dd6](https://github.com/frostlogic-ab/oIDE/commit/3084dd6e1382ea74655de39c1795b8a81337a536))
* **files:** show the command-bar trigger in the Files header for quick file search ([#81](https://github.com/frostlogic-ab/oIDE/issues/81)) ([06f1902](https://github.com/frostlogic-ab/oIDE/commit/06f19028b0b450f8167c9baa489174eaa9f97818))
* **shell:** native macOS menu bar with File, Edit, View, Agent, Window and Help ([#73](https://github.com/frostlogic-ab/oIDE/issues/73)) ([45aedf0](https://github.com/frostlogic-ab/oIDE/commit/45aedf0af26474859ff32edf03af66db6fdb7f43))
* **ui:** restyle toasts as dark cards that match the app's design ([#80](https://github.com/frostlogic-ab/oIDE/issues/80)) ([b544521](https://github.com/frostlogic-ab/oIDE/commit/b544521651612fe74226ae8b850691a75617fe9d))
* **usage:** open a Usage screen from Tokens today ([#65](https://github.com/frostlogic-ab/oIDE/issues/65)) ([1f4ad78](https://github.com/frostlogic-ab/oIDE/commit/1f4ad78649809ca38db155dc238f766b452a70c5))


### Fixed

* **files:** make the editor context menu opaque ([#66](https://github.com/frostlogic-ab/oIDE/issues/66)) ([f2bf1c3](https://github.com/frostlogic-ab/oIDE/commit/f2bf1c3c19106750072540d61bf98a7bb2f1199e))
* **git:** ignore EPIPE when git exits before reading stdin ([#72](https://github.com/frostlogic-ab/oIDE/issues/72)) ([59113e7](https://github.com/frostlogic-ab/oIDE/commit/59113e7ece0bb5341347e27fdf650c926dcad763))
* **git:** recount an agent's diff right after committing its pending work ([#74](https://github.com/frostlogic-ab/oIDE/issues/74)) ([0a67a5e](https://github.com/frostlogic-ab/oIDE/commit/0a67a5e4a2b0ab51644c20ff5614bface2c22e11))
* **source-control:** open a worktree row's ··· menu outside the project card ([#78](https://github.com/frostlogic-ab/oIDE/issues/78)) ([ff1f49b](https://github.com/frostlogic-ab/oIDE/commit/ff1f49b7e6b77d2c9355ecddf99de955faaf11e6))
* ten usability fixes across the renderer ([#77](https://github.com/frostlogic-ab/oIDE/issues/77)) ([4ea40a5](https://github.com/frostlogic-ab/oIDE/commit/4ea40a5425b2abd810abac191f7c71a0effabea3))

## [0.7.0](https://github.com/frostlogic-ab/oIDE/compare/v0.6.0...v0.7.0) (2026-11-27)


### Added

* **files:** close the Files tree legend with an × in its corner ([#50](https://github.com/frostlogic-ab/oIDE/issues/50)) ([1dec6f9](https://github.com/frostlogic-ab/oIDE/commit/1dec6f9955b7f57cdc8d69d9f022fb1b33b742b4))
* **files:** keep the tab bar to file names, move file status below the editor ([#62](https://github.com/frostlogic-ab/oIDE/issues/62)) ([e2edac3](https://github.com/frostlogic-ab/oIDE/commit/e2edac320b089f27d924715a073ccda24a65dcc9))
* **files:** language servers in the Files editor ([#53](https://github.com/frostlogic-ab/oIDE/issues/53)) ([d213c00](https://github.com/frostlogic-ab/oIDE/commit/d213c001ee2ddecd785123c0a407cf6171458ee5))
* **files:** minimap with a draggable slider in the Files editor ([#49](https://github.com/frostlogic-ab/oIDE/issues/49)) ([a789ae3](https://github.com/frostlogic-ab/oIDE/commit/a789ae30e5c3494bbaf258bbbf2ae51c9a144bbb))
* **files:** open changed files on their changes, unified or side by side ([#51](https://github.com/frostlogic-ab/oIDE/issues/51)) ([193dfe4](https://github.com/frostlogic-ab/oIDE/commit/193dfe49da29c1d89beef5aef42658936b894f23))
* **files:** show only the file name on editor tabs ([#52](https://github.com/frostlogic-ab/oIDE/issues/52)) ([689b266](https://github.com/frostlogic-ab/oIDE/commit/689b266a1476a18cc6bc0f1d6c4873c0b204fefb))
* **shell:** drop the agent counters from the Wall and Focus header ([#63](https://github.com/frostlogic-ab/oIDE/issues/63)) ([72a12b6](https://github.com/frostlogic-ab/oIDE/commit/72a12b6c215ca6247db574b74332edbcda81e68e))
* **shell:** mouse back / forward buttons navigate screen history ([#56](https://github.com/frostlogic-ab/oIDE/issues/56)) ([fa4d655](https://github.com/frostlogic-ab/oIDE/commit/fa4d655d1f85508f26793a72079a642bb2f297f1))
* **shell:** open several windows on one profile ([#55](https://github.com/frostlogic-ab/oIDE/issues/55)) ([8becaa4](https://github.com/frostlogic-ab/oIDE/commit/8becaa41375e57e4ed7ea5128c0779a5edce5f84))
* **terminal:** copy and paste in terminals, from the keyboard and a right-click menu ([#54](https://github.com/frostlogic-ab/oIDE/issues/54)) ([f9e52ff](https://github.com/frostlogic-ab/oIDE/commit/f9e52ff3507467a9cf0bed04149cbd3c12b28cda))


### Fixed

* **agents:** replies to idle agents respect Max running ([#59](https://github.com/frostlogic-ab/oIDE/issues/59)) ([c309e98](https://github.com/frostlogic-ab/oIDE/commit/c309e989b12d6b2ce6a278a4a859c93f1d8336f2))
* **agents:** show Running when a subagent report wakes the lead ([#60](https://github.com/frostlogic-ab/oIDE/issues/60)) ([39f18b7](https://github.com/frostlogic-ab/oIDE/commit/39f18b76f21f866f47aabc63ccfff05c16af5fa2))
* **artifacts:** show live thumbnails on the Artifacts grid and the Wall aside ([#57](https://github.com/frostlogic-ab/oIDE/issues/57)) ([b85304f](https://github.com/frostlogic-ab/oIDE/commit/b85304f1554b3bb4c3677ed57698daacdb8da0a8))
* **telemetry:** one Umami session per install across launches and upgrades ([#46](https://github.com/frostlogic-ab/oIDE/issues/46)) ([8a766c3](https://github.com/frostlogic-ab/oIDE/commit/8a766c3e832e17c70b9172375fcea8da4dbf9111))
* ten usability fixes across Spawn, Wall, Review, Source control, Files, Settings and Extensions ([#58](https://github.com/frostlogic-ab/oIDE/issues/58)) ([7416b4e](https://github.com/frostlogic-ab/oIDE/commit/7416b4eaded2fe4943124db2524f8d81257d7917))
* **ui:** drop "by Frostlogic" from header logos; app logo opens getoide.com ([#64](https://github.com/frostlogic-ab/oIDE/issues/64)) ([fd3d905](https://github.com/frostlogic-ab/oIDE/commit/fd3d905503c79ad6fb0abb6f440ad9f2d12628a6))
* **ui:** highlight menu items under the pointer ([#47](https://github.com/frostlogic-ab/oIDE/issues/47)) ([6084a2b](https://github.com/frostlogic-ab/oIDE/commit/6084a2bdf8c421737a3215347534bf87354dd87d))
* **wall:** scroll long subagent lists instead of stretching the tile ([#61](https://github.com/frostlogic-ab/oIDE/issues/61)) ([93f3d61](https://github.com/frostlogic-ab/oIDE/commit/93f3d61710a191f9c4e003d92a2680ad2fe6dc25))

## [0.6.0](https://github.com/frostlogic-ab/oIDE/compare/v0.5.1...v0.6.0) (2026-11-27)


### Added

* **desktop:** fetch projects automatically and offer Pull in the Projects sidebar ([#38](https://github.com/frostlogic-ab/oIDE/issues/38)) ([f379f42](https://github.com/frostlogic-ab/oIDE/commit/f379f42c967abfdb08b5d020638d2efdc4b89831))
* **files:** close tabs from a tab context menu and with middle click ([#41](https://github.com/frostlogic-ab/oIDE/issues/41)) ([0790c4e](https://github.com/frostlogic-ab/oIDE/commit/0790c4e516f73335f241aafd93bc274e828193fc))
* **files:** git colours in the Files tree and Discard changes ([#43](https://github.com/frostlogic-ab/oIDE/issues/43)) ([c4da2f6](https://github.com/frostlogic-ab/oIDE/commit/c4da2f6502f4bcea8a46841d58691c1a6d83984f))
* **files:** manage files from the tree context menu (new, rename, copy, move, delete) ([#34](https://github.com/frostlogic-ab/oIDE/issues/34)) ([759211e](https://github.com/frostlogic-ab/oIDE/commit/759211eeb37d31a258bf4004ba636616b5d69102))
* **files:** preview Markdown files, edit them beside a live preview ([#39](https://github.com/frostlogic-ab/oIDE/issues/39)) ([ff751b3](https://github.com/frostlogic-ab/oIDE/commit/ff751b36c829209c7afd03745ca8ecdac2d2d3e4))
* **files:** run project scripts from the tree and use several terminals ([#40](https://github.com/frostlogic-ab/oIDE/issues/40)) ([8d620bf](https://github.com/frostlogic-ab/oIDE/commit/8d620bf745f83c70168e586fef637585ee592305))
* **site:** show "by Frostlogic" under oIDE in the website headers ([#45](https://github.com/frostlogic-ab/oIDE/issues/45)) ([a2c2f1f](https://github.com/frostlogic-ab/oIDE/commit/a2c2f1fd7e83e1433d2941132fb224ac7eeed039))
* **telemetry:** send the oIDE version on app_started ([#35](https://github.com/frostlogic-ab/oIDE/issues/35)) ([4ac2aae](https://github.com/frostlogic-ab/oIDE/commit/4ac2aaef4878bdebeaf666b7bb7ad8e697f55592))
* **updates:** download updates automatically, install on quit, header Update button ([#36](https://github.com/frostlogic-ab/oIDE/issues/36)) ([4705df7](https://github.com/frostlogic-ab/oIDE/commit/4705df75310b013ff4c452d058a3b5d4965c07db))


### Fixed

* **desktop:** tidy New project dialog spacing and stop horizontal scroll ([#42](https://github.com/frostlogic-ab/oIDE/issues/42)) ([d208035](https://github.com/frostlogic-ab/oIDE/commit/d208035ad7e906bd7db749589b0031216947f368))
* **wall:** wrap tile footer buttons by group on narrow tiles ([#44](https://github.com/frostlogic-ab/oIDE/issues/44)) ([9ce3587](https://github.com/frostlogic-ab/oIDE/commit/9ce35876e0d362b2155618315342156a84fc9335))

## [0.5.1](https://github.com/frostlogic-ab/oIDE/compare/v0.5.0...v0.5.1) (2026-11-27)


### Fixed

* **artifacts:** focus the open view's heading in the opening commit ([#32](https://github.com/frostlogic-ab/oIDE/issues/32)) ([9cfe1dd](https://github.com/frostlogic-ab/oIDE/commit/9cfe1dd69e9023b35856b75540a6cbefbaa4c889))

## [0.5.0](https://github.com/frostlogic-ab/oIDE/compare/v0.4.0...v0.5.0) (2026-11-27)


### Added

* **artifacts:** work on artifacts with an agent in the open view ([#31](https://github.com/frostlogic-ab/oIDE/issues/31)) ([8c32f37](https://github.com/frostlogic-ab/oIDE/commit/8c32f37db0379c1d427d10abf6bf6a975b1854cd))
* **desktop:** show CI checks status next to an agent's pull request ([#30](https://github.com/frostlogic-ab/oIDE/issues/30)) ([5f211ca](https://github.com/frostlogic-ab/oIDE/commit/5f211caa6eff3e5c81ac9aa78d5f50b5bb8da496))
* **wall:** remove the redundant "Next that needs you" header button ([4ce1dd2](https://github.com/frostlogic-ab/oIDE/commit/4ce1dd28c3255fa1cacf90c1c2377db5c44eb8f4))
* **wall:** remove the redundant "Next that needs you" header button ([00229aa](https://github.com/frostlogic-ab/oIDE/commit/00229aa47eebe1e50513011ff1d415a153c7ea1b))


### Fixed

* **desktop:** installed app no longer shows a blank taskbar icon on Windows ([12a180f](https://github.com/frostlogic-ab/oIDE/commit/12a180f5546b73e1351479d8919562aeed252aa4))
* **desktop:** installed app no longer shows a blank taskbar icon on Windows ([449b366](https://github.com/frostlogic-ab/oIDE/commit/449b3660f8b92126f08abf1ccb035c197a41d4a9))
* **windows:** notifications come from oIDE, not Electron ([#26](https://github.com/frostlogic-ab/oIDE/issues/26)) ([334f57e](https://github.com/frostlogic-ab/oIDE/commit/334f57e3b663709914f47c2f91a1308ca7afd935))
* **worktrees:** oIDE no longer keeps deleted worktree folders open on Windows ([2a81d16](https://github.com/frostlogic-ab/oIDE/commit/2a81d16712878ab87a257db1b9e69d98f46a828f))
* **worktrees:** oIDE no longer keeps deleted worktree folders open on Windows ([c46655e](https://github.com/frostlogic-ab/oIDE/commit/c46655e6f7729fa095c066796dcfddb48789901d))

## [0.4.0](https://github.com/frostlogic-ab/oIDE/compare/v0.3.0...v0.4.0) (2026-11-26)


### Added

* **ui:** show "by Frostlogic" under the oIDE logo in the header ([9ac9956](https://github.com/frostlogic-ab/oIDE/commit/9ac995600d28e66e261e21bf2f47a65b3a39c602))
* **ui:** show "by Frostlogic" under the oIDE logo in the header ([4f448d8](https://github.com/frostlogic-ab/oIDE/commit/4f448d80ce28c09133857529969874916675eadb))


### Fixed

* address review findings on recorder Esc, env row focus, drop refusal, draft test isolation ([117f460](https://github.com/frostlogic-ab/oIDE/commit/117f460785700d4b3c2916755cd15171c5790787))
* address second review round ([d3dcc73](https://github.com/frostlogic-ab/oIDE/commit/d3dcc733d35c5e735b13d193af8598483cbed1cb))
* address third review's minor findings ([0f442a8](https://github.com/frostlogic-ab/oIDE/commit/0f442a836288746d0bf2cbc8aba1a3ae7a91a2fd))
* **artifacts:** a stray scrim click no longer discards a filled-in New artifact dialog ([16373dd](https://github.com/frostlogic-ab/oIDE/commit/16373dda16ca0152f8fb682a4a2a824550507ade))
* **artifacts:** address review findings on kept drafts ([3802fe2](https://github.com/frostlogic-ab/oIDE/commit/3802fe2b988dcf7e5411c425b3af44c37bd1622e))
* **artifacts:** unsaved edits survive leaving the Artifacts screen ([6e06fda](https://github.com/frostlogic-ab/oIDE/commit/6e06fda9623179c5ebef478605ec6cfbc6806511))
* **extensions:** a settings reload no longer discards what the user is typing ([18584e5](https://github.com/frostlogic-ab/oIDE/commit/18584e5094ff65a193fcd49996b68ff117e6d40a))
* **focus:** keep a half-typed message per agent across agent and screen switches ([5cf313b](https://github.com/frostlogic-ab/oIDE/commit/5cf313b94605e809cafd884316dde2470a28bf5b))
* **marketplace:** keep typed custom-extension input, removable env rows, honest drop zone, search across categories ([dd358e2](https://github.com/frostlogic-ab/oIDE/commit/dd358e22a1ed8cbfd299051967bc5850c7eeccec))
* **review:** escape the draft-key separator so UnifiedDiff.tsx stays a text file ([6642131](https://github.com/frostlogic-ab/oIDE/commit/66421316531f977b4817dbb6ef36d1b18364dbdd))
* **review:** go to Source control after a local merge; archived agents are not 'gone' ([6961212](https://github.com/frostlogic-ab/oIDE/commit/6961212207b94758dc8ae26a2f57fff00df87d72))
* **review:** keep half-written line comments when another line or file is opened ([5bb2fc1](https://github.com/frostlogic-ab/oIDE/commit/5bb2fc19b0238774d5d4ed0323e479ee68b0b4d6))
* second usability pass: kept drafts, safer dialogs, Marketplace search and Review after merge ([0964651](https://github.com/frostlogic-ab/oIDE/commit/0964651a4d0e9e37b3f77ae042c064923c814d16))
* **settings:** Tab leaves the shortcut recorder; focus returns to Change afterwards ([6e3ea21](https://github.com/frostlogic-ab/oIDE/commit/6e3ea21fa874b77e5c64d5f2c9ff6247dfbabf7f))
* **source-control:** keep the commit dialog open while a commit is in flight ([3ab57b0](https://github.com/frostlogic-ab/oIDE/commit/3ab57b0872b9f6b8b7c8cf936387aa13af2605d7))

## [0.3.0](https://github.com/frostlogic-ab/oIDE/compare/v0.2.0...v0.3.0) (2026-11-26)


### Added

* **site:** download buttons link to the latest installer for each OS ([a76cf48](https://github.com/frostlogic-ab/oIDE/commit/a76cf48a207826d080133d533c557fc4f971305a))
* **site:** download buttons link to the latest installer for each OS ([6b9d678](https://github.com/frostlogic-ab/oIDE/commit/6b9d67859d8e73d0bd93634ee41dae1a678021f6))
* **source-control:** revert uncommitted changes on the main checkout ([66ddf27](https://github.com/frostlogic-ab/oIDE/commit/66ddf2773877ac63df6fa4a8673c4fa64a3789e2))
* **source-control:** revert uncommitted changes on the main checkout ([71d32a6](https://github.com/frostlogic-ab/oIDE/commit/71d32a64681eb250bd2775d72eec0761902e84e1))


### Fixed

* address review findings on the usability fixes ([108d17c](https://github.com/frostlogic-ab/oIDE/commit/108d17c94a218366f4a0d4df184cad0b8d5ab869))
* **agent-core:** never launch an agent whose custom model was removed ([01950f6](https://github.com/frostlogic-ab/oIDE/commit/01950f64aa64b383f5141e0ffc083b3eaea6a1c7))
* **agent-core:** reject a removed custom model at spawn, before any worktree ([02510a2](https://github.com/frostlogic-ab/oIDE/commit/02510a24c1cc957afdfa1f29c4ad8b37f64a520e))
* **files:** retry a folder that failed to load instead of staying broken ([9bf023a](https://github.com/frostlogic-ab/oIDE/commit/9bf023a1a1bdac7a413e1e4772cfe854995ef7f0))
* **files:** unsaved edits keep their marker and close warning after leaving Files ([6a123ec](https://github.com/frostlogic-ab/oIDE/commit/6a123eca4dffb48e4f2685d02d83ca8764895092))
* **focus:** artifact picker closes with Esc and its own button, returns focus ([a01c0e7](https://github.com/frostlogic-ab/oIDE/commit/a01c0e70dbc27bf9e50278360d45f1419a6002fa))
* **focus:** explain why Resume is blocked and hide Pause where it does nothing ([a327b0f](https://github.com/frostlogic-ab/oIDE/commit/a327b0fe0d60f64530a8395183bee1360651be12))
* **focus:** show the real allow/deny shortcuts on the permission prompt ([aec6dda](https://github.com/frostlogic-ab/oIDE/commit/aec6dda4afbe43c7b26d05bafaf973850d17d56a))
* **licenses:** generate identical notices on every OS ([d36c311](https://github.com/frostlogic-ab/oIDE/commit/d36c3117657affe6a5414a27e1dcf279d65aa35a))
* **licenses:** generate identical notices on every OS ([df949cf](https://github.com/frostlogic-ab/oIDE/commit/df949cfee1b692a01d01e6566d9f6618d19ad664))
* **licenses:** make notices identical on every OS so the macOS release build passes ([2c734c3](https://github.com/frostlogic-ab/oIDE/commit/2c734c3b6e553e1df6b9c14e73292c0bc3c91631))
* **review:** send-feedback button follows pending comments and cannot resend nothing ([2220424](https://github.com/frostlogic-ab/oIDE/commit/22204249efad8fdeae6908d738cbee0fbc309072))
* **review:** show a retryable error when the diff fails instead of "No changes yet" ([f95f6c2](https://github.com/frostlogic-ab/oIDE/commit/f95f6c202442f401af86c0b1a71ab4e201867b6e))
* **review:** show Push to pull request only when there is something to push ([93c0599](https://github.com/frostlogic-ab/oIDE/commit/93c0599c76ebada896f39de7a4992eb79db63dd8))
* **review:** show Push to pull request only when there is something to push ([99a8dcc](https://github.com/frostlogic-ab/oIDE/commit/99a8dcc033be827363054e0c52928396cfe4e70d))
* **settings:** confirm before removing a model, deleting a technique or resetting shortcuts ([64e4070](https://github.com/frostlogic-ab/oIDE/commit/64e407069acb27526d71d33599e3cc3118151f5d))
* **shell:** command bar keeps a valid selection while file results load ([9590cf7](https://github.com/frostlogic-ab/oIDE/commit/9590cf73f518cccfe35978310b2e4b16f176b0f1))
* **spawn:** keep the typed goal on stray clicks and Esc, wait for attachments ([43f7016](https://github.com/frostlogic-ab/oIDE/commit/43f7016b69e4acf0afcaee98a57575850650063c))
* ten usability fixes across Focus, Spawn, Files, Review and Settings ([971241c](https://github.com/frostlogic-ab/oIDE/commit/971241ca20b296fd41d7e65862537f3a78f32a3b))
* **updates:** address review: empty releases feed, stuck drafts, lockfile drift ([4967f4b](https://github.com/frostlogic-ab/oIDE/commit/4967f4b870f7843471b0d4afeaa6298d7a8365c6))
* **updates:** keep the Windows portable zip off the updater; clearer check failures ([d30cb9a](https://github.com/frostlogic-ab/oIDE/commit/d30cb9aa3c6f735fd76479b231eb3b7cd451e3e5))
* **updates:** unblock the macOS release build and verify the update feed before publishing ([89eaad8](https://github.com/frostlogic-ab/oIDE/commit/89eaad8aa8c1805e49984f0265bc55d2c5080978))

## [0.2.0](https://github.com/frostlogic-ab/oIDE/compare/v0.1.0...v0.2.0) (2026-11-26)


### Added

* **agent-core:** agents sync their branch with the base at start and before review ([2cdb54f](https://github.com/frostlogic-ab/oIDE/commit/2cdb54f1f6963bf102fb23d307a3c8402bd23dc4))
* archive instead of PR when nothing to push ([a039289](https://github.com/frostlogic-ab/oIDE/commit/a039289c52aa7baafc09a71b7c66fe98a0e7375c))
* follow project conventions when creating PRs ([d69ad56](https://github.com/frostlogic-ab/oIDE/commit/d69ad56442769bf94319dfb44277982a78e53ad5))
* **git:** implement auto-stash functionality during merges ([1801249](https://github.com/frostlogic-ab/oIDE/commit/18012491580eb404ca2acc3916e927e1d354acac))
* open pull requests that follow the project's own conventions ([e9fd936](https://github.com/frostlogic-ab/oIDE/commit/e9fd936e0cd510e926d52f139105281c531eadde))
* **review:** push follow-up work to an open pull request ([99d0957](https://github.com/frostlogic-ab/oIDE/commit/99d0957fe7b4cbcbd6f084daa974a915a983b78a))
* **review:** push follow-up work to an open pull request ([077e55a](https://github.com/frostlogic-ab/oIDE/commit/077e55afb0b2813d391481b0358ff208dec97a4a))


### Fixed

* **agent-core:** status-only follow-ups return to Ready for review ([183de3c](https://github.com/frostlogic-ab/oIDE/commit/183de3ce107361a3a2907307595b2dca6de1d2c2))
* **agent-core:** status-only follow-ups return to Ready for review ([f0adb5a](https://github.com/frostlogic-ab/oIDE/commit/f0adb5a6fdc7173e44a796d7553f2ac5b3ef30fa))
* **diagnostics:** never put a raw userData path in the report; fix e2e races ([ef85bbe](https://github.com/frostlogic-ab/oIDE/commit/ef85bbe187ca2c439ada1f2c94ebbe0f24ad564b))
* **files:** Enter no longer runs the same search twice; fix editor test race ([e031715](https://github.com/frostlogic-ab/oIDE/commit/e031715408b5276304cf399c40ba9518898f6010))
* fix CSP eval error in artifact preview ([9db87d6](https://github.com/frostlogic-ab/oIDE/commit/9db87d6ddc7fa7164c9460ed13e5af4af61609b2))
* let artifact previews run claude.ai Design exports (allow eval in artifact CSP) ([63df1f7](https://github.com/frostlogic-ab/oIDE/commit/63df1f7c1b48a204de37c8f133b63c455b9c7764))
* make CI green on main (SEC-34 check, Windows holder scan, diagnostics redaction, test races) ([c073c04](https://github.com/frostlogic-ab/oIDE/commit/c073c04676626271ac14d8b74490e792da23e0bc))
* **reliability:** stop the Windows holder scan from autoloading modules ([277bb5c](https://github.com/frostlogic-ab/oIDE/commit/277bb5ceb7d1840b53248486de9105b4177b2ebf))


### Security

* custom model env allow-list with value checks, unspoofable confirmations ([896ca5d](https://github.com/frostlogic-ab/oIDE/commit/896ca5d025354361611aa81319531e5564e42ff3))
* restrict custom model env, bind keys to env, dedicated CLI picker ([ea5cbd9](https://github.com/frostlogic-ab/oIDE/commit/ea5cbd998bd5a6221eb9e3fc08cc8f50190fcbad))

## 0.1.x (after 0.1.0, before automated releases)

Hand-written notes for the work that landed between the internal 0.1.0 build and the first release
cut by release-please. It ships in that first release.

### Added

- Opt-in usage analytics and crash and error reports (Umami), sent from the main process only: a
  first-run question, two switches in Settings › Privacy (both off by default), `DO_NOT_TRACK` and
  `OIDE_TELEMETRY=0` respected, no code, prompts, paths or project information ever sent. See
  [PRIVACY.md](PRIVACY.md).
- Auto-update through electron-updater on GitHub Releases, with stable and beta channels and a
  Settings › Updates section (channel, check now, current version, last check). Updates never install
  without consent and are off in development builds.
- Release CI: tag-driven Windows, macOS and Linux builds to a draft GitHub Release, with signing and
  notarization steps that run only when the signing secrets exist.
- Nightly real-CLI smoke job (opt-in, self-hosted runner) and a weekly CLI compatibility job that
  records fresh fixtures and opens an issue on drift; Dependabot and CodeQL.
- Documentation site (VitePress) with a user guide and an extension author guide.
- Open-source project files: Code of Conduct (Contributor Covenant 2.1), issue and pull request
  templates, this changelog, generated `THIRD_PARTY_NOTICES.md` (shipped in packaged builds, checked in
  CI with `pnpm licenses:check`) and an original app icon.
- Artifact editors: embedded Excalidraw for whiteboards (supersedes ADR 0005), Monaco for docs and
  designs, compare any two versions, rename and delete, and conflict handling when an agent saves
  while you have unsaved edits.
- Extension UI contribution points wired: panels (sandboxed `oide-ext://` frames), commands,
  Settings › Extensions, themes, techniques, deploy targets and artifact types (ADRs 0008, 0009;
  `languages` is deferred).
- Toasts, a live status bar, a shortcuts editor, `/` slash commands and the Review comment side
  (ADRs 0006 and 0007, store migration 2).
- Reliability: per-service crash isolation, rotating redacted logs, Settings › Diagnostics, ordered
  shutdown and Windows process-tree cleanup.
- Milestone gate tests for M2 to M6 (`test/gates/`) and an end-to-end gate spec.

### Security

- All core findings of the 2026-11-24 review are fixed (SEC-01 to SEC-31; one accepted risk), including
  a custom model env allow-list with value checks and confirmations a renderer cannot spoof.
- Local merge now keeps uncommitted worktree changes (review blocker B1).

## [0.1.0] - 2026-11-24

First internal build. Not signed, not published.

### Added

- **Foundations**: pnpm monorepo, hardened Electron shell (context isolation, sandbox, no Node in the
  renderer, strict CSP, blocked navigation, Electron fuses), Zod-validated IPC contract in
  `@oide/protocol`, `node:sqlite` store with migrations and backups, CI on Windows, macOS and Linux,
  unsigned installers (NSIS, zip, dmg, AppImage, deb, rpm).
- **Agents**: the user's own Claude Code CLI driven over stream-json (`ClaudeCliDriver`), parser,
  supervisor with a queue and "Max running", subagent tracking through `parent_tool_use_id`, interrupt
  and permission-mode control requests, `/compact`, resume after restart, plan usage from rate-limit
  events. Verified against real CLI 2.1.325; tests run against `tools/fake-claude`.
- **oIDE MCP server**: permission prompt tool, `submit_for_review`, and `artifacts.*` tools.
- **Screens**: Wall (tiles, inline permission prompts, J/K/N), Spawn (presets, routed subagents,
  techniques, up to six attempts), Focus (transcript, subagent tree, composer, inspector), Source
  control, Review (inline comments back to the agent, PRs via `gh`, local merge), Files (Monaco with
  agent attribution), Artifacts (local designs, docs, whiteboards with history), Marketplace and Settings.
- **Git**: one worktree and `oide/<slug>` branch per agent, overlap detection, merge-tree conflict
  prediction, worktree cleanup and orphan detection.
- **Extensions**: `@oide/extension-api`, manifest schema, extension host in utility processes, MCP tools
  with `read` / `ask` risk labels, installer with integrity check and no install scripts, Add custom (MCP
  URL with OAuth, import from other apps, local command, folder or git), marketplace index tooling and
  the built-in git, browser-preview and themes extensions.
- **Settings and trust**: all Settings sections, custom model endpoints with keys in the OS keychain,
  model version pinning, project `.oide/` files, workspace trust and Bypass guard rails.
- **Product wiki** in `docs/wiki/` and ADRs 0001 to 0004.

### Security

- Adversarial security, brief-conformance and design-conformance reviews before release
  ([review-security](docs/wiki/pages/review-security.md)). Fixed the extension and custom-tool
  findings (native confirmations, origin-bound credentials, per-agent proxy secrets, project-scoped
  artifact reads); core findings were still open in this build (fixed since, see 0.1.x).

### Known issues

- Merging a worktree locally ignored uncommitted worktree changes (review blocker B1; fixed since).
- Extension UI contribution points (panels, themes, techniques, languages, deploy targets, artifact
  types) were not wired yet (wired since, except `languages`).
- Builds are unsigned: Windows SmartScreen warns, and macOS needs a right-click › Open.

[0.1.0]: https://github.com/frostlogic-ab/oIDE/releases/tag/v0.1.0
