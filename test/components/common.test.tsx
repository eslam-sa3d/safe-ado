import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  Empty,
  ErrorBar,
  Field,
  fmtDate,
  Info,
  lastSegment,
  Modal,
  Progress,
  Spinner,
  storage,
  typeColor,
  useAsync,
} from "../../src/components/common";

describe("useAsync", () => {
  it("loads data and exposes loading state", async () => {
    const { result } = renderHook(() => useAsync(async () => 42, []));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBe(42);
    expect(result.current.error).toBeUndefined();
  });

  it("captures errors, including non-Error rejections", async () => {
    const { result } = renderHook(() => useAsync(async () => Promise.reject(new Error("nope")), []));
    await waitFor(() => expect(result.current.error).toBe("nope"));
    const second = renderHook(() => useAsync(async () => Promise.reject("plain"), []));
    await waitFor(() => expect(second.result.current.error).toBe("plain"));
  });

  it("reloads silently without flipping loading back on", async () => {
    let n = 0;
    const { result } = renderHook(() => useAsync(async () => ++n, []));
    await waitFor(() => expect(result.current.data).toBe(1));
    act(() => result.current.reload(true));
    expect(result.current.loading).toBe(false);
    await waitFor(() => expect(result.current.data).toBe(2));
    act(() => result.current.reload());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toBe(3));
  });

  it("ignores stale responses when dependencies change", async () => {
    const resolvers: ((v: string) => void)[] = [];
    const { result, rerender } = renderHook(({ dep }) => useAsync(() => new Promise<string>((r) => resolvers.push(r)), [dep]), {
      initialProps: { dep: "a" },
    });
    rerender({ dep: "b" });
    await act(async () => {
      resolvers[1]("fresh");
      resolvers[0]("stale");
    });
    expect(result.current.data).toBe("fresh");
  });
});

describe("presentational components", () => {
  it("renders spinner, info, empty and field", () => {
    render(
      <>
        <Spinner />
        <Spinner label="Busy" />
        <Info>hello</Info>
        <Empty title="Nothing">
          <p>detail</p>
        </Empty>
        <Empty title="Bare" />
        <Field label="Name">
          <input />
        </Field>
      </>
    );
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.getByText("Busy")).toBeInTheDocument();
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Nothing" })).toBeInTheDocument();
    expect(screen.getByText("detail")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
  });

  it("renders ErrorBar only with a message and supports dismiss", () => {
    const onClose = vi.fn();
    const { container, rerender } = render(<ErrorBar />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ErrorBar message="Bad" onClose={onClose} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Bad");
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(onClose).toHaveBeenCalled();
    rerender(<ErrorBar message="No close" />);
    expect(screen.queryByLabelText("Dismiss")).not.toBeInTheDocument();
  });

  it("renders progress percentages, caps the bar and handles zero totals", () => {
    const { container, rerender } = render(<Progress done={1} total={4} />);
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(container.querySelector(".progress")).toHaveAttribute("title", "1 / 4 (25%)");
    rerender(<Progress done={9} total={4} label="custom" />);
    expect((container.querySelector(".progress-bar") as HTMLElement).style.width).toBe("100%");
    expect(screen.getByText("custom")).toBeInTheDocument();
    rerender(<Progress done={0} total={0} />);
    expect(screen.getByText("0%")).toBeInTheDocument();
  });

  it("closes the modal on Escape, backdrop click and close button, but not on inner clicks", () => {
    const onClose = vi.fn();
    render(
      <Modal title="Dialog" onClose={onClose} footer={<button>OK</button>}>
        <p>Body</p>
      </Modal>
    );
    expect(screen.getByRole("dialog", { name: "Dialog" })).toBeInTheDocument();
    expect(screen.getByText("OK")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText("Body"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.mouseDown(document.querySelector(".modal-backdrop")!);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("renders a modal without footer", () => {
    render(
      <Modal title="Plain" onClose={() => {}}>
        x
      </Modal>
    );
    expect(document.querySelector(".modal-footer")).toBeNull();
  });
});

describe("formatting helpers", () => {
  it("maps type colours with a fallback", () => {
    expect(typeColor("Epic")).toBe("#ff7b00");
    expect(typeColor("Custom Thing")).toBe("#888");
  });

  it("formats dates in UTC and handles missing values", () => {
    expect(fmtDate(undefined)).toBe("");
    expect(fmtDate("2026-03-01T00:00:00Z")).toMatch(/Mar|3/);
  });

  it("takes the last path segment", () => {
    expect(lastSegment("A\\B\\C")).toBe("C");
    expect(lastSegment("A")).toBe("A");
    expect(lastSegment(undefined)).toBe("");
  });
});

describe("storage", () => {
  it("round-trips JSON and falls back when empty or corrupt", () => {
    const [get, set] = storage("k", { a: 1 });
    expect(get()).toEqual({ a: 1 });
    set({ a: 2 });
    expect(get()).toEqual({ a: 2 });
    localStorage.setItem("k", "{not json");
    expect(get()).toEqual({ a: 1 });
  });

  it("survives storage that throws (private mode / blocked site data)", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const [get, set] = storage("k", "fallback");
    expect(get()).toBe("fallback");
    expect(() => set("x")).not.toThrow();
    getItem.mockRestore();
    setItem.mockRestore();
  });
});
