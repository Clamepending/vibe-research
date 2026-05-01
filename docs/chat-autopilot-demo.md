# Chat Autopilot Demo

This is the teammate handoff path for the project-scoped research supervisor.

## Happy Path

1. Start the app and open a normal agent chat.
2. Use a chat whose folder or title matches a Library project, or pick the project from the chat Autopilot strip.
3. Click the Autopilot toggle.
4. Confirm the strip changes to `Autopilot driving` and shows `Project supervisor`.
5. If the agent is idle, the supervisor should immediately send a normal research directive into the same chat.
6. Click `Continue`, `Plan next`, or `Summarize` to manually steer through the same hidden supervisor.
7. Click `Pause` to return to manual mode. The chat context stays intact.

## What To Point Out

- The chat remains the cockpit.
- The session agent does not receive toggle-on or toggle-off messages.
- The project supervisor is shared across chats for the same project, so duplicate takeover directives are deduped.
- The project supervisor can be inspected at `GET /api/research/projects/<project>/supervisor`.

## Quick API Smoke

```sh
curl "$BASE/api/research/projects/<project>/supervisor"
```

Expected shape:

```json
{
  "ok": true,
  "projectName": "<project>",
  "supervisor": {
    "enabled": true,
    "sessionIds": ["..."],
    "supervisor": {
      "interventionCount": 1,
      "lastObservedEvent": "takeover"
    }
  }
}
```

## Known Boundary

The current demo path is event-driven from the chat UI. The next hardening step is a server-side unattended wakeup loop so the project supervisor can keep ticking even when no browser tab is actively open.
