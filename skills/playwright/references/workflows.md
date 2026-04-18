# Playwright CLI Workflows

## Inspect A Local App

```bash
export PWCLI="${PWCLI:-rv-playwright}"
"$PWCLI" open http://127.0.0.1:4173
"$PWCLI" snapshot
```

Use the element refs from the snapshot for clicks, fills, and typing.

## Capture A Repro Screenshot

```bash
mkdir -p output/playwright
"$PWCLI" screenshot --filename output/playwright/current.png
```

## Exercise A UI Flow

```bash
"$PWCLI" open http://127.0.0.1:4173
"$PWCLI" snapshot
"$PWCLI" fill e1 "a prompt"
"$PWCLI" click e2
"$PWCLI" snapshot
"$PWCLI" screenshot --filename output/playwright/result.png
```

## Recover From Stale Refs

If `click e12` or `fill e7` fails because the ref no longer exists, run:

```bash
"$PWCLI" snapshot
```

Then retry with refs from the new snapshot.
