## [2026-11-28] build | Preview pending image attachments on click

Pasted or dropped images waiting to be sent showed only a 16-22px thumbnail with no way to see them
larger. The thumbnail (and, in the Spawn Context row, the name next to it) is now a button that opens
the image at full size. The dialog sent images already used in the transcript is now the shared
`ImagePreviewDialog` in `components/Attachments.tsx`, used by `MessageAttachments`, `AttachmentTray`
(Focus composer, Wall reply, Artifacts agent panel) and the Spawn `ContextChips`. It is portaled and
stops Esc, so closing the preview leaves the Spawn dialog open. No telemetry: a local view action that
answers no product question. Pages: [screen-focus](../pages/screen-focus.md),
[screen-spawn](../pages/screen-spawn.md).
