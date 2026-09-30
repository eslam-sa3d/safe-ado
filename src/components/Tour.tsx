import { useEffect, useState } from "react";
import { getUserValue, setUserValue } from "../api/data";
import { Icon } from "./common";

export const TOURS_KEY = "toursSeen";

export interface TourStep {
  title: string;
  text: string;
}

/** First-time coach marks, 2–4 short steps per view. */
export const TOUR_STEPS: Record<string, TourStep[]> = {
  reports: [
    { title: "Your PI at a glance", text: "Widgets summarise progress, business value, load and dependencies for the selected unit and PI." },
    { title: "Pick a unit", text: "Choose a portfolio, solution, ART or team in the sidebar; every tab is scoped to it." },
    { title: "Switch PI", text: "Use the PI picker in the header to look at another Program Increment." },
  ],
  roadmap: [
    { title: "Plan on a timeline", text: "Drag items to set planned dates and resize them to change their duration." },
    { title: "Unplanned work", text: "Items without dates wait in the side list until you drag them onto the timeline." },
  ],
  kanban: [
    { title: "Epics by state", text: "Each column is an Epic state; drag a card to move it through the portfolio flow." },
    { title: "Prioritise with WSJF", text: "Turn on sorting by WSJF to rank Epics by cost of delay divided by job size." },
  ],
  board: [
    { title: "Plan features per team", text: "Rows are teams (or ARTs), columns are the PI's iterations." },
    { title: "Dependencies", text: "Red lines show dependencies that land too late; open a card to review them." },
    { title: "Two modes", text: "Calculated mode follows the teams' plans; feature iteration mode lets you drag features." },
  ],
  teamboard: [
    { title: "Sprint planning", text: "Drag stories into sprints; each column shows load against the team's capacity." },
    { title: "Backlogs", text: "Pull work in from the team and ART backlogs on the side." },
  ],
  objectives: [
    { title: "PI objectives", text: "Add committed and uncommitted objectives with planned business value." },
    { title: "Link objectives upward", text: "Link each team objective to an ART (or solution) objective with the parent column." },
    { title: "Predictability", text: "Enter actual business value at the end of the PI to measure predictability." },
  ],
  risks: [
    { title: "ROAM your risks", text: "Drag risks between Resolved, Owned, Accepted and Mitigated." },
    { title: "Exposure", text: "Rate probability and impact to see exposure and residual exposure." },
  ],
  workitems: [
    { title: "One list for everything", text: "Edit titles, priorities, assignees and parents inline." },
    { title: "Filters", text: "Narrow the list with facets, quick filters or a WIQL clause, and export it as CSV." },
  ],
  hierarchy: [
    { title: "Epic to story", text: "Expand rows to follow the hierarchy with story point roll-ups." },
    { title: "Hints", text: "A warning icon marks items that skip a level or sit outside their parent's unit." },
  ],
  planning: [
    { title: "PI planning", text: "Walk through the PI planning agenda for the selected train." },
    { title: "Shared view", text: "Everything here is saved for the whole train, so everyone sees the same plan." },
  ],
  organization: [
    { title: "Your SAFe organisation", text: "Each band is a layer: portfolio, solution, ART and team." },
    { title: "Rearrange", text: "Add units or drag them to a new parent." },
  ],
  pis: [
    { title: "Program Increments", text: "Create PIs with their iterations, including an Innovation & Planning iteration." },
    { title: "Team sprints", text: "Map each team to the PI's iterations in one go." },
  ],
  setup: [
    { title: "Configure the hub", text: "Map your process's work item types and pick the PI root iteration." },
    { title: "Build the hierarchy", text: "Generate the hierarchy from area paths or edit it by hand." },
  ],
};

/**
 * Per-view onboarding panel, shown the first time a user opens a view. Seen views are
 * remembered per user (Extension Data Service, user scope) under "toursSeen".
 * `restartKey` changes when the user asks for the tour again from the Help menu.
 */
export function Tour({ view, suppressed = false, restartKey = 0 }: { view: string; suppressed?: boolean; restartKey?: number }) {
  const [seen, setSeen] = useState<string[] | null>(null);
  // The step belongs to a view, so switching views starts that view's tour at step 1.
  const [pos, setPos] = useState({ view, step: 0 });
  const step = pos.view === view ? pos.step : 0;
  const setStep = (n: number) => setPos({ view, step: n });

  useEffect(() => {
    let live = true;
    getUserValue<string[]>(TOURS_KEY, [])
      // A restart that happened while loading wins over the stored list.
      .then((v) => live && setSeen((prev) => prev ?? (Array.isArray(v) ? v : [])))
      .catch(() => undefined); // if we can't tell, don't nag
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!restartKey) return;
    setSeen([]);
    setPos({ view: "", step: 0 });
    setUserValue<string[]>(TOURS_KEY, []).catch(() => undefined);
  }, [restartKey]);

  const steps = TOUR_STEPS[view];
  if (!seen || suppressed || !steps || seen.includes(view)) return null;

  const dismiss = () => {
    const next = [...seen, view];
    setSeen(next);
    setUserValue(TOURS_KEY, next).catch(() => undefined);
  };
  const current = steps[step];
  const last = step >= steps.length - 1;

  return (
    <section className="tour" role="region" aria-label="Guided tour">
      <div className="tour-head">
        <Icon name="Lightbulb" />
        <strong className="tour-title">{current.title}</strong>
        <span className="muted small tour-count">
          {step + 1} of {steps.length}
        </span>
        <button className="link" onClick={dismiss} aria-label="Close tour">
          <Icon name="Cancel" />
        </button>
      </div>
      <p className="tour-text">{current.text}</p>
      <div className="tour-actions">
        <button className="link" onClick={dismiss}>
          Skip tour
        </button>
        <span className="spacer" />
        {step > 0 && (
          <button className="btn" onClick={() => setStep(step - 1)}>
            Back
          </button>
        )}
        {last ? (
          <button className="btn primary" onClick={dismiss}>
            Got it
          </button>
        ) : (
          <button className="btn primary" onClick={() => setStep(step + 1)}>
            Next
          </button>
        )}
      </div>
    </section>
  );
}
