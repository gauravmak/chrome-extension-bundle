# 🧰 Chrome Toolbelt

A personal Chrome extension that bundles browser utilities, focus tools, and page actions into a single popup.

## Features

### Browsing & privacy
- **Cookie Editor** — View, edit, add, delete, and export cookies for the current site, including domain / path / SameSite / secure / httpOnly fields.
- **Redirect Tracer** — See every redirect hop taken to reach the current page, with status codes, and copy the full chain.
- **Dark Mode** — Force dark mode on any site via CSS-filter inversion — per-site or global, with brightness control. Images and video are re-inverted so they look normal.
- **GDPR Cookie Dismisser** — Auto-hides and auto-clicks cookie-consent banners (OneTrust, CookieBot, Didomi, Quantcast, and more).
- **JS Toggle** — Disable or enable JavaScript for the current site with one click; the page reloads automatically.
- **JSON Formatter** — Detects pure-JSON pages and pretty-prints them with syntax highlighting and collapsible sections.

### Focus
- **Focus Mode** — Hide the feed and/or sidebar on YouTube, X/Twitter, LinkedIn, Facebook, and Reddit, plus LinkedIn's red new-posts dot on the Home icon. Search, profiles, and direct links keep working.
- **Bounce to Reading Material** — When enabled, opening YouTube's home page, the LinkedIn feed, or your own LinkedIn profile redirects you to the oldest bookmark in your "Reading Material" folder, with an on-page notice that the redirect happened.

### Page tools
- **Reading Material** — Save the current page to a "Reading Material" bookmark folder. The Quick tab previews the oldest saved article and lets you open or delete it (with undo).
- **Copy as Markdown** — Copy the current article (or your selection) as clean Markdown.
- **Live CSS Editor** — Write custom CSS for any site, applied live as you type and saved per-domain.
- **Pick Color** — An eyedropper that copies the picked color's hex code to your clipboard.
- **Fill Form** — Fill forms with fake test data, with a preview of every field before applying.
- **Picture-in-Picture** — Pop the largest video on the page into a floating window.
- **New Calendar Event** — Open a prefilled Google Calendar event editor from the current page or selection.
- **Move a Day's Events** — Move a day's calendar events to another day — one-click *Today → Tomorrow* and *Yesterday → Today*, or any date → date — keeping their wall-clock time. Preview first, tick what moves, confirm twice, undo afterwards. Only touches events where you are the sole participant, so it never mails anyone. Needs one-time setup — see below.
- **Localhost Jumper** — A searchable list of recently visited localhost ports and paths from your history.

### Google Search
- **Google Maps Links** — Re-adds clickable Maps links and map preview cards to Google Search results.
- **View Image** — Adds a "View Image" button to Google Images that links to the full-size original.

### Utility
- **Settings Backup** — Export all extension settings to a JSON file and import them back later (merge — never wipes existing keys).
- **Teams Session Log** — Observes Microsoft Teams / login HTTP failures (status codes and URLs only — never token values) into a ring buffer you can export or clear, to catch session expiry early.

## Install

1. Download or clone this repo.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked**.
5. Select this folder.
6. The 🧰 icon appears in your toolbar — you're done.

> Adding new permissions later? Reload the extension at `chrome://extensions` and reopen the popup so it picks up fresh `chrome` API references.

## Calendar reschedule setup

The **📅 Calendar** tab (under *More…*) talks to the Google Calendar API, which needs
an OAuth client of your own. One-time, about ten minutes. Everything happens on the
Cloud Console's **Google Auth Platform** pages; the *Create credentials* wizard under
APIs & Services → *Credentials* is an older route to the same client and isn't needed.

1. Load the extension (see **Install** above) and copy its ID from
   `chrome://extensions` — a 32-letter string under the extension's name.
