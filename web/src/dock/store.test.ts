import { beforeEach, describe, expect, it } from "vitest";
import { defaultTabs, dock, dockStore } from "./store.ts";

const ids = () => dockStore.get().tabs.map((tab) => tab.id);

describe("dock tabs", () => {
  beforeEach(() => {
    dock.setCwd(null);
    dockStore.set((prev) => ({ ...prev, open: false, fullscreen: false, tabs: defaultTabs(), activeId: "files" }));
  });

  it("starts with 文件 and Git in the top bar, files active", () => {
    dock.open();
    expect(dockStore.get().open).toBe(true);
    expect(ids()).toEqual(["files", "git"]);
    expect(dockStore.get().activeId).toBe("files");
  });

  it("gives a new workspace the default tabs and restores a parked one", () => {
    dock.setCwd("/a");
    dock.openFile("src/x.ts");
    expect(ids()).toEqual(["files", "git", "file:src/x.ts"]);
    dock.setCwd("/b");
    expect(ids()).toEqual(["files", "git"]);
    expect(dockStore.get().activeId).toBe("files");
    dock.setCwd("/a");
    expect(ids()).toEqual(["files", "git", "file:src/x.ts"]);
    expect(dockStore.get().activeId).toBe("file:src/x.ts");
  });

  it("reopens a closed top-bar tab without duplicating it", () => {
    dock.open();
    dock.closeTab("git");
    expect(ids()).toEqual(["files"]);
    dock.openGit();
    dock.openGit();
    expect(ids()).toEqual(["files", "git"]);
    expect(dockStore.get().activeId).toBe("git");
  });

  it("closing the last tab closes the dock and resets to the defaults", () => {
    dock.open();
    dock.closeTab("git");
    dock.closeTab("files");
    expect(dockStore.get().open).toBe(false);
    expect(ids()).toEqual(["files", "git"]);
    dock.open();
    expect(dockStore.get().activeId).toBe("files");
  });
});
