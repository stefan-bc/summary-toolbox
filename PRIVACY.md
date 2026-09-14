# Summary Toolbox — Privacy Policy

_Last updated: 2026-05-06_

Summary Toolbox is a Chrome extension that extracts YouTube transcripts and, optionally, summarises the active web page through an AI provider you supply your own API key for. This document explains exactly what data the extension touches and where it goes.

## What stays on your device

- **Transcripts and page text.** Read directly from the active tab via `chrome.scripting`. Never written to any server we control.
- **Preferences and credentials.** UI toggles, the configured AI provider, model name, API key, Obsidian vault settings, and Notion integration token are stored in `chrome.storage.local`. Local-device only — not synced across browsers, not transmitted anywhere by Summary Toolbox.
- **Per-URL summary cache.** The most recent 20 summaries are kept locally so you can reopen the popup on a previously-summarised page and see the result without re-running the AI call. Eviction is by recency.

No analytics, no telemetry, no third-party SDKs, no remote code.

## What leaves your device, and only when

Summary Toolbox only makes network requests on **your action** — a button click, or opening the popup with an opt-in setting you switched on yourself. Three narrow cases are documented at the end of this section.

| Action | Endpoint | Sent | Trigger |
|---|---|---|---|
| Summarise (DeepSeek) | `api.deepseek.com` | Transcript or page text + your prompt | You click Summarise, or open the popup with **Auto** on |
| Summarise (OpenAI) | `api.openai.com` | Transcript or page text + your prompt | You click Summarise, or open the popup with **Auto** on |
| Summarise (Anthropic) | `api.anthropic.com` | Transcript or page text + your prompt | You click Summarise, or open the popup with **Auto** on |
| Summarise (Mistral) | `api.mistral.ai` | Transcript or page text + your prompt | You click Summarise, or open the popup with **Auto** on |
| Summarise (Custom endpoint) | The host you entered as Base URL | Transcript or page text + your prompt | You click Summarise, or open the popup with **Auto** on |
| Load model list (↻) | Your configured provider's host | Your API key (as auth) | You click ↻ in Settings |
| Summarise (OpenRouter) | `openrouter.ai` | Transcript or page text + your prompt | You click Summarise, or open the popup with **Auto** on |
| Summarise (Groq) | `api.groq.com` | Transcript or page text + your prompt | You click Summarise, or open the popup with **Auto** on |
| Summarise (Gemini) | `generativelanguage.googleapis.com` | Transcript or page text + your prompt | You click Summarise, or open the popup with **Auto** on |
| Save to Notion | `api.notion.com` | The summary text + the source URL | You click Save to Notion |
| Save to Obsidian | _Local `obsidian://` URL scheme_ | Summary text | You click Save to Obsidian — never hits the network |

Only one provider host is contacted per Summarise — whichever you configured.

### Auto-summarise (opt-in, off by default)

The **Auto** tick beside the status line makes the popup run Summarise as soon as it opens, instead of waiting for a click. It is off unless you switch it on, it does nothing unless you have set an API key, and it is skipped when a cached summary for that page is already on screen — so it sends at most one request per new page, to the same provider host as a manual Summarise. Untick it and no request is ever sent without a click.

### YouTube caption fetch

When the popup opens on a YouTube watch page, the extension fetches the caption track URL from `youtube.com` (same-origin to the active tab). This is required to extract the transcript and is the same request the YouTube player itself makes.

### DeepSeek balance pill

If — and only if — your configured provider is DeepSeek and you have set an API key, the popup makes one `GET https://api.deepseek.com/user/balance` call when it opens, so it can show your remaining credit. The result is cached locally for 60 seconds. Other providers don't expose a comparable endpoint and trigger no automatic call.

## What we never do

- Summary Toolbox does not collect, log, or transmit any personally identifiable information.
- Summary Toolbox does not sell or share data with third parties.
- Summary Toolbox does not run any background scripts or service workers.
- Summary Toolbox does not include or load any remote code.
- Summary Toolbox does not use or transmit data for advertising or creditworthiness purposes.

## Default privacy posture

If you don't configure any AI provider and don't enter any keys, Summary Toolbox makes **zero** outbound network requests beyond reading the active tab's own data. Transcript extraction, search, copy, and TXT/SRT download all run entirely on your device.

## Permissions justification

| Permission | Why it's needed |
|---|---|
| `activeTab` | Read the active tab (YouTube transcript or page text) when you click the toolbar icon. |
| `scripting` | Inject the transcript scraper, the video-seek function, and (in page mode) the one-shot page-text reader into the active tab. |
| `storage` | Persist UI toggle preferences and your API credentials locally. |
| Host permissions for the seven AI providers + `api.notion.com` | Send the transcript / page text / summary to whichever provider or save target you have configured, only when you click the relevant button — or, for Summarise alone, when the popup opens with the opt-in **Auto** tick switched on. |
| Optional host permissions (`http://*/*`, `https://*/*`) | Requested at runtime for the single host you enter as a Custom endpoint base URL, when you click ↻. Nothing is granted until you approve Chrome's prompt, and only that host is granted. |

## Contact

Bug reports or privacy questions: <stefanbc9@gmail.com>
