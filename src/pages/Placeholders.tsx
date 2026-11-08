import { ClockCounterClockwise, Sparkle, Wrench } from "@phosphor-icons/react";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/controls";

export function Setup() {
  return (
    <>
      <PageHeader
        title="Setup"
        subtitle="The agents, skills, commands and rules that shape how Claude works for you."
      />
      <EmptyState
        icon={Wrench}
        seed={23}
        title="Nothing to set up here yet"
        body="You will be able to read and edit your agents, skills, commands, output styles and rules in one place, with a safe backup before every change."
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
