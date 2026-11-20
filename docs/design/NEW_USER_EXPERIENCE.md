# Hearth: The New User Experience

**Product vision and design brief for Claude Code / DC / Repo**  
**Status:** Vision and requirements for investigation and planning, not authorization to implement, merge, or deploy.

## First, this is not criticism of the Hearth we've built

I want to be absolutely clear about this: **the current Hearth is valuable, and I am not asking you to tear it down or redesign the experienced-user workflow.** We've built a serious, useful platform for people who already run homelabs. They know what Docker, Plex, Jellyfin, Radarr, Sonarr, API keys, containers, and reverse proxies are. They want to connect their existing services, organize them, monitor them, and give their AI administrator tools to manage them. That audience may well be our **primary audience**. Keep serving them exceptionally well.

But **they are not the only audience I want Hearth to reach.** The existing setup and Getting Started checklist are largely written for someone who already knows what services they have or what services they need. A beginner doesn't. When we ask that person to configure an API key or choose a Docker service, we've accidentally asked them to do the very work they came to Hearth to avoid.

This document describes a **distinct beginner journey layered onto the existing product**, not a replacement for the advanced experience. Reuse the existing service integrations, secure credential systems, installer, checklist, AI tools, and management interface wherever possible. Don't duplicate functionality or disrupt current users.

## The person I want us to design for

Imagine someone who watches a YouTube video about Plex or Jellyfin. They think, *Wait, I could have my own Netflix?* They own an old laptop, perhaps with 4 GB of RAM, and an external drive containing 100 GB of movies. They don't know what a container is. They may not even know the difference between a media server and a media player. They have little or no budget. Their interest is real, but their technical knowledge is not there yet.

Maybe a friend recommends Hearth. Maybe they ask their existing AI assistant to find an easy way to build a media server, and it discovers our GitHub repository and evaluates the installation instructions. However they arrive, they should feel: **I can do this. Someone is going to help me. This looks fun.**

Do not hand this person a wall of configuration fields, a service catalog full of unfamiliar names, or a checklist telling them to obtain API keys. Their first task is not to become a systems administrator. Their first task is to tell us what excites them.

## The promise

> **Tell me what you want to build. I'll examine what you've got, figure out what's realistic, explain my recommendations, and help build it with your approval. Then I'll show you how it works and help you discover what else you can do.**

This is the difference between an AI-assisted installer and an AI that helps someone **become a homelab owner**.

The questionnaire provides **intent**. Authorized system inspection provides **reality**. Existing-service discovery provides **context**. The AI connects those three into a personalized, actionable plan. Then the platform uses appropriately scoped, verifiable tools to carry out approved steps.

## What the experience should feel like

The new user should enter a polished, inviting, playful experience, inspired by the plain-language questionnaire on dragonsoath.com but not copied as a sales quote builder. It should feel more like choosing a companion and beginning an adventure than filling out an IT ticket.

### 1. Welcome and choose a path

Offer a clear choice such as **"Help me build my first homelab"** and **"I already have a homelab"**. The second path leads into our existing, powerful onboarding and integration experience. This document focuses exclusively on the first path.

Avoid overwhelming the beginner with prerequisites before they understand the destination. Explain any truly unavoidable requirements in everyday language. Make it possible to pause, resume, and return later.

### 2. Create your AI companion

This is not a decorative extra. The AI is the character who will guide the owner through their first setup and become their long-term homelab companion.

Offer the five identities already being developed: **Guardian, Operator, Enchantress, Scholar, and Companion**. Let the user preview the available voices and choose among the existing avatar variants (five per identity), give the assistant a personal name, and customize the Hearth theme. Show personality differences through short, well-written introductions, not technical descriptions of TTS models. The underlying administrative tools, safety rules, and technical competence must remain consistent across personalities.

Hardware limitations must not block the experience: if local voice isn't feasible, the user can still choose the identity and use text, with a clear path to enable voice later. Never imply a voice is ready if the required speech services are not installed.

The user should feel that **this is *their* AI, in *their* command center**.

### 3. Ask human questions, not administrator questions

Use a short, adaptive questionnaire. Ask things such as:

- What would you love to do? Watch your own movies and shows? Listen to audiobooks? Keep photos? Run a smart home? Explore AI? Just see what's possible?
- Are you brand new, somewhat familiar, or experienced?
- Do you want to keep everything free, or are you comfortable with some spending? What is your actual budget?
- Do you already have media or files? Where are they stored? Are they on an external drive?
- What devices do you want to use to enjoy it, such as a TV, phone, tablet, or laptop?
- Is this only for your home, or do you eventually want safe access while away?
- How hands-on do you want to be: "build it for me and explain as we go" or "teach me each step"?

Keep questions relevant and progressive. Don't demand answers the system can discover. Don't ask for a port number, Docker network, Radarr root folder, or API key as an opening question. Offer "I don't know" and "decide for me" when sensible. The questionnaire should lead to a plan, not become a lengthy barrier to getting started.

