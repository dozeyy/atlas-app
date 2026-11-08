import { ChatsCircle, ClockCounterClockwise, Sparkle } from "@phosphor-icons/react";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/controls";

export function Sessions() {
  return (
    <>
      <PageHeader
        title="Sessions"
        subtitle="Every Claude Code conversation on this computer, in one list."
      />
      <EmptyState
        icon={ChatsCircle}
        seed={11}
        title="No sessions to show yet"
        body="Each conversation will appear here with what it cost, how long it ran and which project it belonged to. You will be able to search them and open any one."
        badge="Coming soon"
      />
    </>
  );
}

export function History() {
  return (
    <>
      <PageHeader
        title="History"
        subtitle="A record of every change Atlas makes to your Claude setup."
      />
      <EmptyState
        icon={ClockCounterClockwise}
        seed={31}
        title="No changes yet"
        body="When Atlas edits a file for you, the old version is kept here. Anything can be put back with one click."
        badge="Coming soon"
      />
    </>
  );
}

export function Wrapped() {
  return (
    <>
      <PageHeader
        title="Wrapped"
        subtitle="Your Claude Code year, as a page you can keep or share."
      />
      <EmptyState
        icon={Sparkle}
        seed={47}
        title="Your Wrapped is still being written"
        body="Once there is a little history to look at, Atlas will turn it into a summary of what you built, when you worked and how you used Claude."
        badge="Coming soon"
      />
    </>
  );
}
