# Scaffold Recipes

Scaffold recipes are shareable Vibe Research setup snapshots. They let agents and humans reproduce a useful operating shape without switching into a special benchmark mode: the normal system exports its current policy, layout, and setup metadata, and another normal system previews or applies it.

## What A Recipe Captures

- recipe schema and Vibe Research compatibility metadata
- core and BuildingHub buildings, including enabled/required state and portable building settings
- Agent Town layout: cosmetic pieces, functional building placements, theme, and pending functional buildings
- agent communication policy: DM enabled state, body format, visibility, group inboxes, logging, and throttles
- provider and occupation metadata, including the active occupation id and prompt hash
- sandbox assumptions such as local vs Harbor-style execution, network policy, and GPU expectation
- Library and workspace binding requirements
- redactions explaining configured secrets, personal values, and local paths that were intentionally omitted

## What A Recipe Does Not Carry

- raw API keys, tokens, cookies, private keys, passwords, or credential material
- personal account identifiers such as AgentMail inbox ids or git remotes as portable values
- machine-local paths or local service URLs as portable values
- hidden benchmark behavior or alternate agent policy

These values appear as `localBindingsRequired` entries. Applying a recipe only writes local/personal/secret values when the caller explicitly supplies bindings.

## API

- `GET /api/scaffold-recipes/current` exports the current setup and returns a preview.
- `POST /api/scaffold-recipes/current` saves the current setup into the local recipe store.
- `GET /api/scaffold-recipes` lists saved recipes.
- `GET /api/scaffold-recipes/:recipeId` reads one saved recipe.
- `POST /api/scaffold-recipes/preview` previews a provided recipe with optional local bindings.
- `POST /api/scaffold-recipes/apply` applies a provided recipe.
- `POST /api/scaffold-recipes/:recipeId/apply` applies a saved recipe.
- `POST /api/scaffold-recipes/:recipeId/publish` writes a recipe into the configured local BuildingHub checkout under `recipes/<id>/`.

## Agent CLI

Agents receive `VIBE_RESEARCH_SCAFFOLD_RECIPES_API`, `VIBE_RESEARCH_SCAFFOLD_RECIPE_COMMAND`, and the `vr-scaffold-recipe` helper.

```bash
vr-scaffold-recipe export --pretty
vr-scaffold-recipe save-current --id posttrainbench-harbor
vr-scaffold-recipe preview recipe.json --pretty
vr-scaffold-recipe apply recipe.json --binding workspaceRootPath="$PWD"
vr-scaffold-recipe publish posttrainbench-harbor
```

Use preview before apply. Treat bindings as local setup inputs, not as content to publish or store in the Library.

## BuildingHub Layout

Local BuildingHub checkouts can include:

```text
recipes/<slug>/recipe.json
recipes/<slug>/README.md
site/recipes/<slug>/index.html
```

`src/buildinghub-service.js` loads recipes from folder manifests and from top-level catalog arrays named `recipes`, `scaffolds`, `registry.recipes`, or `registry.scaffolds`. `src/buildinghub-scaffold-publisher.js` writes the local recipe manifest, README, static share page, commits it, and pushes the BuildingHub branch when the checkout has a remote.

## Policy

Recipes are evaluation and sharing artifacts, not alternate runtime modes. A PostTrainBench run, a Library/occupation experiment, or a Harbor-backed sandbox comparison should use the same live Vibe Research behavior that normal work uses. The recipe only makes the scaffold explicit enough to reproduce, compare, and improve on policy.
