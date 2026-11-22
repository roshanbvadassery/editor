# Shipping a fork change to Zopu

Zopu never uses Pascal's npm packages. Studio (`zopu-wide/studio`) and the Studio MCP
(`zopu-studio-mcp`) install this fork from pinned GitHub releases
(`roshanbvadassery/editor`, tags `zopu-<version>`). Both always run the **same** release.

All repos are sibling checkouts under `Main/`: `editor` (this fork), `lingo` (fork), `zopu-wide`,
`zopu-studio-mcp`.

## While developing

```sh
# in Main/editor: build the packages Studio reads from dist
bunx turbo run build --filter=@pascal-app/core --filter=@pascal-app/viewer --filter=@pascal-app/nodes
# in Main/zopu-wide/studio: use the fork instead of the release
npm run fork:link        # npm run fork:status shows what is linked
```

The editor package ships its TypeScript source, so editor-only changes need no build. Rebuild after
`viewer`/`core`/`nodes` changes.

## Shipping (one command)

1. Commit the change in `Main/editor` (and `Main/lingo` if you touched it). Hooks run lint and
   typecheck. Run the tests for what you changed (`bun test <path>`).
2. From `Main/editor`:

   ```sh
   node scripts/zopu-ship.mjs --next --dry-run   # see the plan
   node scripts/zopu-ship.mjs --next             # do it
   ```

   This:
   - checks that both forks are committed, `gh` is signed in, and the consumers' package files
     are clean;
   - pushes this fork's branch and publishes the release (`scripts/zopu-release.mjs --publish`:
     tarballs of core, viewer, nodes, editor, geometry-script, ifc-converter, mcp, lingo, and the
     patched three / three-bvh-csg);
   - in each consumer:
     - points every release URL at the new tag;
     - removes any fork links;
     - runs `npm install`, then `npm ci`;
     - runs the build (Studio) or an import check (Studio MCP);
     - commits `package.json` and `package-lock.json` locally.

   `--tag zopu-1.2.0.0` picks a tag yourself. `--no-commit` leaves the consumer changes
   uncommitted. Re-running after a failure is safe: an existing release is reused.
3. **Deploy is separate and manual.** The script never pushes a consumer. Push or merge
   `zopu-wide` (production builds from `master` on Railway) and `zopu-studio-mcp` when you want
   them live.

## By hand (what the script does)

```sh
cd Main/editor && git push origin main
node scripts/zopu-release.mjs --tag zopu-X --publish     # without --publish: build only, into .zopu-release/<tag>/
# in each consumer: replace releases/download/zopu-OLD/ with zopu-X in package.json (dependencies AND overrides)
npm install && npm ci && npm run build                   # Studio; the MCP has no build
git add package.json package-lock.json && git commit -m "Pascal fork release zopu-X"
```

Gotcha: `npm run fork:unlink` runs `npm ci`. It fails while `package.json` points at a release the
lockfile doesn't know yet. Run `npm install` first (the ship script does).
