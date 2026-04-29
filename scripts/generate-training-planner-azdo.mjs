import fsSync from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import {
  buildAuthConfig,
  buildAuthenticatedWebsiteBrief,
  discoverAuthenticatedApp,
  validateAuthConfig,
} from "../agent/authenticated-app-session.mjs";
import { generateFocusedGroundedModuleTestCases } from "../agent/grounded-website-testcases.mjs";
import { createTestPlansClient } from "../agent/testplans-client.mjs";

(function loadEnvFiles() {
  const root = process.cwd();
  for (const name of [".env.local", ".env"]) {
    const filePath = path.join(root, name);
    if (!fsSync.existsSync(filePath)) continue;
    const lines = fsSync.readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eqIdx = line.indexOf("=");
      if (eqIdx < 1) continue;
      const key = line.slice(0, eqIdx).trim();
      const val = line.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key && !(key in process.env)) {
        process.env[key] = val;
      }
    }
    break;
  }
})();

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function readEnv(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function parsePositiveInteger(value) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0 && Number.isInteger(parsed)) {
    return parsed;
  }
  return null;
}

function parseAzureDevOpsProjectUrl(value) {
  const raw = cleanText(value);
  if (!raw) {
    return { orgUrl: "", project: "" };
  }

  try {
    const url = new URL(raw);
    const segments = url.pathname
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);
    const orgName = segments[0] || "";
    const project = segments[1] || "";
    return {
      orgUrl: orgName ? `${url.origin}/${orgName}` : url.origin,
      project,
    };
  } catch {
    return { orgUrl: "", project: "" };
  }
}

function buildAzureDevOpsConfig() {
  const projectUrl = readEnv("AZDO_PROJECT_URL");
  const parsedProjectUrl = parseAzureDevOpsProjectUrl(projectUrl);

  return {
    orgUrl: readEnv("AZDO_ORG_URL", parsedProjectUrl.orgUrl),
    project: readEnv("AZDO_PROJECT", parsedProjectUrl.project),
    pat: readEnv("AZDO_PAT"),
    accessToken: readEnv("SYSTEM_ACCESSTOKEN"),
  };
}

