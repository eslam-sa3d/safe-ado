import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_FILTER, ItemFilter } from "../../src/api/filters";
import { FilterBar } from "../../src/components/FilterBar";

const OPTIONS = { types: ["Epic", "Feature"], states: ["New"], assignees: ["Ada", "Unassigned"], tags: [], iterations: ["Sprint 1"] };

function Harness({ onChange, validate, initial = EMPTY_FILTER }: { onChange: (f: ItemFilter) => void; validate: (c: string) => Promise<string | null>; initial?: ItemFilter }) {
  const [f, setF] = useState(initial);
  return (
    <FilterBar
      value={f}
      options={OPTIONS}
      quickFilters={false}
      validate={validate}
      extraFacets={[{ key: "pis", label: "Assigned PIs", options: ["PI 2"], values: () => [] }]}
      onChange={(next) => {
        setF(next);
        onChange(next);
      }}
    />
  );
}

describe("FilterBar guard and Copy WIQL", () => {
  it("rejects clauses escaping the scope inline, without asking the server", async () => {
    const onChange = vi.fn();
    const validate = vi.fn(async () => null);
    render(<Harness onChange={onChange} validate={validate} />);
    const wiql = screen.getByLabelText("WIQL clause");
    fireEvent.change(wiql, { target: { value: "1=1) OR ([System.Id] > 0" } });
    fireEvent.keyDown(wiql, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Unbalanced parentheses in the WIQL clause.");
    expect(wiql).toHaveAttribute("aria-invalid", "true");

    fireEvent.change(wiql, { target: { value: "[a] = 1 ORDER BY [b]" } });
    fireEvent.keyDown(wiql, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent("ORDER BY, ASOF and MODE aren't allowed in a filter clause.");
    expect(validate).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(wiql, { target: { value: "[a] = 'x'" } });
    fireEvent.keyDown(wiql, { key: "Enter" });
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ wiql: "[a] = 'x'" })));
    expect(validate).toHaveBeenCalledWith("[a] = 'x'");
  });

  it("says when some filters aren't part of the copied WIQL", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<Harness onChange={vi.fn()} validate={async () => null} />);
    const copy = () => screen.getByRole("button", { name: /Copy WIQL|Copied/ });

    fireEvent.click(screen.getByRole("group", { name: "Assignee filter" }).querySelectorAll("input")[1]);
    expect(copy()).toHaveAttribute("title", "Copy the filter as a WIQL clause");
    fireEvent.click(copy());
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("[System.AssignedTo] = ''"));

    fireEvent.click(screen.getByRole("group", { name: "Iteration filter" }).querySelector("input")!);
    expect(copy()).toHaveAttribute("title", "Some filters (Iteration, SAFe facets) aren't part of the copied WIQL");
    fireEvent.click(screen.getByRole("group", { name: "Iteration filter" }).querySelector("input")!);
    fireEvent.click(screen.getByRole("group", { name: "Assigned PIs filter" }).querySelector("input")!);
    expect(copy()).toHaveAttribute("title", "Some filters (Iteration, SAFe facets) aren't part of the copied WIQL");
  });
});
