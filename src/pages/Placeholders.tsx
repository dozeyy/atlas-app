import { ClockCounterClockwise, Sparkle } from "@phosphor-icons/react";
import { EmptyState } from "../components/EmptyState";
import { PageTitle } from "../components/controls";

export function History() {
  return (
    <>
      <PageTitle title="History" />
      <EmptyState
        fill
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
      <PageTitle title="Wrapped" />
      <EmptyState
        fill
        icon={Sparkle}
        seed={47}
        title="Your Wrapped is still being written"
        body="Once there is a little history to look at, Atlas will turn it into a summary of what you built, when you worked and how you used Claude."
        badge="Coming soon"
      />
    </>
  );
}
