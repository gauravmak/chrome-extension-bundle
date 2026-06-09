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
- **Focus Mode** — Hide the feed and/or sidebar on YouTube, X/Twitter, LinkedIn, Facebook, and Reddit. Search, profiles, and direct links keep working.
- **Bounce to Reading Material** — When enabled, opening YouTube's home page, the LinkedIn feed, or your own LinkedIn profile redirects you to the oldest bookmark in your "Reading Material" folder, with an on-page notice that the redirect happened.

### Page tools
- **Reading Material** — Save the current page to a "Reading Material" bookmark folder. The Quick tab previews the oldest saved article and lets you open or delete it (with undo).
- **Copy as Markdown** — Copy the current article (or your selection) as clean Markdown.
- **Live CSS Editor** — Write custom CSS for any site, applied live as you type and saved per-domain.
- **Pick Color** — An eyedropper that copies the picked color's hex code to your clipboard.
- **Fill Form** — Fill forms with fake test data, with a preview of every field before applying.
- **Picture-in-Picture** — Pop the largest video on the page into a floating window.
- **New Calendar Event** — Open a prefilled Google Calendar event editor from the current page or selection.
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
