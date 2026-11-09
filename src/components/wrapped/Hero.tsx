import type { Slide } from "../../lib/wrappedModel";
import type { HeroBox } from "../../lib/posterMath";
import {
  BiggestHero,
  DaysHero,
  FirstHero,
  LongHero,
  NovelsHero,
  ProjectHero,
  TokensHero,
} from "./heroesA";
import {
  BusiestHero,
  CoverHero,
  CrowdHero,
  HelperHero,
  ModelsHero,
  RhythmHero,
  SkillHero,
  ToolHero,
  TypeHero,
  WeekdayHero,
} from "./heroesB";

/** The one graphic a slide's chart asks for, drawn into the hero box. No chart, no hero. */
export function Hero({ slide, box }: { slide: Slide; box: HeroBox }) {
  const c = slide.chart;
  if (!c) return null;
  switch (c.kind) {
    case "ridge":
      return <TokensHero chart={c} box={box} />;
    case "spines":
      return <NovelsHero chart={c} box={box} />;
    case "trail":
      return <FirstHero chart={c} box={box} />;
    case "heat":
      return <DaysHero chart={c} box={box} />;
    case "tower":
      return <BiggestHero chart={c} box={box} />;
    case "dial":
      return <LongHero chart={c} box={box} />;
    case "tiles":
      return <ProjectHero rows={c.rows} box={box} />;
    case "podium":
      return <SkillHero rows={c.rows} box={box} />;
    case "lollipop":
      return <HelperHero rows={c.rows} box={box} />;
    case "burst":
      return <CrowdHero chart={c} box={box} />;
    case "terminal":
      return <ToolHero rows={c.rows} box={box} />;
    case "spike":
      return <BusiestHero chart={c} box={box} />;
    case "spokes":
      return <WeekdayHero chart={c} box={box} />;
    case "strip":
      return <RhythmHero chart={c} box={box} />;
    case "donut":
      return <ModelsHero rows={c.rows} box={box} />;
    case "badge":
      return <TypeHero chart={c} box={box} />;
    case "cover":
      return <CoverHero box={box} />;
  }
}
