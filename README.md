# Atlas

A desktop companion for Claude Code: a usage dashboard, a safe manager for the files in your
Claude Code setup, and a tray readout. It only reads what Claude Code already keeps on your
computer.

## Atlas for Claude Code

See your usage right in a Claude Code chat: type `/atlas`, or ask "what's my usage this
week". The numbers come from the same engine as the app.

1. **Get Atlas.** Download `Atlas-Setup-<version>.exe` from the
   [Releases page](https://github.com/dozeyy/atlas/releases) and run it (Windows).
2. **Add the skill.** In Claude Code, run:

   ```
   /plugin marketplace add dozeyy/atlas
   /plugin install atlas@atlas
   ```

That is all. The first time you use `/atlas`, it finds the `atlas-usage` program that comes
with the app, or downloads it once and checks it against the published checksum. Nothing
else to set up. More in [skill/README.md](skill/README.md).