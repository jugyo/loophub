import { expect, test } from "#loophub-test";
import { currentHerdrPaneContext } from "./herdr-context.ts";

test("currentHerdrPaneContext accepts a complete Herdr pane identity", () => {
  expect(
    currentHerdrPaneContext({
      HERDR_ENV: "1",
      HERDR_SESSION: "workflow-session",
      HERDR_PANE_ID: "w4:p2",
      LOOPHUB_ISSUE_CREATE_HERDR_LAUNCH: "launch-1",
    }),
  ).toEqual({
    sessionName: "workflow-session",
    paneId: "w4:p2",
    launchId: "launch-1",
  });
});

test("currentHerdrPaneContext prefers the hc terminal over inherited Herdr identity", () => {
  expect(
    currentHerdrPaneContext({
      HC_TERMINAL_ID: "t7",
      // A terminal inherits these from whichever pane started the core.
      HERDR_ENV: "1",
      HERDR_SESSION: "unrelated",
      HERDR_PANE_ID: "w4:p2",
      LOOPHUB_ISSUE_CREATE_HERDR_LAUNCH: "launch-1",
    }),
  ).toEqual({
    sessionName: "herdr-core",
    paneId: "t7",
    launchId: "launch-1",
  });
});

test.each([
  [{ HERDR_SESSION: "session", HERDR_PANE_ID: "w1:p1" }],
  [{ HERDR_ENV: "0", HERDR_SESSION: "session", HERDR_PANE_ID: "w1:p1" }],
  [{ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }],
  [{ HERDR_ENV: "1", HERDR_SESSION: "session" }],
  [
    {
      HERDR_ENV: "1",
      HERDR_SESSION: "--session",
      HERDR_PANE_ID: "w1:p1",
    },
  ],
  [
    {
      HERDR_ENV: "1",
      HERDR_SESSION: "session",
      HERDR_PANE_ID: "--pane",
    },
  ],
  [
    {
      HERDR_ENV: "1",
      HERDR_SESSION: "session",
      HERDR_PANE_ID: "w1:p1",
      LOOPHUB_ISSUE_CREATE_HERDR_LAUNCH: "bad launch",
    },
  ],
])("currentHerdrPaneContext rejects untrusted environment %j", (env) => {
  expect(currentHerdrPaneContext(env)).toBeNull();
});
