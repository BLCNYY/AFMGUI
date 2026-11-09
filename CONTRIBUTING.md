# Contributing

Thanks for wanting to help.

## Run it

```bash
npm start
```

Open http://localhost:1977, edit a file, reload. There is no build step and there are no dependencies, and it should stay that way.

## Ground rules

- **No dependencies and no build tools.** Plain HTML, CSS and ES modules in `public/`, plain Node in `server.mjs`.
- **Nothing leaves the Mac by default.** No analytics, no third-party scripts, fonts or services. Anything that talks to the internet must be off by default and explained in Settings and in the README (the Wikipedia lookup is the example).
- **Dictation uses Apple's speech recognition only.** Do not add a fallback that sends audio to another vendor.
- **Keep the security checks.** The cross-site check, the host check and the Content-Security-Policy in `server.mjs` protect people who run this on their network.
- **Only expose what `fm serve` supports.** Do not add controls for options the server ignores.
- Match the look: Apple-style, light and dark, works on a phone.

## Before you open a pull request

- `node --check server.mjs` and a check of each file in `public/js/` pass (CI runs this).
- You tried the change against a real `fm serve`, in Safari and in one other browser.
- The README is updated if behaviour changed.

## Reporting a bug

Please include your macOS version, the browser, what you did, what you expected and what happened. The output of `curl http://127.0.0.1:1976/health` helps a lot.