### 4. Inspect the actual machine, with permission

The AI must not guess what the user's machine can handle. Use authorized local tools to inspect and report the real operating system, CPU, available and total RAM, disk capacity and free space, attached drives and mount points, GPU/transcoding capabilities where discoverable, existing applications, active services, Docker availability, and relevant resource use. Determine whether the AI is inspecting the actual target host or merely the device running the browser. If the target is remote or inaccessible, say so and request an appropriate connection or a manual alternative.

Distinguish measured facts from estimates. Consider the resources needed by the operating system and other workloads, not just nominal RAM or core count. Treat a 4 GB laptop conservatively. Do not silently scan other devices or networks. Ask permission for discovery with meaningful scope.

Existing services must be identified and preserved, not overwritten. Existing drives and media are valuable personal data. Never reorganize, delete, or move them without a specific approved plan.

### 5. Translate dreams and hardware into a sensible blueprint

The AI should choose **capabilities first, applications second**. For someone who wants a personal streaming library at no cost, Jellyfin might be a strong recommendation. For someone who already owns Plex and prefers it, reuse Plex. For audiobooks, consider Audiobookshelf. For optional media management, discuss Radarr and Sonarr only when they actually solve the owner's goals. Do not assume that a newcomer needs every popular container.

The blueprint must explain in plain English:

- What the owner will be able to do when setup is complete.
- Which applications are proposed, and why each is needed.
- What can comfortably run on this specific machine, what may be slow, and what should wait.
- Whether existing services and storage will be reused.
- Expected costs, subscriptions, disk usage, and relevant performance tradeoffs.
- What accounts or user input are genuinely needed.
- What changes require explicit approval, including network exposure, VPN, firewall, reverse proxy, or credentials.
- How the system will verify success and recover from failure.

Show a friendly, visual plan that the user can edit before approving it. Offer a modest starter build instead of an unrealistic all-at-once stack. Explain upgrades as **possibilities**, not pressure to buy hardware.

**Example:** The person with a 4 GB laptop, a 100 GB movie drive, and no budget might start with a carefully configured Jellyfin server and their existing files. Local large-language-model hosting, heavyweight photo indexing, and simultaneous transcoding may be inappropriate. Voice may fall back to text. The AI should explain that this is a real beginning, not a failure: *"We can get your movies working first. Once you've enjoyed that, I'll show you what else this laptop can do."* This is illustrative, not a fixed hardware recommendation; real inspection decides.

### 6. Build it for them, with meaningful approval

This is essential. **Do not stop at a questionnaire, a pretty recommendation card, or a checklist telling the beginner to install everything manually.** The long-term goal is an AI administrator that can carry out the approved work through safe tools.

After the owner reviews and approves a concrete plan, Hearth should orchestrate supported tasks such as installing or configuring a container runtime when needed, creating service containers, setting appropriate storage paths, configuring local accounts, integrating services, registering API credentials securely, importing or indexing existing media, and verifying that the user can reach and use the result.

Use the established Secure Vault and credential broker. Passwords and API keys must not be exposed in model prompts or logs. Use secure fields, generated secrets, or approved service APIs; if an external account requires human interaction, guide the user through it. Do not pretend all third-party accounts can be created automatically. Do not create paid accounts, accept terms, expose services to the internet, or make VPN/firewall/Caddy changes without the appropriate explicit authorization.

Treat qBittorrent, download automation, indexers, and VPN/Gluetun as optional, separate capabilities requiring a lawful use case and a specifically reviewed configuration. They are **not** mandatory components of "I want to watch the movies I already own." Do not bypass content access controls or assume a source of media.

The build must be resumable and idempotent: show what's pending, underway, completed, failed, or awaiting approval; retry safely without duplicating accounts, containers, or settings. Follow host-specific documentation, deployment paths, backups, ledgers, and rollback procedures. Verify each milestone rather than treating a successful command exit as proof that the user experience works.

### 7. Make the first success feel real

Don't end with "installation completed." End with an experience: *"Your movie library is ready. Let's open Jellyfin and play something."* Help the user find their actual files, confirm indexing, open the player, and test playback on the device they care about. If playback fails, investigate and repair through approved tools. Celebrate genuine milestones without manufactured flattery.

A beginner who arrived with an old laptop and some movies should leave with a **working personal media server** and the confidence that they helped create it, even if the AI handled most of the technical steps.

### 8. The AI stays with them after installation

**This is the heart of the vision.** Setup gets them started; the experience afterward is what makes them fall in love with homelabbing.

Imagine their chosen quirky robot greeting them the next day. The owner asks, *"What does Radarr do?"* The robot doesn't just produce a wall of text. It says, *"I'll show you."* It opens the relevant Hearth page or connected service, highlights the appropriate tab or control, explains what they're looking at, and demonstrates with their actual configuration. It can answer follow-up questions and adjust to the user's experience level.