function buildPlanName(websiteBrief) {
  const siteLabel = cleanText(websiteBrief?.title || websiteBrief?.host || websiteBrief?.url || "Website");
  return `${siteLabel} Training Planner Generated Coverage ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
}

function buildSuiteName(testCaseDrafts) {
  const count = Array.isArray(testCaseDrafts?.testCases) ? testCaseDrafts.testCases.length : 0;
  return `Training Planner grounded suite (${count} cases)`;
}

async function resolveTargetPlanAndSuite(client, options) {
  const planId = parsePositiveInteger(options.planId);
  const suiteId = parsePositiveInteger(options.suiteId);

  if (suiteId && !planId) {
    throw new Error("A plan id is required when a suite id is provided.");
  }

  if (planId && suiteId) {
    return {
      planId,
      suiteId,
      createdPlan: false,
      createdSuite: false,
    };
  }

  if (planId) {
    const plan = await client.getTestPlan(planId);
    const rootSuiteId = parsePositiveInteger(plan?.rootSuite?.id);
    if (!rootSuiteId) {
      throw new Error(`Azure DevOps plan ${planId} does not expose a valid root suite.`);
    }

    const suite = await client.createTestSuite({
      planId,
      parentSuiteId: rootSuiteId,
      name: options.suiteName,
    });

    return {
      planId,
      suiteId: parsePositiveInteger(suite?.id),
      createdPlan: false,
      createdSuite: true,
    };
  }

  const createdPlan = await client.createTestPlan({
    name: options.planName,
    areaPath: options.areaPath,
    iteration: options.iterationPath,
  });
  const createdPlanId = parsePositiveInteger(createdPlan?.id);
  const rootSuiteId = parsePositiveInteger(createdPlan?.rootSuiteId);
  if (!createdPlanId || !rootSuiteId) {
    throw new Error("A valid Azure DevOps test plan/root suite could not be created.");
  }

  const suite = await client.createTestSuite({
    planId: createdPlanId,
    parentSuiteId: rootSuiteId,
    name: options.suiteName,
  });

  return {
    planId: createdPlanId,
    suiteId: parsePositiveInteger(suite?.id),
    createdPlan: true,
    createdSuite: true,
  };
}

async function uploadTrainingPlannerCases(client, target, testCaseDrafts) {
  const createdIds = [];
  const failedCases = [];

  for (const testCase of testCaseDrafts.testCases || []) {
    try {
      const created = await client.createTestCaseWorkItem({
        title: testCase.title,
        steps: testCase.steps || [],
        expectedResult: testCase.expectedResult || "",
      });
      if (created?.id) {
        createdIds.push(created.id);
      }
    } catch (error) {
      failedCases.push({
        title: testCase?.title || "",
        error: error?.message || String(error),
      });
    }
  }

  if (createdIds.length) {
    await client.addTestCasesToSuite({
      planId: target.planId,
      suiteId: target.suiteId,
      testCaseIds: createdIds,
    });
  }

  return {
    createdIds,
    failedCases,
  };
}

const websiteUrl = cleanText(process.argv[2] || readEnv("WEBSITE_URL", "APP_POST_LOGIN_URL", "APP_LOGIN_URL"));
if (!websiteUrl) {
  throw new Error("A website URL is required. Pass it as the first argument or set WEBSITE_URL.");
}

const azdoConfig = buildAzureDevOpsConfig();
if (!azdoConfig.orgUrl || !azdoConfig.project) {
  throw new Error("Azure DevOps configuration is incomplete. Set AZDO_ORG_URL/AZDO_PROJECT or AZDO_PROJECT_URL.");
}

const authConfig = buildAuthConfig(websiteUrl);
const missingAuth = validateAuthConfig(authConfig);
if (missingAuth.length) {
  throw new Error(`Missing required authentication configuration: ${missingAuth.join(", ")}`);
}

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  const discovery = await discoverAuthenticatedApp(page, authConfig);
  const websiteBrief = buildAuthenticatedWebsiteBrief(websiteUrl, discovery);
  const focusedCases = generateFocusedGroundedModuleTestCases(websiteBrief, "Training Planner");

  const client = createTestPlansClient(azdoConfig);
  const planName =
    readEnv("AZDO_TRAINING_PLANNER_PLAN_NAME", "AZDO_GENERATED_PLAN_NAME") || buildPlanName(websiteBrief);
  const suiteName =
    readEnv("AZDO_TRAINING_PLANNER_SUITE_NAME", "AZDO_GENERATED_SUITE_NAME") || buildSuiteName(focusedCases);
  const areaPath = readEnv("AZDO_GENERATED_PLAN_AREA_PATH", "AZDO_AREA_PATH", azdoConfig.project);
  const iterationPath = readEnv("AZDO_GENERATED_PLAN_ITERATION", "AZDO_ITERATION_PATH", azdoConfig.project);

  const target = await resolveTargetPlanAndSuite(client, {
    planId: readEnv("AZDO_TRAINING_PLANNER_PLAN_ID", "AZDO_GENERATED_PLAN_ID"),
    suiteId: readEnv("AZDO_TRAINING_PLANNER_SUITE_ID", "AZDO_GENERATED_SUITE_ID"),
    planName,
    suiteName,
    areaPath,
    iterationPath,
  });

  const upload = await uploadTrainingPlannerCases(client, target, focusedCases);

  console.log(
    JSON.stringify(
      {
        websiteUrl,
        targetModule: focusedCases.targetModule,
        generationSource: focusedCases.generationSource,
        generatedCaseCount: focusedCases.testCases.length,
        testCaseTitles: focusedCases.testCases.map((item) => item.title),
        azureDevOps: {
          orgUrl: azdoConfig.orgUrl,
          project: azdoConfig.project,
          planId: target.planId,
          suiteId: target.suiteId,
          createdPlan: target.createdPlan,
          createdSuite: target.createdSuite,
          createdCaseIds: upload.createdIds,
          failedCases: upload.failedCases,
        },
      },
      null,
      2
    )
  );
} finally {
  await browser.close().catch(() => {});
}