2. Go to [Google Cloud Console](https://console.cloud.google.com/) → create or pick a
   project → **APIs & Services** → **Library** → search *Google Calendar API* →
   **Enable**.
3. Open **Google Auth Platform** (APIs & Services → *OAuth consent screen* lands there)
   → **Get started**, and fill in its four steps:
   - **App information** — any app name; your email as the support email.
   - **Audience** — **External**. *Internal* is only for Google Workspace
     organisations.
   - **Contact information** — your email.
   - **Finish** — agree to the User Data Policy → **Continue** → **Create**.
4. Sidebar → **Audience**. Leave *Publishing status* on **Testing** and never click
   *Publish app* — personal use needs no verification. Under **Test users** →
   **+ Add users**, add the Google account Chrome is signed into (see *Which account*
   below).
5. Sidebar → **Clients** → **+ Create client** → Application type
   **Chrome Extension**, any name, **Item ID** = the extension ID from step 1 →
   **Create**. Skip *Verify app ownership* if it's offered; that's for Chrome Web
   Store listings. Copy the client ID from the dialog.
6. Paste it into `manifest.json` as `oauth2.client_id`:

   ```json
   "oauth2": {
     "client_id": "123456789-abcdef.apps.googleusercontent.com",
     "scopes": ["https://www.googleapis.com/auth/calendar.events"]
   }
   ```

7. Reload the extension at `chrome://extensions`, then **close and reopen the popup**
   so it picks up `chrome.identity`. The first **Preview** opens Google's consent
   screen. Its *Google hasn't verified this app* warning is expected in Testing mode;
   click **Continue**.

*Branding*, *Data Access* and *Verification Center* need nothing further — the
extension asks for the Calendar scope itself at sign-in.

**Which account.** `chrome.identity` signs in as the account Chrome itself is signed
into (or, if none, the first Google account logged in on the web in that profile) —
not whichever account has Calendar open. That account's calendar is the one that
moves, and it must be a test user (step 4). Google Chrome only: Chromium builds can't
sign in to Google, so they never get a token.

The extension ID is derived from this folder's path, so moving the folder changes the
ID and breaks the OAuth client — create a client for the new ID (steps 1, 5 and 6) if
you relocate it.

### If Preview fails

| Popup says | Fix |
|---|---|
| *no OAuth client configured* | `manifest.json` has no `oauth2.client_id`, or still the `REPLACE_ME` placeholder — step 6 |
| *Identity permission missing* | Reload at `chrome://extensions`, then close and reopen the popup |
| *OAuth2 request failed: … bad client id* | The client's Item ID doesn't match the extension ID — steps 1 and 5 |
| *The user did not approve access* | The consent window was closed or declined. If it said *Access blocked: … has not completed the Google verification process*, the account isn't a test user — step 4 |
| *Calendar API 403: Google Calendar API has not been used in project …* | API not enabled, or enabled only minutes ago (wait and retry) — step 2 |

### What it will and won't move

Pick **Today → Tomorrow** or **Yesterday → Today**, or set any *from* and *to* date and
hit **Preview**. The shortcuts count days in your calendar's own timezone, and fill in
the date pickers so you can adjust them into a custom range.

Moves the whole *from* day (past events included) to the *to* day at the **same
wall-clock time** — 10:00 on the 25th becomes 10:00 on the 26th even across a
daylight-saving change. Moving backwards (e.g. tomorrow → today) works the same way.

Left alone, and listed as such in the preview:

| Not moved | Why |
|---|---|
| Anything with another guest | Rescheduling mails every attendee |
| Anything with a room booked | A shared resource is outward-facing too |
| Events you don't organise | Not yours to edit |
| Birthdays, Gmail events, working location | Google owns these; the API rejects the edit |
| Cancelled events | Nothing to move |

Events that would land on top of something already on the *to* day are flagged in the
preview but still moved — untick them if you'd rather they stayed.

Recurring events move the **single instance** on the *from* day, not the series.

Every run is undoable until the next one. Undo checks each event is still where the
extension put it and skips anything you've since moved yourself.

## Credits

Original idea and initial implementation by [@levelsio](https://x.com/levelsio), released as [SuperLevels](https://github.com/levelsio/superlevels) (MIT). This is a personal fork — extended and customized for my own use, with thanks to the original author for the concept and groundwork.
