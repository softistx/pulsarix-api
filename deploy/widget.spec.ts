import { describe, expect, test } from "bun:test";
import {
  expectsIconSheet,
  iconSpritesDir,
  manifestWidget,
  planWidgetSync,
  widgetPaths,
} from "./widget";

describe("widgetPaths", () => {
  test("defaults to the sibling checkout of the API, relative to deploy/", () => {
    expect(widgetPaths({}, "/srv/pulsarix-api/deploy")).toEqual({
      dist: "/srv/pulsarix-widget/dist",
      root: "/srv/pulsarix-widget",
    });
  });
  test("WIDGET_DIST overrides it, absolute or relative", () => {
    expect(widgetPaths({ WIDGET_DIST: "/w/dist" }, "/x/deploy")).toEqual({
      dist: "/w/dist",
      root: "/w",
    });
    expect(widgetPaths({ WIDGET_DIST: "../w/dist" }, "/x/deploy").dist).toBe(
      "/x/w/dist",
    );
  });
});

describe("manifestWidget", () => {
  test("reads the hashed bundle name, tolerates a missing or broken manifest", () => {
    expect(
      manifestWidget('{"loader":"loader.js","widget":"widget.a1.js"}'),
    ).toBe("widget.a1.js");
    expect(manifestWidget(undefined)).toBeUndefined();
    expect(manifestWidget("{nope")).toBeUndefined();
    expect(manifestWidget("{}")).toBeUndefined();
  });
});

describe("planWidgetSync", () => {
  const built = ["manifest.json", "widget.b2.js", "loader.js", "index.js"];
  test("writes the loader and the manifest last, after the bundle they name", () => {
    const { copy } = planWidgetSync({ built, existing: [] });
    expect(copy).toEqual([
      "index.js",
      "widget.b2.js",
      "loader.js",
      "manifest.json",
    ]);
  });
  test("a stale bundle goes, except the previous manifest's, which stays one deploy", () => {
    const existing = [
      "loader.js",
      "widget.a1.js",
      "widget.old.js",
      "widget.b2.js",
    ];
    const { stale } = planWidgetSync({ built, existing, keep: "widget.a1.js" });
    expect(stale).toEqual(["widget.old.js"]);
  });
  test("nothing is stale on a first deploy or a rerun of the same build", () => {
    expect(planWidgetSync({ built, existing: [] }).stale).toEqual([]);
    expect(planWidgetSync({ built, existing: built }).stale).toEqual([]);
  });
});

describe("iconSpritesDir", () => {
  test("defaults to the pulsarix-ui checkout beside the API's", () => {
    expect(iconSpritesDir({}, "/srv/pulsarix-ui", "/srv/pulsarix-api")).toBe(
      "/srv/pulsarix-ui/public/assets/icons/sprites",
    );
    expect(
      iconSpritesDir(
        { ICON_SPRITES_DIR: "" },
        "/srv/pulsarix-ui",
        "/srv/pulsarix-api",
      ),
    ).toBe("/srv/pulsarix-ui/public/assets/icons/sprites");
  });
  test("ICON_SPRITES_DIR overrides it, absolute or relative to the API", () => {
    expect(
      iconSpritesDir({ ICON_SPRITES_DIR: "/i/s" }, "/ui", "/srv/api"),
    ).toBe("/i/s");
    expect(
      iconSpritesDir({ ICON_SPRITES_DIR: "../i" }, "/ui", "/srv/api"),
    ).toBe("/srv/i");
  });
});

describe("expectsIconSheet", () => {
  test("only a build that wrote icons/duotone.svg is checked for it", () => {
    expect(expectsIconSheet(["loader.js", "icons/duotone.svg"])).toBe(true);
    expect(expectsIconSheet(["loader.js", "manifest.json"])).toBe(false);
  });
});
