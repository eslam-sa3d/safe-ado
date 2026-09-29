import { describe, expect, it } from "vitest";
import { boardRows, boardType, childLevels, findNode, flatten, LEVEL_COLOR, parentOf, pathTo, scopeAreas, subtreeIds } from "../../src/api/org";
import { OrgNode } from "../../src/api/types";
import { ART_A, ART_B, makeConfig, P } from "../fakeAdo";

const config = makeConfig();
const root = config.root;

describe("org tree helpers", () => {
  it("flattens depth-first", () => {
    expect(flatten(root).map((n) => n.id)).toEqual(["n-root", "n-arta", "n-red", "n-blue", "n-artb", "n-green"]);
  });

  it("finds nodes, parents and paths", () => {
    expect(findNode(root, "n-blue")?.name).toBe("Team Blue");
    expect(findNode(root, "nope")).toBeUndefined();
    expect(parentOf(root, "n-blue")?.id).toBe("n-arta");
    expect(parentOf(root, "n-root")).toBeUndefined();
    expect(pathTo(root, "n-green").map((n) => n.id)).toEqual(["n-root", "n-artb", "n-green"]);
    expect(pathTo(root, "missing")).toEqual([root]);
  });

  it("knows which levels can nest under which", () => {
    expect(childLevels("portfolio")).toEqual(["solution", "art"]);
    expect(childLevels("solution")).toEqual(["art"]);
    expect(childLevels("art")).toEqual(["team"]);
    expect(childLevels("team")).toEqual([]);
  });

  it("scopes by own area path, else descendants' top-most area paths", () => {
    expect(scopeAreas(root)).toEqual([P]);
    const noArea: OrgNode = { ...root, areaPath: undefined };
    expect(scopeAreas(noArea)).toEqual([ART_A, ART_B]);
    const partial: OrgNode = { id: "x", name: "x", level: "solution", children: [{ ...root.children[0], areaPath: undefined }] };
    expect(scopeAreas(partial)).toEqual(["Fabrikam\\ART A\\Team Red", "Fabrikam\\ART A\\Team Blue"]);
    expect(scopeAreas({ id: "y", name: "y", level: "team", children: [] })).toEqual([]);
  });

  it("picks the board work item type per level", () => {
    expect(boardType(config, "portfolio")).toBe("Epic");
    expect(boardType(config, "solution")).toBe("Feature");
    expect(boardType({ ...config, types: { ...config.types, capability: "Capability" } }, "solution")).toBe("Capability");
    expect(boardType(config, "art")).toBe("Feature");
    expect(boardType(config, "team")).toBe("Feature");
  });

  it("uses children as board rows, or the node itself", () => {
    expect(boardRows(findNode(root, "n-arta")!).map((n) => n.id)).toEqual(["n-red", "n-blue"]);
    expect(boardRows(findNode(root, "n-red")!).map((n) => n.id)).toEqual(["n-red"]);
    const lonelyArt: OrgNode = { id: "a", name: "a", level: "art", children: [] };
    expect(boardRows(lonelyArt)).toEqual([lonelyArt]);
  });

  it("collects subtree ids", () => {
    expect(Array.from(subtreeIds(findNode(root, "n-arta")!))).toEqual(["n-arta", "n-red", "n-blue"]);
  });

  it("has a colour per level", () => {
    expect(Object.keys(LEVEL_COLOR)).toEqual(["portfolio", "solution", "art", "team"]);
  });
});
