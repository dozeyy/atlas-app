# Library fixtures

Made by `python tools/make-library-fixtures.py`; the tests read them, nothing downloads.

- `catalog-available.json.gz`: the plugin directory as Claude Code's `plugin list --available --json`
  printed it (3,602 directory entries) plus one local-source entry from an added marketplace
  (`impeccable@impeccable`), 3,603 in all. Search ranking and the 16 ms bench run over it.
- `fixture-*.tar.gz`: small GitHub-style repo archives for the shape finder and the safety check:
  `bare-skills`, `loose-skills`, `hookify-like` (hooks only: "Not installed"), `http-mcp`,
  `marketplace-demo` (a marketplace with plugins), `plugin-json-only`, `nothing`.
