## [2026-11-27] build | Fix flaky open-view focus test that failed the 0.5.0 release
The Release Please run for 0.5.0 failed in Verify on one test, `AgentPanel.test.tsx` "opens on Preview
and switches to Code (and back) from the keyboard": focus ended on the open view's heading instead of
the Code radio. The Viewer moved focus to its heading in a passive `useEffect` on mount; on a slow
runner that effect ran after the test's first keypress and took focus back. It is now a
`useLayoutEffect`, so focus moves in the commit that opens the view, before any key can be pressed
(the same holds for a fast user). The test now asserts the heading has focus as soon as the view is
open. No behaviour change otherwise. Page: [screen-artifacts](../pages/screen-artifacts.md).
