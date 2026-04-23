# Visual OS Foundation

Vibe Research is growing toward a visual operating system for agents: nontechnical people should be able to understand agent work through visible objects instead of terminal-only transcripts.

The foundation is not the town art by itself. The foundation is the contract between the visual interface, the local control plane, and the agents.

## Core Objects

| Object | User meaning | System anchor |
| --- | --- | --- |
| Agent | A visible worker with status, identity, transcript, and current work. | Session records, subagent records, provider state |
| Building | An installed app or integration home. | Building manifest plus setup state and optional helper service |
| ActionItem | A bite-sized thing needing human attention. | Agent Town state, Agent Inbox card, optional predicate |
| Approval | A blocking ActionItem for sensitive work. | ActionItem with `kind: "approval"` and capability metadata |
| AgentCanvas | The current visual artifact an agent wants the human to inspect. | Agent Town canvas record keyed by `sourceSessionId`/`sourceAgentId` plus served image path |
| Automation | A recurring helper or scheduled background job. | Automation settings and the Automations building |
| LibraryNote | Durable shared memory for agents and humans. | Markdown files in the Library |
| LocalApp | A web app or preview server started by a session. | Port discovery, proxy, Tailscale Serve metadata |
| FileArtifact | A created or edited file the user may inspect. | Workspace file browser and session output |
| CredentialStatus | Whether an integration is connected without exposing secrets. | Redacted settings, building setup variables |
| Workspace | A project desktop containing agents, files, Library context, and local apps. | Configured workspace root and spawn folder |

## Agent Town State Contract

`src/agent-town-store.js` is the bridge between browser UI and agent behavior. Agents should use it when they need to coordinate with a human through the visual interface.

Action items are intentionally small:

```json
{
  "id": "approve-outbound-message",
  "kind": "approval",
  "priority": "high",
  "title": "Approve outbound message",
  "detail": "Review the draft before the agent sends it.",
  "href": "?view=agent-inbox",
  "cta": "Review",
  "source": "telegram",
  "sourceSessionId": "session-id",
  "target": {
    "type": "library_note",
    "id": "comms/drafts/message.md",
    "label": "Draft message"
  },
  "capabilityIds": ["sends-messages"],
  "predicate": "action_item_completed",
  "predicateParams": {
    "actionItemId": "approve-outbound-message"
  }
}
```

Agent canvases are intentionally current, not archival. Agents should keep their result docs and Library notes as the durable record, then point the canvas at the most useful visual artifact right now:

```sh
vr-agent-canvas --image results/chart.png --title "Latest graph" --caption "Best qualitative result so far."
vr-agent-canvas --url https://example.com/image.png --title "Reference image"
```

Researchers should prefer the most significant qualitative result so far: the graph, sample, screenshot, or other image that best helps the human understand the run without opening the full transcript. Engineers should use the canvas when a screenshot or visual regression result is the clearest status signal.
Direct user requests to see a picture, screenshot, mockup, graph, or generated sample should also route through the canvas when a suitable image can be created, fetched, screenshotted, or linked.

Supported action item kinds:

- `action`: ordinary next step
- `approval`: human consent for sensitive work
- `review`: inspect completed work or a decision
- `setup`: connect or configure a building/workspace

Supported priorities:

- `low`
- `normal`
- `high`
- `urgent`

Supported target object types:

- `agent`
- `approval`
- `automation`
- `building`
- `file`
- `library_note`
- `local_app`
- `session`
- `settings`
- `task`
- `workspace`

## Capability Tags

Capability tags should be short slugs that describe what kind of power an action needs. They are not yet a full enforcement layer, but naming them early keeps the UI, buildings, approvals, and agent prompts aligned.

Recommended starting tags:

- `runs-shell`
- `reads-files`
- `writes-files`
- `uses-browser`
- `uses-camera`
- `uses-credentials`
- `uses-calendar`
- `sends-messages`
- `spends-money`
- `publishes-code`
- `publishes-social`
- `controls-devices`
- `ui-guidance`

## Building Contract

Buildings are the app model. A first-class building should define:

- stable `id`, name, category, description, and visual shape
- install/setup state
- redacted credential status
- human onboarding steps
- generated `agentGuide`
- relevant capability tags in guide text or action items
- a clear boundary between manifest-only community data and trusted first-party executable code

Community BuildingHub entries stay manifest-only unless they are reviewed into first-party code.

## Product Rules

- The town is the desktop. Agent Inbox is the taskbar/notification center. Buildings are apps. Library is memory.
- Every visible object should map to a durable system concept.
- Agents should create one small ActionItem at a time instead of giving users long checklists.
- Agents should use Vibe Research-provided endpoints, env vars, and helper commands as the source of truth for app coordination before scraping UI, writing ad hoc state files, or asking the human to report state manually.
- Agents should publish the visual artifact they most want the user to inspect to their agent canvas, including direct "show me a picture" requests when a suitable image can be created, fetched, screenshotted, or linked.
- Agents should wait on predicates when the UI can prove completion.
- Sensitive work should become an Approval before it continues.
- Terminals remain available, but nontechnical flows should prefer cards, panels, approvals, files, and artifacts.

## Near-Term Sequence

1. Keep hardening Agent Town state as the UI coordination API.
2. Make Agent Inbox the universal attention surface for actions, approvals, and reviews.
3. Add building-level capability and permission language without exposing secrets.
4. Attach generated artifacts to visible tasks and Library notes.
5. Add stronger auth and permission enforcement before encouraging public exposure.
