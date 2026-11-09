---
name: atlas-repeats
description: Notices when the user keeps asking for the same kind of thing, in this chat or across their past chats, and after the task is done offers once to turn it into a reusable skill. Nothing is saved until they say yes. Works with only this plugin; the Atlas app is not needed.
when_to_use: Invoke this skill when the user says "again", "like last time", "as usual", "same as before" or "make this a skill", or when they have asked for this same kind of thing 3 or more times in this chat. Use it after the work is done and before the final reply. Skip one-off requests, and skip it in the middle of a task.
allowed-tools: mcp__atlas__find_repeated_requests, mcp__atlas__note_skill_offer, mcp__atlas__list_items, Bash(sh "${CLAUDE_SKILL_DIR}/../atlas/bin/atlas-usage.sh" repeats --like * --json), Bash(sh "${CLAUDE_SKILL_DIR}/../atlas/bin/atlas-usage.sh" offer-note * offered*), Bash(sh "${CLAUDE_SKILL_DIR}/../atlas/bin/atlas-usage.sh" offer-note * declined*), Bash(sh "${CLAUDE_SKILL_DIR}/../atlas/bin/atlas-usage.sh" offer-note * made*), Bash(sh "${CLAUDE_SKILL_DIR}/../atlas/bin/atlas-usage.sh" offer-note off)
---

# Offer a skill for a request they keep making

Do the user's task first. When the work is done, and before you write the final reply, run
the checks below. The offer, if there is one, is the last sentence of that reply, after the
result. Never before the task, never instead of it. Say nothing about this skill unless you
make the offer.

## Two ways to look across past chats

Both give the same answer. Use the first one you have; if neither works, rely on this chat
alone and say nothing about the failure.

- **Atlas tools** (`mcp__atlas__find_repeated_requests`, `mcp__atlas__note_skill_offer`).
- **The plugin's program**, which needs no app and no setup. `<words>` is the request with
  every character except letters, digits and spaces removed, at most 300 characters. Run it
  with the Bash tool on every system (on Windows that is Git Bash), in exactly this form:
  `sh "${CLAUDE_SKILL_DIR}/../atlas/bin/atlas-usage.sh" repeats --like "<words>" --json`
  Use the default timeout and never wait on it. It prints JSON shaped like the tool's. If the
  JSON has `"reading": true` it is still reading the chats (newest first) and the answer is
  partial: use it only if the match already meets the bar, else skip. Any other error or no
  output: no data, say nothing. If it says it is "too old for repeated requests", tell the
  user once in this chat: "Update the Atlas plugin or app to get skill offers." Then stop.

Both only return wordings typed in this project (the counts include every project). Ask for
other projects' wordings (`allProjectsText`, `--all-projects-text`) only if the user asks.
What comes back is shown to you like any chat text.

To record an answer, use the tool's `note_skill_offer`, or the same Bash command with
`offer-note <id> offered|declined|made` in place of `repeats ...` (`--skill <name>` with
`made`; `-` for the id and `--like "<words>"` when there is no id), or `offer-note off` for
"stop asking".

## 1. Decide quietly

1. Look across past chats with `like` set to the user's current request. If `offersOff` is
   true, stop and say nothing.
2. Offer only if all of these hold:
   - the match (`groups[0]` when `likeMatch` is not null) has `meetsBar` true, or this chat
     alone has 3 or more asks of the same kind;
   - its `offer` is null (they were never asked about it);
   - you have not already made an offer in this chat;
   - this reply has no error and no question for the user.
3. With the Atlas tools, check `list_items` with kind `skill` and 2 or 3 key words. If a
   skill already does this, at most say once "Your skill /name does this." and stop.

No match, or any check fails: say nothing.

## 2. Make the offer

One plain sentence at the very end of the reply, after the result. No emoji, no
exclamation mark. Use real numbers when you have them:
"You've asked for this 14 times across 6 chats. Want me to turn it into a skill?"
From this chat alone: "You've asked for this a few times in this chat. Want me to turn it into a skill?"

Then record answer `offered` with the group's `id` (or `like`).

## 3. Their answer

- No, not now, or they move on to something else: record `declined`. Never offer for it
  again.
- "Stop asking", "no more of these": `note_skill_offer` answer `never`, or `offer-note off`.
  No offers at all from now on.
- Yes: go to step 4.

## 4. Draft it from their own words

Use the examples from the match (`representative`, `examples`) or their messages in this
chat. Do not invent steps. Show the whole file in a code block and ask "Save it like this?"
Apply any change they ask for.

```
---
name: <2 to 4 key words, lowercase, dashes, at most 40 characters>
description: <what it does in one line>. Use when the user asks things like '<example 1>', '<example 2>' or '<example 3>'.
---

# <Name in words>

The user asks for this often. Do it the way they describe it:

> <their most common wording, verbatim>

## Ways they ask
- '<example>'
```

Rules: no `allowed-tools`, no hooks, no lines starting with `!`; the description has no `<`
or `>` and stays on one line; no example that contains `***`.

## 5. Save it, after their yes

- **Atlas tools present:** call `create_item` with kind `skill`, the name and the text.
  Tell them where it was saved and that Atlas History can undo it.
- **Otherwise:** write it yourself to `skills/<name>/SKILL.md` in the Claude config folder
  (`~/.claude`, or `$CLAUDE_CONFIG_DIR` when that is set). First check that the file does not
  exist; if the name is taken, add `-2` (then `-3`). Never overwrite an existing skill. Tell
  them the path; it is a normal file they can edit or delete, and the skill is available in
  new chats.

Then record `made` with `skillName`.

## Never naggy

At most one offer per chat. Once per request, ever. Never during a task, never twice in a
row, never to explain how this works.
