<div align="center">

<img src="assets/brand/atlas-icon-1024.png" alt="Atlas" width="96" height="96">

# Atlas

**See where your Claude Code usage goes.**

<a href="https://github.com/dozeyy/atlas/releases/latest"><img src="assets/readme/download.svg" alt="Download Atlas" width="280" height="60"></a>

[Windows](https://github.com/dozeyy/atlas/releases/latest/download/Atlas-Setup-Windows-x64.exe) &nbsp;|&nbsp; [macOS](https://github.com/dozeyy/atlas/releases/latest/download/Atlas-macOS.dmg)

</div>

A desktop companion for Claude Code: a usage dashboard, a safe manager for the files in your
Claude Code setup, and a tray readout. It only reads what Claude Code already keeps on your
computer.

## Installing on a Mac

1. Open `Atlas-macOS.dmg` and drag Atlas into the Applications folder.
2. Open Atlas from Applications. The first time, the Mac stops it, because Atlas is not from
   the App Store and has no paid Apple developer ID. This happens once.

**macOS Sequoia (15) and newer**

1. When the Mac says it could not check Atlas, click **Done**.
2. Open **System Settings**, then **Privacy & Security**.
3. Scroll down to the line about Atlas being blocked and click **Open Anyway**.
4. Click **Open Anyway** again and type your Mac password. Atlas opens, and from now on it opens
   like any other app.

**macOS Sonoma (14) and older**

1. In Applications, hold **Control** and click Atlas, then pick **Open**.
2. Click **Open** in the box that appears. Atlas opens, and from now on it opens normally.
   (The Sequoia steps above also work here.)

Closing the Atlas window keeps it running in the Dock, so it can keep an eye on new chats;
**Cmd+Q** quits. Updates install from inside the app (Settings, About).

## Add the /atlas skill to Claude Code

Type `/atlas` in a chat to see your usage, or just ask "what's my usage this week". The
numbers come from the same engine as the app.

1. Add this repo as a marketplace. In Claude Code run
   `/plugin marketplace add https://github.com/dozeyy/atlas`
   (or paste that link into the plugin "Add marketplace" box in the desktop app).
2. Install the skill: `/plugin install atlas@atlas`

There is nothing else to set up. The first time you use `/atlas` it finds the `atlas-usage`
program that comes with the app, or downloads it once (after the first release) and checks it
against a checksum fixed inside the plugin.

It works in Claude Code (the terminal, the desktop app's Code tab, and the IDE extensions),
not in claude.ai web chat.

More in [skill/README.md](skill/README.md).
