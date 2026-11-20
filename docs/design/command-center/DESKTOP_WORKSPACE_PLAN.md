# Desktop command center: multi-panel workspace (plan)

Source: the owner's direction of 2026-10-09 (JARVIS-style desktop: converse while inspecting several
systems at once). Mobile and tablet stay as they are. Status markers: **Built**, **Next**,
**Later**, **Needs a decision**.

## Fit with what exists

| Need | Built on |
| ---- | -------- |
| Persistent conversation | The existing Cave panel (`CavePanel`, `CaveChat`, per-scope conversations, live progress). On desktop it becomes a dock: resizable, minimizable to a rail, or widened. |
| Several panels at once | The existing `ServiceWorkspace` and `ProjectWorkspace`, unchanged inside; a desk around them holds many. The open set lives in the address (`?panels=`), so refresh, back, and links keep it. |
| Pin, close, rearrange, resize | Desk state: pinned panels are never displaced; when there is no room, the least recently used unpinned panel moves to the "also open" strip (never closed automatically). Resize by dragging the edges between panels; move left or right from the panel header. |
| Fit the screen | The desk measures its own width: one panel needs about 340 px beside a 380 px dock (resizable). A 1440 px screen shows two panels, 1920 px three, larger monitors more; below 1024 px the existing split view (one panel, tabs on phones) takes over. |
| Cave references open panels | Links in answers, evidence, and progress steps add or focus a panel on desktop instead of replacing what is open. |
| Suggestions, not surprises | Under an answer, systems it referred to that are not open are offered as "Open" chips. Nothing opens or moves unless you click. |
| Saved layouts | Server-side (installation data, session only): a name, the panels, the dock width. Reopening a layout restores the arrangement; the conversation stays what it is. |
| Diagnostics | Phase 2: a Diagnostics tab per service combining live container state, Hearth's check, recent logs, incidents, and app-specific reads, each labelled Live or Recorded. App reads (queues, download clients, indexers) use the existing secure-vault integration pattern (read-only API, key never reaches the AI). |
| Original web interface | Phase 3, only where it is genuinely embeddable: an https address (no mixed content) whose own headers allow framing by this origin. Hearth never strips headers, proxies around sign-in, or weakens a service. Otherwise "Open original interface" opens it in a new tab. |

## Phases

1. **Desk foundation (Built 2026-10-09):** multi-panel desk on desktop, dock with resize,
   minimize, widen; pin, close, move, resize panels; "also open" strip; screen-aware panel count;
   Cave links open panels; "Open" suggestion chips; saved layouts; legacy `?service=`/`?project=`
   links still work; tablets and phones unchanged.
2. **Diagnostics (Built 2026-10-09):** Diagnostics tab for Prowlarr, Radarr, Sonarr, qBittorrent, SABnzbd (health, queue, activity, connections; Live/Recorded with read time; live reads every 20 s while open, never counted towards incidents). Original plan: Diagnostics tab with Live/Recorded labels from existing data; then
   read-only app integrations for the media chain (Radarr, Sonarr, qBittorrent, SABnzbd; Prowlarr
   exists), each switched on by adding its API key in the Secure Vault.
3. **Original interfaces (Later):** embeddability check per service and an embedded view where
   allowed.
4. **Investigation sessions (Later):** a saved layout linked to a conversation, so "the Radarr
   investigation" reopens with its panels and thread together.
