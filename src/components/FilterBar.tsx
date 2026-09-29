import { useEffect, useState } from "react";
import { newId, quickFiltersStore } from "../api/data";
import { EMPTY_FILTER, ExtraFacet, filterToWiql, isFilterActive, ItemFilter, QuickFilter } from "../api/filters";
import { validateWiqlClause } from "../api/wit";
import { Icon, useAsync } from "./common";
import { useCanSafe } from "./useCanSafe";

type Facet = "types" | "states" | "assignees" | "tags" | "priorities" | "iterations";

const FACET_LABEL: Record<Facet, string> = {
  types: "Type",
  states: "State",
  assignees: "Assignee",
  tags: "Tags",
  priorities: "Priority",
  iterations: "Iteration",
};

/**
 * Shared filter toolbar (Agile Hive's JQL box, "More filters" and quick filters):
 * free text, facet menus (plus view-specific SAFe facets), saved quick filters (ANDed),
 * an advanced WIQL clause validated by the server before it applies, Copy WIQL and Clear.
 */
export function FilterBar({
  value,
  onChange,
  options,
  showWiql = true,
  extraFacets = [],
  quickFilters = true,
  validate = validateWiqlClause,
}: {
  value: ItemFilter;
  onChange: (f: ItemFilter) => void;
  options: Partial<Record<Facet, string[]>> & Record<"types" | "states" | "assignees" | "tags", string[]>;
  showWiql?: boolean;
  extraFacets?: ExtraFacet[];
  quickFilters?: boolean;
  validate?: (clause: string) => Promise<string | null>;
}) {
  const [wiqlDraft, setWiqlDraft] = useState(value.wiql);
  const [wiqlError, setWiqlError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => setWiqlDraft(value.wiql), [value.wiql]);

  const facets = (Object.keys(FACET_LABEL) as Facet[]).filter((f) => options[f] !== undefined);

  const toggle = (facet: Facet, option: string) => {
    const current = value[facet] ?? [];
    onChange({ ...value, [facet]: current.includes(option) ? current.filter((o) => o !== option) : [...current, option] });
  };

  const toggleExtra = (key: string, option: string) => {
    const current = value.extra?.[key] ?? [];
    const next = current.includes(option) ? current.filter((o) => o !== option) : [...current, option];
    onChange({ ...value, extra: { ...value.extra, [key]: next } });
  };

  const applyWiql = async () => {
    const clause = wiqlDraft.trim();
    if (clause) {
      const error = await validate(clause);
      setWiqlError(error);
      if (error) return;
    } else setWiqlError(null);
    onChange({ ...value, wiql: clause });
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
      {facets.map((facet) => (
        <FacetMenu
          key={facet}
          label={FACET_LABEL[facet]}
          options={options[facet]!}
          selected={value[facet] ?? []}
          onToggle={(o) => toggle(facet, o)}
        />
      ))}
      {extraFacets.map((facet) => (
        <FacetMenu
          key={facet.key}
          label={facet.label}
          options={facet.options}
          selected={value.extra?.[facet.key] ?? []}
          onToggle={(o) => toggleExtra(facet.key, o)}
        />
      ))}
      {quickFilters && <QuickFilters value={value} onChange={onChange} />}
      {showWiql && (
        <span className="wiql-box">
          <input
            className={"wiql" + (value.wiql ? " active" : "") + (wiqlError ? " invalid" : "")}
            aria-label="WIQL clause"
            aria-invalid={!!wiqlError}
            placeholder="WIQL clause, e.g. [System.Tags] CONTAINS 'MVP' (Enter)"
            value={wiqlDraft}
            onChange={(e) => {
              setWiqlDraft(e.target.value);
              setWiqlError(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && void applyWiql()}
          />
          {wiqlError && (
            <span className="field-error" role="alert">
              {wiqlError}
            </span>
          )}
        </span>
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

function FacetMenu({ label, options, selected, onToggle }: { label: string; options: string[]; selected: string[]; onToggle: (o: string) => void }) {
  return (
    <details className="facet">
      <summary className={"btn" + (selected.length ? " primary" : "")}>
        {label}
        {selected.length ? ` (${selected.length})` : ""}
      </summary>
      <div className="facet-menu" role="group" aria-label={`${label} filter`}>
        {options.length === 0 && <span className="muted small">No values</span>}
        {options.map((o) => (
          <label key={o} className="check">
            <input type="checkbox" checked={selected.includes(o)} onChange={() => onToggle(o)} /> {o}
          </label>
        ))}
      </div>
    </details>
  );
}

/** Saved, shared filters for the project; several can be active at once (AND). */
function QuickFilters({ value, onChange }: { value: ItemFilter; onChange: (f: ItemFilter) => void }) {
  const can = useCanSafe();
  const { data, setData, error } = useAsync(() => quickFiltersStore.list(), []);
  const [name, setName] = useState("");
  const [saveError, setSaveError] = useState<string>();
  const active = value.quick ?? [];
  const saved = data ?? [];
  const own: ItemFilter = { ...value, quick: undefined };

  const toggle = (q: QuickFilter) => {
    const on = active.some((a) => a.id === q.id);
    onChange({ ...value, quick: on ? active.filter((a) => a.id !== q.id) : [...active, q] });
  };

  const save = async () => {
    if (!name.trim()) return;
    try {
      const doc = await quickFiltersStore.save({ id: newId(), name: name.trim(), filter: own });
      setData([...saved, doc]);
      setName("");
      setSaveError(undefined);
    } catch (e: any) {
      setSaveError(e?.message ?? String(e));
    }
  };

  const remove = async (q: QuickFilter) => {
    try {
      await quickFiltersStore.remove(q.id);
      setData(saved.filter((s) => s.id !== q.id));
      onChange({ ...value, quick: active.filter((a) => a.id !== q.id) });
    } catch (e: any) {
      setSaveError(e?.message ?? String(e));
    }
  };

  return (
    <details className="facet">
      <summary className={"btn" + (active.length ? " primary" : "")}>
        Quick filters{active.length ? ` (${active.length})` : ""}
      </summary>
      <div className="facet-menu quick-menu" role="group" aria-label="Quick filters">
        {error && <span className="danger small">{error}</span>}
        {saved.length === 0 && !error && <span className="muted small">No quick filters yet</span>}
        {saved.map((q) => (
          <div key={q.id} className="quick-row">
            <label className="check">
              <input type="checkbox" checked={active.some((a) => a.id === q.id)} onChange={() => toggle(q)} /> {q.name}
            </label>
            {can.plan && (
              <button className="link small danger" aria-label={`Delete quick filter ${q.name}`} onClick={() => void remove(q)}>
                <Icon name="Delete" className="small" />
              </button>
            )}
          </div>
        ))}
        {can.plan && isFilterActive(own) && (
          <div className="quick-save">
            <input aria-label="Quick filter name" placeholder="Name this filter" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
            <button className="btn primary" disabled={!name.trim()} onClick={() => void save()}>
              Save
            </button>
          </div>
        )}
        {saveError && <span className="danger small">{saveError}</span>}
      </div>
    </details>
  );
}