This requires a **contextual, AI-guided interface**, not merely chat text or a static tutorial. Plan capabilities for safe in-app navigation, context-aware explanations, highlighting real controls, optional guided walkthroughs, and clear boundaries between demonstrating and changing settings. Do not fake UI awareness or claim to have opened or inspected a screen unless the corresponding tool actually succeeded. Read-only education should be easy; consequential changes still require approval.

The AI should understand the owner's homelab over time: what they've built, what they've learned, what they are proud of, which services matter to them, what broke before, and what they might want to explore next. Use appropriate consent and privacy controls for retained history. It should be able to suggest small, relevant next projects without nagging.

It might say, *"You got your movie library running. Want to see how to organize audiobooks next?"* Or, *"You've been running this for a week. Can I show you why backups matter?"* The owner should be able to say no, ask why, or go deeper.

The AI should feel like a technically competent, enthusiastic friend who **actually understands why this hobby is exciting**. Not an endlessly flattering mascot. Not an intimidating expert. Not a voice bolted onto a dashboard. A companion that can teach, investigate, diagnose, recommend, execute authorized work, verify it, and remember the journey.

### 9. Help the owner grow from curious newcomer to enthusiast

The experience should naturally evolve:

1. **Wonder:** "I can build my own streaming service?"
2. **Achievement:** "I actually have a working server."
3. **Discovery:** "What else can we build together?"
4. **Ownership:** "I understand my setup, and I have ideas of my own."

Allow the interface and explanations to grow with the user. Offer optional deeper technical details, logs, configuration views, and advanced controls. Do not permanently trap a beginner in a simplified interface. A newcomer may eventually become the power user for whom today's Hearth is already excellent.

## What this does *not* mean

- **Do not replace or diminish the experienced-homelabber experience.** They may be our largest user group, and the current management and integration work is important.
- Do not turn the AI into a gimmick. Personality and visuals support trust and engagement; technical competence earns them.
- Do not assume every computer can run every service or local voice model.
- Do not equate "AI-driven" with unbounded shell access or permission to make consequential changes.
- Do not create an elaborate questionnaire that ends in a generic recommendation or sends the owner to do all the work themselves.
- Do not assume every beginner wants automation, torrents, a VPN, remote access, or a complicated stack.
- Do not conflate **proposed**, **built**, **deployed**, **tested**, and **personally verified**.

## How this should fit the current work

Treat the existing Getting Started checklist, installer, Secure Vault, service adapters, Ember tools, voice-agent work, theme settings, and monitoring capabilities as reusable foundations. The beginner journey should **orchestrate** those capabilities in a user-friendly sequence. The existing technical checklist can operate behind the scenes as a progress tracker; it need not be the newcomer's first screen.

Review current branches, PRs, and the authoritative feature checklist before designing new work. Avoid duplicating functionality already in development. Preserve the existing "I already have a homelab" path. Make the new path additive, testable, and safe to roll out incrementally.

## What I want Claude Code to do next

**Design first. Do not immediately implement a giant new onboarding system.**

1. Read this document as a product vision, not a complaint about current development.
2. Inspect the actual repository and current development tracking. Identify existing components that can be reused and genuine gaps.
3. Propose the beginner experience end-to-end, including key screens, questionnaire logic, hardware discovery, planning, approvals, execution, verification, and post-install guided exploration.
4. Explain which steps can be delivered with current tools and which require new narrowly scoped capabilities. Never describe an unavailable capability as already working.
5. Define a staged implementation plan with dependencies, security gates, recovery behavior, acceptance tests, and measurable beginner outcomes. Keep the existing-user path intact.
6. Show a concrete walkthrough of the **4 GB laptop + external drive + 100 GB movies + no budget** scenario, including where the AI must ask permission, what it could realistically recommend, and how the user reaches their first successful playback.
7. Present the proposal for owner review before implementing, merging, deploying, creating production credentials, or changing networking.

## The reason this matters to me

A lot of people who love homelabbing know the feeling of spending days making something work, showing it to a friend, and getting a polite *"Oh, cool."* They don't see the ingenuity, the work, or the satisfaction. I want Hearth's AI to understand that excitement. I want it to be the curious, knowledgeable companion who says, *"That's awesome. Show me how you built it,"* and actually understands the answer.

But I also want someone who has **never** built anything to experience that feeling for the first time. They arrive knowing almost nothing. They choose a robot or dragon or another personality that makes them smile. They tell it what they dream of doing. It looks at the old computer they already own, builds a sensible plan, helps them get their first server running, and then opens the door to an entire hobby.

**The clean UI, the voices, the avatars, the personalization, and the guided exploration are not frivolous polish. They are what make the unfamiliar approachable and the learning enjoyable.**

I don't want to force someone to study homelabbing before they can participate. I want them to have such a good first experience that they *want* to learn more.

**Hearth should not merely make homelabbing easier. It should help people fall in love with homelabbing.**
