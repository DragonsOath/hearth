# Warden's workstation (conversation mode)

The owner's brief (2026-10-12, `warden_persistent_floating_workspace_spec.md` and their messages): conversation mode becomes a workstation. Warden and the conversation in the middle; a list on the left opens any service, project, the to-do list, or plans as floating panels; panels move, resize, grow for a moment, minimize, and close with X; approvals and "Warden is working" pop up and are never covered. His reference picture: To-do, System Status, Downloads on the left, Plex, Sonarr, Tautulli on the right, Warden and the chat in the middle.

## How it fits with what was there

- The desk (several docked panels beside Ember, workspace groups 20.14, temporary expansion 20.16) is unchanged. The workstation is a separate floating layer that exists only in conversation mode.
- Panels reuse the desk's panel views: ServiceWorkspace and ProjectWorkspace render inside a floating window through the same PanelChrome (the header becomes the drag handle; the window's own controls replace the frame's close). To-do and Plans are small panel versions; the full pages stay.
- Approvals use the existing JobCard (Approve and run, then "Running now", then the result). Finished plans also raise the existing PlanNotices in the corner.

## Behaviour

- **Open:** from the list (search, tools, projects, services by category, with logos). A panel already open is brought forward, never duplicated. Nothing opens by itself; buttons under an answer ("Open Radarr") come from the services the answer actually read, and only a click opens them.
- **Place:** a new panel goes to the side of Warden with fewer panels, right first, cascading. Your own placement wins after that.
- **Move and resize:** drag the header; resize from the left, right, and bottom edges and both bottom corners. Keyboard: the grip button, arrow keys move, Shift with arrows resizes. Panels cannot leave the screen; positions are fractions of the workspace, so a smaller window keeps every panel reachable.
- **Layering:** touching a panel brings it forward. "Warden forward" lifts the conversation above the panels until you touch a panel again.
- **Expand:** fills the workspace for now; Esc or the same button puts it back exactly. Esc otherwise ends the conversation.
- **Minimize:** to the tray at the bottom left; a click restores it with its state.
- **Close:** X removes that panel from the saved layout. It never touches the app's data or the conversation. Ending the conversation is a separate button.
- **Pop-ups:** above every panel, bottom centre: "Warden is working: <step>" while it works, and each plan waiting in this conversation with Approve and run. Hiding a pop-up keeps the plan in Plans.
- **Copy:** every Warden answer in the transcript has Copy.
- **Phones and tablets:** no floating windows. A Panels button opens the list; one panel shows at a time over Warden, with a switcher row. The desktop arrangement is kept untouched.

## Persistence (the model chosen)

- One layout per conversation, on the server (`talk_layouts`, migration 0043; `GET/PUT /api/talk/layouts/:key`). Before a conversation's first message the key is `draft:<chat box>`; when the conversation is created its panels move to it.
- Saved 0.7 s after a change (not on every pixel of a drag), at once on open, close, and minimize, and again when leaving the page. Up to 12 panels, 32 KB.
- Coming back to the conversation (another page, refresh, browser restart) restores the panels, their places, sizes, order, minimized state, and tabs. The conversation history is the conversation itself.
- The microphone never starts on its own: conversation mode opens only from your click on Talk; nothing old is played.
- A deleted service keeps its panel with an explanation; a broken panel shows its error and Try again, and Warden carries on (an error boundary per panel). If saving fails, the header says "Layout not saved yet" and the next change tries again.

## Not in this version

- Scroll and filter positions inside each panel are kept while it is open, but only tabs are saved across reloads.
- Panels open from Warden's answers only through the buttons under the answer, not by inline links in the text.
- Owner verification: AWAITING THE OWNER.
