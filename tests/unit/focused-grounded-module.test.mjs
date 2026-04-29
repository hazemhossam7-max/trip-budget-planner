import assert from "node:assert/strict";
import {
  generateFocusedGroundedModuleTestCases,
} from "../../agent/grounded-website-testcases.mjs";

const cases = [
  {
    name: "generateFocusedGroundedModuleTestCases returns only auth smoke and Training Planner-focused cases",
    run() {
      const suite = generateFocusedGroundedModuleTestCases(
        {
          url: "https://example.com/app",
          title: "Dashboard",
          sidebarModules: ["Dashboard", "Collections", "Training Planner"],
          pages: [
            {
              title: "Training Planner | Example",
              url: "https://example.com/app/training-planner",
              headings: ["Training Planner"],
              buttons: ["Create Plan"],
              forms: [{ summary: "name; description" }],
              cards: [],
              importantLinks: [
                { text: "Dashboard", href: "https://example.com/app" },
                { text: "Training Planner", href: "https://example.com/app/training-planner" },
              ],
            },
            {
              title: "Collections",
              url: "https://example.com/app/collections",
              headings: ["Collections"],
              buttons: ["Create Collection"],
              forms: [{ summary: "name; description" }],
              cards: [],
            },
          ],
        },
        "Training Planner"
      );

      assert.equal(suite.targetModule, "Training Planner");
      assert.ok(suite.testCases.length >= 3);
      assert.equal(suite.testCases[0].title, "Auth smoke: login reaches the protected application shell");
      assert.ok(
        suite.testCases.some((item) => item.title === "Workflow: create training plan and verify it persists")
      );
      assert.ok(
        suite.testCases.every((item) => {
          if (item.title === "Auth smoke: login reaches the protected application shell") {
            return true;
          }
          return (
            String(item.module || "").includes("Training Planner") ||
            item.route === "/training-planner"
          );
        })
      );
      assert.ok(
        suite.testCases.every((item, index) => item.id === `TC-${String(index + 1).padStart(3, "0")}`)
      );
    },
  },
];

let failures = 0;

for (const entry of cases) {
  try {
    await entry.run();
    console.log(`PASS ${entry.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${entry.name}`);
    console.error(error?.stack || error?.message || String(error));
  }
}

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log(`PASS ${cases.length} tests`);
}
