import { useEffect, useState } from "react";
import { EMPTY_FILTER, filterToWiql, isFilterActive, ItemFilter } from "../api/filters";
import { Icon } from "./common";

type Facet = "types" | "states" | "assignees" | "tags";

const FACET_LABEL: Record<Facet, string> = { types: "Type", states: "State", assignees: "Assignee", tags: "Tags" };

/**
 * Shared filter toolbar (Agile Hive's JQL box + "More filters"): free text, facet menus,
 * an advanced WIQL clause applied on Enter, Copy WIQL and Clear.
 */
export function FilterBar({
  value,
  onChange,
  options,
  showWiql = true,
}: {
  value: ItemFilter;
  onChange: (f: ItemFilter) => void;
  options: Record<Facet, string[]>;
  showWiql?: boolean;
}) {
  const [wiqlDraft, setWiqlDraft] = useState(value.wiql);
  const [copied, setCopied] = useState(false);
  useEffect(() => setWiqlDraft(value.wiql), [value.wiql]);

  const toggle = (facet: Facet, option: string) => {
    const current = value[facet];
    onChange({ ...value, [facet]: current.includes(option) ? current.filter((o) => o !== option) : [...current, option] });
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(filterToWiql(value));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable in the iframe */
    }
  };

  return (
    <div className="filterbar" role="search">
      <span className="search-box">
        <Icon name="Filter" />
        <input
          className="search"
          aria-label="Filter text"
          placeholder="Filter by title or ID"
          value={value.text}
          onChange={(e) => onChange({ ...value, text: e.target.value })}
        />
      </span>
      {(Object.keys(FACET_LABEL) as Facet[]).map((facet) => (
        <details key={facet} className="facet">
          <summary className={"btn" + (value[facet].length ? " primary" : "")}>
            {FACET_LABEL[facet]}
            {value[facet].length ? ` (${value[facet].length})` : ""}
          </summary>
          <div className="facet-menu" role="group" aria-label={`${FACET_LABEL[facet]} filter`}>
            {options[facet].length === 0 && <span className="muted small">No values</span>}
            {options[facet].map((o) => (
              <label key={o} className="check">
                <input type="checkbox" checked={value[facet].includes(o)} onChange={() => toggle(facet, o)} /> {o}
              </label>
            ))}
          </div>
        </details>
      ))}
      {showWiql && (
        <input
          className={"wiql" + (value.wiql ? " active" : "")}
          aria-label="WIQL clause"
          placeholder="WIQL clause, e.g. [System.Tags] CONTAINS 'MVP' (Enter)"
          value={wiqlDraft}
          onChange={(e) => setWiqlDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onChange({ ...value, wiql: wiqlDraft })}
        />
      )}
      <button className="btn" onClick={copy} disabled={!isFilterActive(value)} title="Copy the filter as a WIQL clause">
        {copied ? (
          <>
            <Icon name="CheckMark" /> Copied
          </>
        ) : (
          "Copy WIQL"
        )}
      </button>
      <button className="btn" onClick={() => onChange(EMPTY_FILTER)} disabled={!isFilterActive(value)}>
        Clear filters
      </button>
    </div>
  );
}
