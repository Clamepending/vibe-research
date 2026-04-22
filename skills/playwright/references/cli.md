# Playwright CLI Reference

Use the Vibe Research wrapper:

```bash
export PWCLI="${PWCLI:-vr-playwright}"
"$PWCLI" --help
```

Common commands:

```bash
"$PWCLI" open http://127.0.0.1:4173
"$PWCLI" snapshot
"$PWCLI" click e3
"$PWCLI" fill e5 "user@example.com"
"$PWCLI" type "search terms"
"$PWCLI" press Enter
"$PWCLI" screenshot --filename output/playwright/page.png
"$PWCLI" console error
"$PWCLI" network
"$PWCLI" tab-list
"$PWCLI" tab-new http://127.0.0.1:4173/other
"$PWCLI" tab-select 0
"$PWCLI" close
```

The wrapper accepts normal `playwright-cli` arguments and adds a short per-agent `-s=<session>` automatically when `VIBE_RESEARCH_SESSION_ID` is set.
