## [2026-11-27] build | Files tab bar holds only the open files

The Files tab bar now holds only the open-file tabs. The Changes view (File / Unified / Split) and Markdown view (Preview / Edit) toggles, Read only, Ln/Col, language, "vs last commit" / "vs base branch" and Save move to a new file status bar under the editor (`<footer aria-label="File status">`, above the terminal panel). Later per-file indicators (language server state, problems) go there too. Page: [screen-files](../pages/screen-files.md). No telemetry change: a layout move answers no product question.
