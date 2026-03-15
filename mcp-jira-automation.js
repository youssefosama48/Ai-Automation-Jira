#!/usr/bin/env node

/**
 * Jira + Zephyr Scale MCP Server
 *
 * A Model Context Protocol server for Jira Cloud + Zephyr Scale (TM4J).
 *
 * Setup:
 *   npm install @modelcontextprotocol/sdk node-fetch
 *
 * Environment variables (required):
 *   JIRA_BASE_URL        - e.g. https://yourcompany.atlassian.net
 *   JIRA_EMAIL           - your Atlassian account email
 *   JIRA_API_TOKEN       - your Atlassian API token
 *                          (generate at https://id.atlassian.com/manage-profile/security/api-tokens)
 *   ZEPHYR_API_TOKEN     - your Zephyr Scale API token
 *                          (generate inside Jira → Zephyr Scale → API Keys)
 *   ANTHROPIC_API_KEY    - your Anthropic API key
 *                          (generate at https://console.anthropic.com → API Keys)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
import express from "express";
import cron from "node-cron";
import { spawn } from "child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import os from "os";
import { parseStringPromise } from "xml2js";

// ─── Config ───────────────────────────────────────────────────────────────────

const JIRA_BASE_URL     = process.env.JIRA_BASE_URL?.replace(/\/$/, "");
const JIRA_EMAIL        = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN    = process.env.JIRA_API_TOKEN;
const ZEPHYR_API_TOKEN  = process.env.ZEPHYR_API_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
  console.error("Missing required env vars: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN");
  process.exit(1);
}

const JIRA_AUTH_HEADER =
  "Basic " + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");

// Zephyr Scale SmartBear hosted API
const ZEPHYR_BASE_URL = "https://api.zephyrscale.smartbear.com/v2";

// ─── Jira API helper ──────────────────────────────────────────────────────────

async function jiraRequest(method, path, body) {
  const url = `${JIRA_BASE_URL}/rest/api/3${path}`;
  const options = {
    method,
    headers: {
      Authorization: JIRA_AUTH_HEADER,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res  = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) throw new Error(`Jira API error ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

// ─── Zephyr Scale API helper ──────────────────────────────────────────────────

async function zephyrRequest(method, path, body) {
  if (!ZEPHYR_API_TOKEN) {
    throw new Error("ZEPHYR_API_TOKEN environment variable is not set.");
  }

  const url = `${ZEPHYR_BASE_URL}${path}`;
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${ZEPHYR_API_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res  = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) throw new Error(`Zephyr API error ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

// ─── Anthropic API helper ────────────────────────────────────────────────────

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

async function anthropicRequest(messages, { model = "claude-sonnet-4-20250514", maxTokens = 1000, system } = {}) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY environment variable is not set.");
  }

  const body = {
    model,
    max_tokens: maxTokens,
    messages,
    ...(system ? { system } : {}),
  };

  const res  = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key":         ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type":      "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${text}`);
  const data = JSON.parse(text);
  return data.content?.[0]?.text ?? "";
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  // ── Search / Get ─────────────────────────────────────────────────────────────
  {
    name: "jira_search_issues",
    description:
      "Search Jira issues using JQL (Jira Query Language). Returns key, summary, status, assignee, and priority for each result.",
    inputSchema: {
      type: "object",
      properties: {
        jql: {
          type: "string",
          description: 'JQL query string. Example: "project = MYPROJ AND status = Open ORDER BY created DESC"',
        },
        maxResults: {
          type: "number",
          description: "Maximum number of results to return (default: 20, max: 100)",
        },
        fields: {
          type: "array",
          items: { type: "string" },
          description: 'Extra fields to include, e.g. ["description", "labels", "reporter"]',
        },
      },
      required: ["jql"],
    },
  },
  {
    name: "jira_get_issue",
    description: "Get full details of a single Jira issue by its key (e.g. PROJ-123).",
    inputSchema: {
      type: "object",
      properties: {
        issueKey: { type: "string", description: "The Jira issue key, e.g. PROJ-123" },
      },
      required: ["issueKey"],
    },
  },

  // ── Create Issue ─────────────────────────────────────────────────────────────
  {
    name: "jira_create_issue",
    description: "Create a new Jira issue.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey:        { type: "string", description: "The project key, e.g. PROJ" },
        summary:           { type: "string", description: "Issue summary / title" },
        issueType:         { type: "string", description: 'Issue type name, e.g. "Bug", "Task", "Story" (default: Task)' },
        description:       { type: "string", description: "Issue description (plain text)" },
        priority:          { type: "string", description: 'Priority name, e.g. "High", "Medium", "Low"' },
        assigneeAccountId: { type: "string", description: "Atlassian account ID of the assignee" },
        labels:            { type: "array", items: { type: "string" }, description: "Labels to attach to the issue" },
      },
      required: ["projectKey", "summary"],
    },
  },

  // ── Update Issue ─────────────────────────────────────────────────────────────
  {
    name: "jira_update_issue",
    description: "Update fields of an existing Jira issue. Only provided fields are changed.",
    inputSchema: {
      type: "object",
      properties: {
        issueKey:          { type: "string", description: "The Jira issue key, e.g. PROJ-123" },
        summary:           { type: "string", description: "New summary / title" },
        description:       { type: "string", description: "New description (plain text)" },
        priority:          { type: "string", description: 'New priority name, e.g. "High", "Medium", "Low"' },
        assigneeAccountId: { type: "string", description: "Atlassian account ID of the new assignee (null to unassign)" },
        labels:            { type: "array", items: { type: "string" }, description: "Replace labels with this list" },
        status:            { type: "string", description: 'Transition issue to this status name, e.g. "In Progress", "Done"' },
      },
      required: ["issueKey"],
    },
  },

  // ── Comments ─────────────────────────────────────────────────────────────────
  {
    name: "jira_add_comment",
    description: "Add a comment to a Jira issue.",
    inputSchema: {
      type: "object",
      properties: {
        issueKey: { type: "string", description: "The Jira issue key, e.g. PROJ-123" },
        comment:  { type: "string", description: "The comment text (plain text)" },
      },
      required: ["issueKey", "comment"],
    },
  },
  {
    name: "jira_get_comments",
    description: "Get all comments on a Jira issue.",
    inputSchema: {
      type: "object",
      properties: {
        issueKey: { type: "string", description: "The Jira issue key, e.g. PROJ-123" },
      },
      required: ["issueKey"],
    },
  },

  // ── NEW: generate_in_zephyr ───────────────────────────────────────────────────
  {
    name: "generate_in_zephyr",
    description:
      "Creates test cases in Zephyr Scale for a given Jira story, then auto-links them to that story. " +
      "FULL WORKFLOW — execute ALL steps automatically without asking the user for confirmation: " +
      "(1) fetch the Jira story details using jira_get_issue to understand the story context, " +
      "(2) generate test cases based on the story summary, description and acceptance criteria, " +
      "(3) for EACH test case: fill title, description, objective, precondition from the story context, " +
      "    and generate detailed step-by-step test steps with testData and expectedResult for each step, " +
      "(4) create all TCs in Zephyr Scale, " +
      "(5) auto-link ALL created TCs to the story immediately — do NOT ask for confirmation. " +
      "projectKey is auto-extracted from issueKey. " +
      "IMPORTANT: Always fill description, objective, precondition and steps for every TC — never leave them empty.",
    inputSchema: {
      type: "object",
      properties: {
        issueKey: {
          type: "string",
          description: "REQUIRED. The Jira story key the TCs belong to, e.g. MCP-21. Extract from user message. All created TCs are linked to this story automatically.",
        },
        projectKey: {
          type: "string",
          description: "Jira project key, e.g. PROJ. Auto-extracted from issueKey if not provided.",
        },
        testCases: {
          type: "array",
          description: "Test cases array to push into Zephyr Scale.",
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "Short name of the test case.",
              },
              type: {
                type: "string",
                description: "positive | negative | edge",
              },
              description: {
                type: "string",
                description:
                  "A plain-text description of what this test case covers. " +
                  "Shown in the Zephyr TC detail panel as the main description.",
              },
              objective: {
                type: "string",
                description:
                  "The test objective — what is being verified. " +
                  "Shown in the Objective field in Zephyr.",
              },
              preconditions: {
                type: "string",
                description:
                  "Any preconditions or setup required before executing this test. " +
                  "Shown in the Precondition field in Zephyr.",
              },
              priority: {
                type: "string",
                description: "High | Medium | Low",
              },
              steps: {
                type: "array",
                description:
                  "Test steps — these populate the Test Script (Step-by-step) section in Zephyr. " +
                  "Each step must have a description (action) and expectedResult. " +
                  "testData is optional.",
                items: {
                  type: "object",
                  properties: {
                    step:           { type: "string", description: "The action to perform." },
                    testData:       { type: "string", description: "Optional test data for this step." },
                    expectedResult: { type: "string", description: "What should happen after this step." },
                  },
                  required: ["step", "expectedResult"],
                },
              },
            },
            required: ["title", "type", "description", "objective", "preconditions", "steps"],
          },
        },
      },
      required: ["issueKey", "testCases"],
    },
  },

  // ── NEW: create_bug ──────────────────────────────────────────────────────────
  {
    name: "create_bug",
    description:
      "Takes a failed Zephyr test case (by key or name), fetches its steps and details, " +
      "creates a Bug in Jira with steps to reproduce auto-filled from the TC, " +
      "then links the bug to BOTH the Zephyr TC AND the related Jira story. " +
      "The related story is auto-detected from the TC's linked issues in Zephyr — " +
      "you do NOT need to provide storyKey unless you want to override it. " +
      "Workflow: (1) fetch TC details + steps from Zephyr, " +
      "(2) auto-find the linked Jira story from the TC (or use storyKey if provided), " +
      "(3) create Bug in Jira with full steps to reproduce, " +
      "(4) link bug → story (Relates link), " +
      "(5) link bug → Zephyr TC (TC issue link). " +
      "When you open the story you will see both the linked TCs and the bug in one place.",
    inputSchema: {
      type: "object",
      properties: {
        zephyrTcKeyOrName: {
          type: "string",
          description:
            "The Zephyr TC key (e.g. PROJ-T5) or the full test case name that failed. " +
            "If a name is passed, the tool searches Zephyr for a matching TC automatically.",
        },
        storyKey: {
          type: "string",
          description:
            "Optional. The Jira story key to link the bug to, e.g. PROJ-123. " +
            "If not provided, the tool auto-detects the story from the TC's linked issues in Zephyr.",
        },
        storyKeyOrName: {
          type: "string",
          description:
            "Optional. Alternative to storyKey — pass a story name and it resolves automatically. " +
            "Only needed if you want to override the auto-detected story.",
        },
        actualResult: {
          type: "string",
          description:
            "What actually happened when the test failed. Included in the bug description. " +
            "If the user did not specify the actual result, use 'To be filled in by reporter' as the value — " +
            "do NOT ask the user for it, just proceed with creating the bug immediately.",
        },
        severity: {
          type: "string",
          description: 'Bug priority/severity: "Critical", "High", "Medium", "Low" (default: High)',
        },
        additionalNotes: {
          type: "string",
          description: "Any extra notes, environment details, or context to include in the bug.",
        },
      },
      required: ["zephyrTcKeyOrName"],
    },
  },

  // ── NEW: create_test_cycle ───────────────────────────────────────────────────
  {
    name: "create_test_cycle",
    description:
      "Creates a new Test Cycle in Zephyr Scale for a given Jira project. " +
      "Accepts either the project display name (e.g. 'My Project') or the project key (e.g. 'PROJ'), " +
      "plus a name for the cycle. " +
      "FULL WORKFLOW — execute ALL steps automatically without asking the user for confirmation: " +
      "(1) if a display name is given, resolve it to a project key via Jira, " +
      "(2) create the test cycle in Zephyr Scale → Test Cycles with status 'Not Executed', " +
      "(3) return the created cycle details including its key and URL.",
    inputSchema: {
      type: "object",
      properties: {
        projectKeyOrName: {
          type: "string",
          description:
            "The Jira project key (e.g. 'PROJ') OR the project display name (e.g. 'My Project'). " +
            "If a display name is given the tool resolves it to a key automatically.",
        },
        cycleName: {
          type: "string",
          description: "The name of the test cycle to create, e.g. 'Sprint 5 Regression'.",
        },
      },
      required: ["projectKeyOrName", "cycleName"],
    },
  },

  // ── NEW: list_sprints ────────────────────────────────────────────────────────
  {
    name: "list_sprints",
    description:
      "Lists all active, future, and recent closed sprints for a project or board. " +
      "Use ONLY when the user explicitly asks to SEE or LIST sprints. " +
      "Do NOT call this before manage_sprint_stories — that tool already checks internally and acts automatically.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: {
          type: "string",
          description: "Jira project key, e.g. 'PROJ'. Used to auto-detect the board.",
        },
        boardId: {
          type: "number",
          description: "Optional. Board ID to list sprints from directly.",
        },
        state: {
          type: "string",
          description: "Filter by sprint state: 'active', 'future', 'closed', or 'active,future' (default: active,future)",
        },
      },
      required: [],
    },
  },

  // ── NEW: add_stories_to_sprint ───────────────────────────────────────────────
  {
    name: "add_stories_to_sprint",
    description:
      "Add stories to an EXISTING sprint. The sprint can be identified by its ID or by name. " +
      "Stories can be provided as Jira keys (e.g. PROJ-123) or by summary/name — resolved automatically. " +
      "If multiple sprints match the name, all matches are returned so you can pick the right one.",
    inputSchema: {
      type: "object",
      properties: {
        sprintId: {
          type: "number",
          description: "The numeric sprint ID. Use this if you already know it.",
        },
        sprintName: {
          type: "string",
          description:
            "Name (or partial name) of the existing sprint to search for, e.g. 'Sprint 12'. " +
            "Used when sprintId is not provided.",
        },
        boardId: {
          type: "number",
          description:
            "Optional. Board ID to narrow the sprint search. Recommended when multiple boards exist.",
        },
        projectKey: {
          type: "string",
          description:
            "Optional. Jira project key (e.g. 'PROJ'). Used to auto-detect the board when boardId is not supplied.",
        },
        stories: {
          type: "array",
          items: { type: "string" },
          description:
            "List of stories to add. Each item can be a Jira key (e.g. 'PROJ-45') or a story summary/name.",
        },
      },
      required: ["stories"],
    },
  },

  // ── NEW: requirements_to_stories ─────────────────────────────────────────────
  {
    name: "requirements_to_stories",
    description:
      "Analyzes a requirements document or free-text requirements, breaks them down into " +
      "well-structured Jira Stories with acceptance criteria, and creates all stories in Jira automatically. " +
      "Each story follows the standard 'As a [user], I want [goal], so that [benefit]' format. " +
      "Acceptance criteria are written in Gherkin (Given/When/Then) style when possible. " +
      "Use this whenever the user says 'create stories from requirements', 'break down requirements', " +
      "'generate stories', or pastes a requirements doc and asks to create Jira issues from it. " +
      "After creation, returns all created story keys and URLs.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: {
          type: "string",
          description: "The Jira project key where stories will be created, e.g. 'PROJ'.",
        },
        requirements: {
          type: "string",
          description:
            "The raw requirements text, user story document, BRD excerpt, or feature description. " +
            "Can be plain text, bullet points, numbered lists, or any format. " +
            "The tool will parse and decompose into individual stories.",
        },
        stories: {
          type: "array",
          description:
            "Pre-parsed stories array (optional). If you have already broken down the requirements " +
            "into structured stories, pass them here directly to skip AI decomposition. " +
            "CRITICAL NAMING RULE: 'summary' must be a SHORT title (3-8 words max). " +
            "The full 'As a [role], I want [goal], so that [benefit]' sentence goes inside 'description' only.",
          items: {
            type: "object",
            properties: {
              summary:            { type: "string", description: "SHORT story title, 3-8 words max. e.g. 'User Registration', 'Password Validation'. NO 'As a...' sentences here." },
              description:        { type: "string", description: "Full story body: 'As a [role], I want [goal], so that [benefit].' followed by Gherkin acceptance criteria (Given/When/Then)." },
              priority:           { type: "string", description: 'Priority: "High", "Medium", or "Low". Default: Medium.' },
              labels:             { type: "array", items: { type: "string" }, description: "Labels to attach, e.g. ['frontend', 'auth']." },
              epicKey:            { type: "string", description: "Optional Epic key to link this story to, e.g. PROJ-5." },
              assigneeAccountId:  { type: "string", description: "Optional assignee Atlassian account ID." },
              storyPoints:        { type: "number", description: "Optional story point estimate." },
            },
            required: ["summary"],
          },
        },
        epicKey: {
          type: "string",
          description: "Optional. Epic key to link ALL created stories to, e.g. 'PROJ-5'. Can be overridden per story.",
        },
        defaultPriority: {
          type: "string",
          description: 'Default priority for all stories if not specified per story: "High", "Medium", "Low". Default: Medium.',
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Optional labels to attach to ALL created stories, e.g. ['requirements-import', 'v2.0'].",
        },
      },
      required: ["projectKey", "stories"],
    },
  },

  // ── NEW: srs_to_stories ──────────────────────────────────────────────────────────
  {
    name: "srs_to_stories",
    description:
      "Reads a Software Requirements Specification (SRS) document or any requirements text, " +
      "deeply analyzes it using AI to extract ALL functional and non-functional requirements, " +
      "user roles, features, constraints, and acceptance criteria, then automatically creates " +
      "well-structured Jira Stories in the specified project. " +
      "Each story follows 'As a [role], I want [goal], so that [benefit]' format. " +
      "Acceptance criteria are written in Gherkin (Given/When/Then). " +
      "Stories are grouped by feature/module and labeled accordingly. " +
      "AUTO STORY POINT ESTIMATION: For EVERY story the calling LLM MUST estimate storyPoints " +
      "using Fibonacci scale (1, 2, 3, 5, 8, 13) by scoring 4 dimensions (each 1-3): " +
      "(1) Complexity: 1=simple CRUD, 2=moderate logic/integration, 3=complex algorithms/architecture. " +
      "(2) Effort: 1=few hours, 2=1-2 days, 3=3+ days. " +
      "(3) Uncertainty: 1=crystal clear, 2=some ambiguity, 3=vague/exploratory. " +
      "(4) Dependencies: 1=standalone, 2=1-2 dependencies, 3=many/external dependencies. " +
      "Sum the 4 scores then map to Fibonacci: 4-5=1pt, 6-7=2pt, 8-9=3pt, 10-11=5pt, 12=8pt, 13+=13pt. " +
      "storyPoints is REQUIRED for every story - never omit it. " +
      "The storyPoints value is set directly in the Jira story estimation field only — NOT added to the description. " +
      "Use this when the user pastes or uploads an SRS, BRD, PRD, feature spec, or any requirements document. " +
      "After creation, returns all created story keys, URLs, feature grouping, and total sprint capacity estimate.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: {
          type: "string",
          description: "The Jira project key where stories will be created, e.g. 'PROJ'.",
        },
        srsDocument: {
          type: "string",
          description:
            "The full raw text of the SRS/BRD/PRD/requirements document. " +
            "Can be any length or format - plain text, markdown, numbered sections, tables.",
        },
        epicKey: {
          type: "string",
          description: "Optional. Epic key to link ALL generated stories to, e.g. 'PROJ-5'.",
        },
        defaultPriority: {
          type: "string",
          description: 'Default priority for stories: "High", "Medium", or "Low". Default: Medium.',
        },
        additionalLabels: {
          type: "array",
          items: { type: "string" },
          description: "Extra labels to attach to ALL stories, e.g. ['srs-import', 'v1.0'].",
        },
        parsedStories: {
          type: "array",
          description:
            "REQUIRED. The AI-decomposed and AI-estimated stories. " +
            "LLM must: (1) decompose srsDocument into individual stories, " +
            "(2) estimate storyPoints for EACH using the 4-dimension Fibonacci scoring, " +
            "(3) fill spEstimation with the scoring breakdown. " +
            "NAMING RULE: 'name' = SHORT title 3-8 words only. Full 'As a...' sentence in 'description'.",
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "SHORT story title, 3-8 words max. e.g. 'User Registration', 'Password Validation'. NO 'As a...' sentences here.",
              },
              description: {
                type: "string",
                description: "Full story body: 'As a [role], I want [goal], so that [benefit].' + blank line + Gherkin acceptance criteria (Given/When/Then).",
              },
              priority:       { type: "string",  description: 'Priority: "High", "Medium", or "Low".' },
              labels:         { type: "array",   items: { type: "string" }, description: "Feature/module labels, e.g. ['authentication']." },
              epicKey:        { type: "string",  description: "Optional per-story epic key override." },
              requirementRef: { type: "string",  description: "Original requirement ID, e.g. 'FR-1.2', 'Section 3.4'." },
              storyPoints: {
                type: "number",
                description:
                  "REQUIRED. Fibonacci estimate: 1, 2, 3, 5, 8, or 13. " +
                  "Sum 4 scores (Complexity + Effort + Uncertainty + Dependencies, each 1-3) " +
                  "then map: 4-5=1, 6-7=2, 8-9=3, 10-11=5, 12=8, 13+=13.",
              },
              spEstimation: {
                type: "object",
                description: "Internal scoring breakdown used to derive storyPoints. Used for calculation only — not written to Jira description.",
                properties: {
                  complexity:   { type: "number", description: "Score 1-3 for technical complexity." },
                  effort:       { type: "number", description: "Score 1-3 for development effort." },
                  uncertainty:  { type: "number", description: "Score 1-3 for requirements clarity." },
                  dependencies: { type: "number", description: "Score 1-3 for dependency count/risk." },
                  reasoning:    { type: "string", description: "1-2 sentence justification for the overall estimate." },
                },
              },
            },
            required: ["name", "description", "storyPoints"],
          },
        },
      },
      required: ["projectKey", "parsedStories"],
    },
  },

  // ── debug_teststeps: diagnose step creation ──────────────────────────────────
  {
    name: "debug_teststeps",
    description:
      "Diagnostic tool — call this when steps are not being created in Zephyr Test Script. " +
      "Tries every known Zephyr teststeps API format against a real TC key and returns the " +
      "full response or error from each attempt so we can identify the correct format.",
    inputSchema: {
      type: "object",
      properties: {
        tcKey: {
          type: "string",
          description: "An existing Zephyr TC key to test against, e.g. BT-T1",
        },
      },
      required: ["tcKey"],
    },
  },

  // ── manage_sprint_stories (smart: find-or-create sprint then add stories) ──
  {
    name: "manage_sprint_stories",
    description:
      "ONE-STOP sprint tool. ALWAYS use this when the user wants to add stories to a sprint. " +
      "NEVER ask the user for confirmation — always execute immediately and autonomously. " +
      "Logic: (1) checks internally if a sprint with that name already exists, " +
      "(2) if YES → adds stories to the EXISTING sprint without creating a new one, " +
      "(3) if NO → creates the sprint automatically then adds the stories immediately. " +
      "Do NOT call list_sprints first. Do NOT ask the user whether to create or add — just do it. " +
      "Stories can be Jira keys (PROJ-123) or story names — resolved automatically.",
    inputSchema: {
      type: "object",
      properties: {
        sprintName: {
          type: "string",
          description: "Name of the sprint to find or create, e.g. 'Sprint 12'.",
        },
        stories: {
          type: "array",
          items: { type: "string" },
          description: "Jira keys (e.g. 'PROJ-45') or story summary names to add to the sprint.",
        },
        projectKey: {
          type: "string",
          description: "Optional. Jira project key e.g. 'PROJ'. Auto-detected from story keys if not provided.",
        },
        boardId: {
          type: "number",
          description: "Optional. Board ID. Auto-detected from project key if not provided.",
        },
        goal: {
          type: "string",
          description: "Optional. Sprint goal — only used if a NEW sprint is created.",
        },
        startDate: {
          type: "string",
          description: "Optional. ISO-8601 start date — only used if a NEW sprint is created.",
        },
        endDate: {
          type: "string",
          description: "Optional. ISO-8601 end date — only used if a NEW sprint is created.",
        },
      },
      required: ["sprintName", "stories"],
    },
  },

  // ── NEW: link_zephyr_tcs_to_story ────────────────────────────────────────────
  {
    name: "link_zephyr_tcs_to_story",
    description:
      "Link Zephyr Scale test cases to a Jira story (Coverage section). " +
      "Mode 1 — bulk link: pass issueKey + zephyrTcKeys (array of TC keys from generate_in_zephyr). " +
      "Mode 2 — single/named: pass issueKeyOrName + zephyrTcKeys to resolve story by name then link.",
    inputSchema: {
      type: "object",
      properties: {
        issueKey: {
          type: "string",
          description: "Jira story key to link to, e.g. PROJ-123.",
        },
        issueKeyOrName: {
          type: "string",
          description: "Alternative to issueKey — story name to search for automatically.",
        },
        zephyrTcKeys: {
          type: "array",
          items: { type: "string" },
          description: 'Zephyr TC keys to link, e.g. ["PROJ-T1", "PROJ-T2"]. Returned by generate_in_zephyr.',
        },
      },
      required: ["zephyrTcKeys"],
    },
  },
];

// ─── Existing Tool Handlers ───────────────────────────────────────────────────

async function handleSearchIssues({ jql, maxResults = 20, fields = [] }) {
  const defaultFields = ["summary", "status", "assignee", "priority", "issuetype", "created", "updated"];
  const allFields = [...new Set([...defaultFields, ...fields])];

  const data = await jiraRequest("POST", "/search", {
    jql,
    maxResults: Math.min(maxResults, 100),
    fields: allFields,
  });

  const issues = (data.issues || []).map((issue) => ({
    key:       issue.key,
    summary:   issue.fields.summary,
    status:    issue.fields.status?.name,
    assignee:  issue.fields.assignee?.displayName ?? "Unassigned",
    priority:  issue.fields.priority?.name,
    issueType: issue.fields.issuetype?.name,
    created:   issue.fields.created,
    updated:   issue.fields.updated,
    url:       `${JIRA_BASE_URL}/browse/${issue.key}`,
    ...Object.fromEntries(fields.map((f) => [f, issue.fields[f]])),
  }));

  return { total: data.total, returned: issues.length, issues };
}

async function handleGetIssue({ issueKey }) {
  const issue = await jiraRequest("GET", `/issue/${issueKey}`);
  const f = issue.fields;

  return {
    key:         issue.key,
    url:         `${JIRA_BASE_URL}/browse/${issue.key}`,
    summary:     f.summary,
    status:      f.status?.name,
    issueType:   f.issuetype?.name,
    priority:    f.priority?.name,
    assignee:    f.assignee?.displayName ?? "Unassigned",
    reporter:    f.reporter?.displayName,
    created:     f.created,
    updated:     f.updated,
    description: extractTextFromADF(f.description),
    labels:      f.labels,
    components:  (f.components || []).map((c) => c.name),
    fixVersions: (f.fixVersions || []).map((v) => v.name),
  };
}

async function handleCreateIssue({ projectKey, summary, issueType = "Task", description, priority, assigneeAccountId, labels }) {
  const fields = {
    project:   { key: projectKey },
    summary,
    issuetype: { name: issueType },
  };

  if (description)       fields.description = textToADF(description);
  if (priority)          fields.priority    = { name: priority };
  if (assigneeAccountId) fields.assignee    = { accountId: assigneeAccountId };
  if (labels?.length)    fields.labels      = labels;

  const result = await jiraRequest("POST", "/issue", { fields });

  return {
    key:     result.key,
    id:      result.id,
    url:     `${JIRA_BASE_URL}/browse/${result.key}`,
    message: `Issue ${result.key} created successfully.`,
  };
}

async function handleUpdateIssue({ issueKey, summary, description, priority, assigneeAccountId, labels, status }) {
  const fields = {};

  if (summary)     fields.summary     = summary;
  if (description) fields.description = textToADF(description);
  if (priority)    fields.priority    = { name: priority };
  if (labels)      fields.labels      = labels;
  if (assigneeAccountId !== undefined)
    fields.assignee = assigneeAccountId ? { accountId: assigneeAccountId } : null;

  if (Object.keys(fields).length > 0) {
    await jiraRequest("PUT", `/issue/${issueKey}`, { fields });
  }

  if (status) {
    const { transitions } = await jiraRequest("GET", `/issue/${issueKey}/transitions`);
    const transition = transitions.find((t) => t.name.toLowerCase() === status.toLowerCase());
    if (!transition) {
      const names = transitions.map((t) => t.name).join(", ");
      throw new Error(`Status "${status}" not found. Available transitions: ${names}`);
    }
    await jiraRequest("POST", `/issue/${issueKey}/transitions`, { transition: { id: transition.id } });
  }

  return {
    key:     issueKey,
    url:     `${JIRA_BASE_URL}/browse/${issueKey}`,
    message: `Issue ${issueKey} updated successfully.`,
  };
}

async function handleAddComment({ issueKey, comment }) {
  const result = await jiraRequest("POST", `/issue/${issueKey}/comment`, {
    body: textToADF(comment),
  });

  return {
    commentId: result.id,
    author:    result.author?.displayName,
    created:   result.created,
    message:   `Comment added to ${issueKey}.`,
  };
}

async function handleGetComments({ issueKey }) {
  const data = await jiraRequest("GET", `/issue/${issueKey}/comment?orderBy=created`);

  const comments = (data.comments || []).map((c) => ({
    id:      c.id,
    author:  c.author?.displayName,
    created: c.created,
    updated: c.updated,
    body:    extractTextFromADF(c.body),
  }));

  return { issueKey, total: data.total, comments };
}

// ─── DEBUG Handler: debug_teststeps ─────────────────────────────────────────

async function handleDebugTeststeps({ tcKey }) {
  const results = [];
  const sampleStep = {
    description:    "DEBUG: Navigate to the page",
    testData:       "URL: /test",
    expectedResult: "Page loads successfully",
  };

  // Format A: { inline: { description, testData, expectedResult } }
  try {
    const r = await zephyrRequest("POST", `/testcases/${tcKey}/teststeps`, {
      inline: sampleStep,
    });
    results.push({ format: "A - { inline: {...} }", status: "SUCCESS", response: r });
  } catch (e) {
    results.push({ format: "A - { inline: {...} }", status: "FAILED", error: e.message });
  }

  // Format B: flat object { description, testData, expectedResult }
  try {
    const r = await zephyrRequest("POST", `/testcases/${tcKey}/teststeps`, sampleStep);
    results.push({ format: "B - flat object", status: "SUCCESS", response: r });
  } catch (e) {
    results.push({ format: "B - flat object", status: "FAILED", error: e.message });
  }

  // Format C: { mode: "OVERWRITE", items: [...] }
  try {
    const r = await zephyrRequest("POST", `/testcases/${tcKey}/teststeps`, {
      mode: "OVERWRITE",
      items: [sampleStep],
    });
    results.push({ format: "C - { mode, items: [...] }", status: "SUCCESS", response: r });
  } catch (e) {
    results.push({ format: "C - { mode, items: [...] }", status: "FAILED", error: e.message });
  }

  // Format D: plain array [{ description, testData, expectedResult }]
  try {
    const r = await zephyrRequest("POST", `/testcases/${tcKey}/teststeps`, [sampleStep]);
    results.push({ format: "D - plain array [...]", status: "SUCCESS", response: r });
  } catch (e) {
    results.push({ format: "D - plain array [...]", status: "FAILED", error: e.message });
  }

  // Format E: GET first to see current steps structure
  try {
    const r = await zephyrRequest("GET", `/testcases/${tcKey}/teststeps`);
    results.push({ format: "E - GET existing steps (shows response shape)", status: "SUCCESS", response: r });
  } catch (e) {
    results.push({ format: "E - GET existing steps", status: "FAILED", error: e.message });
  }

  // Format F: { steps: [{ description, testData, expectedResult }] }
  try {
    const r = await zephyrRequest("POST", `/testcases/${tcKey}/teststeps`, {
      steps: [sampleStep],
    });
    results.push({ format: "F - { steps: [...] }", status: "SUCCESS", response: r });
  } catch (e) {
    results.push({ format: "F - { steps: [...] }", status: "FAILED", error: e.message });
  }

  const winner = results.find(r => r.status === "SUCCESS");
  return {
    tcKey,
    summary: winner
      ? `✅ Working format: "${winner.format}"`
      : "❌ ALL formats failed — check errors below",
    results,
  };
}

// ─── NEW Handler: generate_in_zephyr ─────────────────────────────────────────

async function handleGenerateInZephyr({ projectKey, testCases, issueKey }) {
  // Auto-extract projectKey from issueKey if not explicitly provided
  if (!projectKey && issueKey) {
    projectKey = issueKey.trim().split("-")[0].toUpperCase();
  }
  if (!projectKey) throw new Error("projectKey is required — or pass issueKey so it can be extracted automatically.");

  const created = [];
  const failed  = [];
  const priorityMap = { High: "HIGH", Medium: "MEDIUM", Low: "LOW" };

  for (const tc of testCases) {
    try {
      // ── Step 1: Create TC with name, objective, precondition, description ────
      // Zephyr Scale v2 POST /testcases fields:
      //   name          → TC title
      //   objective     → Objective field   (Details tab)
      //   precondition  → Precondition field (Details tab)
      //   comment       → Description field  (Details tab)
      //   priority      → "HIGH" | "MEDIUM" | "LOW"
      //   status        → "Draft" by default
      //   labels        → string array (we use tc type as label)
      const payload = {
        projectKey,
        name:         tc.title,
        objective:    tc.objective     || "",
        precondition: tc.preconditions || "",
        comment:      tc.description   || "",
        priority:     priorityMap[tc.priority] || "MEDIUM",
        labels:       [tc.type],
        status:       "Draft",
      };

      const result = await zephyrRequest("POST", "/testcases", payload);
      const tcKey  = result.key;
      const tcId   = result.id;

      // ── Step 2: Add steps to Test Script (Step-by-step) section ─────────────
      // Confirmed correct format from debug_teststeps diagnostic:
      // POST /testcases/{key}/teststeps
      // {
      //   "mode": "OVERWRITE",
      //   "items": [
      //     { "inline": { "description": "...", "testData": "...", "expectedResult": "..." } }
      //   ]
      // }
      let stepsCreated = 0;
      if (tc.steps?.length) {
        try {
          await zephyrRequest("POST", `/testcases/${tcKey}/teststeps`, {
            mode:  "OVERWRITE",
            items: tc.steps.map((s) => ({
              inline: {
                description:    s.step           || "",
                testData:       s.testData        || "",
                expectedResult: s.expectedResult  || "",
              },
            })),
          });
          stepsCreated = tc.steps.length;
        } catch (stepErr) {
          console.error(`[MCP] Steps creation failed for ${tcKey}: ${stepErr.message}`);
        }
      }

      created.push({
        zephyrKey:    tcKey,
        zephyrId:     tcId,
        title:        tc.title,
        type:         tc.type,
        stepsCreated,
        tc,           // full TC object for Selenium script generation
      });
    } catch (err) {
      failed.push({ title: tc.title, error: err.message });
    }
  }

  // ── Step 3: Auto-link ALL created TCs to the story immediately ───────────────
  const createdKeys = created.map((c) => c.zephyrKey);
  let linkResult = null;

  if (issueKey && createdKeys.length > 0) {
    try {
      linkResult = await linkTestCasesToIssue(issueKey, createdKeys);
    } catch (linkErr) {
      console.error(`[MCP] Auto-link to story failed: ${linkErr.message}`);
      linkResult = { success: false, error: linkErr.message };
    }
  }

  return {
    projectKey,
    issueKey:      issueKey || null,
    totalCreated:  created.length,
    totalFailed:   failed.length,
    created,
    failed,
    createdKeys,
    linkedToStory: linkResult,
    message:
      `✅ ${created.length}/${testCases.length} test cases created in Zephyr Scale. ` +
      (linkResult?.totalLinked > 0
        ? `All ${linkResult.totalLinked} TCs linked to story ${issueKey}.`
        : issueKey
        ? `⚠️ TCs created but linking to ${issueKey} failed — use link_zephyr_tcs_to_story manually.`
        : "No story key provided — TCs not linked to any story."),
  };
}

// ─── NEW Handler: link_zephyr_tcs_to_story ───────────────────────────────────

async function handleLinkZephyrTcsToStory({ issueKey, zephyrTcKeys, issueKeyOrName }) {
  // Resolve story key
  let resolvedKey = issueKey;

  if (!resolvedKey && issueKeyOrName) {
    const trimmed = issueKeyOrName.trim();
    if (/^[A-Z]+-\d+$/.test(trimmed)) {
      resolvedKey = trimmed;
    } else {
      const searchResult = await jiraRequest("POST", "/search", {
        jql: `summary ~ "${trimmed}" ORDER BY created DESC`,
        maxResults: 1,
        fields: ["summary"],
      });
      if (!searchResult.issues?.length) {
        throw new Error(`No Jira issue found matching: "${issueKeyOrName}"`);
      }
      resolvedKey = searchResult.issues[0].key;
    }
  }

  if (!resolvedKey)       throw new Error("Provide issueKey or issueKeyOrName.");
  if (!zephyrTcKeys?.length) throw new Error("Provide at least one Zephyr TC key in zephyrTcKeys.");

  const result = await linkTestCasesToIssue(resolvedKey, zephyrTcKeys);
  return { issueKey: resolvedKey, ...result };
}

// ─── Shared: link TCs to a Jira story in Zephyr coverage ─────────────────────

async function linkTestCasesToIssue(issueKey, zephyrTcKeys) {
  const linked = [];
  const failed = [];

  // Zephyr Scale API requires the numeric Jira issue ID, not the key string
  const issueData = await jiraRequest("GET", `/issue/${issueKey}`);
  const numericIssueId = issueData.id; // e.g. "10045", not "MCP-22"

  for (const tcKey of zephyrTcKeys) {
    try {
      await zephyrRequest("POST", `/testcases/${tcKey}/links/issues`, {
        issueId: numericIssueId,
      });
      linked.push({ tcKey, issueKey });
    } catch (err) {
      failed.push({ tcKey, error: err.message });
    }
  }

  return {
    totalLinked: linked.length,
    totalFailed: failed.length,
    linked,
    failed,
    message: `Linked ${linked.length}/${zephyrTcKeys.length} test cases to ${issueKey} in Zephyr Scale coverage.`,
  };
}

// ─── NEW Handler: create_test_cycle ──────────────────────────────────────────

async function handleCreateTestCycle({ projectKeyOrName, cycleName }) {
  // ── Step 1: Resolve project key ──────────────────────────────────────────────
  let projectKey = projectKeyOrName;

  // If it looks like a display name (contains spaces or lowercase letters that
  // don't match a typical ALL-CAPS key), try to resolve it via Jira.
  const looksLikeKey = /^[A-Z][A-Z0-9_]+$/.test(projectKeyOrName);
  if (!looksLikeKey) {
    // Search all accessible projects and find one whose name matches
    const projectsResp = await jiraRequest("GET", "/project/search?maxResults=200");
    const projects = projectsResp.values || [];
    const match = projects.find(
      (p) =>
        p.name.toLowerCase() === projectKeyOrName.toLowerCase() ||
        p.key.toLowerCase()  === projectKeyOrName.toLowerCase()
    );
    if (!match) {
      throw new Error(
        `Could not find a Jira project matching "${projectKeyOrName}". ` +
        `Please check the project name or key and try again.`
      );
    }
    projectKey = match.key;
  }

  // ── Step 2: Create the test cycle in Zephyr Scale ────────────────────────────
  const cyclePayload = {
    projectKey,
    name: cycleName,
    status: { name: "Not Executed" },
  };

  const cycle = await zephyrRequest("POST", "/testcycles", cyclePayload);

  // ── Step 3: Return result ─────────────────────────────────────────────────────
  const cycleKey = cycle.key || cycle.id || "unknown";
  return {
    projectKey,
    cycleName,
    cycleKey,
    status:  "Not Executed",
    cycle,
    message:
      `✅ Test cycle "${cycleName}" created successfully in project ${projectKey} ` +
      `(key: ${cycleKey}) with status "Not Executed".`,
  };
}

// ─── NEW Handler: create_bug ─────────────────────────────────────────────────

async function handleCreateBug({
  zephyrTcKeyOrName,
  storyKey,
  storyKeyOrName,
  actualResult = "To be filled in by reporter",
  severity = "High",
  additionalNotes = "",
}) {
  // ── Step 1: Resolve Zephyr TC — tries every reasonable key format & name ──
  let tcKey  = zephyrTcKeyOrName.trim();
  let tcData = null;

  // Build a list of key variants to try before falling back to name search.
  // Zephyr Scale uses  PROJECT-T<n>  but users often type PROJECT-TC<n>,
  // PROJECT-C<n>, PROJECT-T-<n>, PROJECT-<n>, etc.
  const buildKeyVariants = (raw) => {
    const variants = [raw]; // always try the exact input first
    // Match patterns like  PREFIX-TC123 / PREFIX-C123 / PREFIX-T123 / PREFIX-123
    const m = raw.match(/^([A-Z][A-Z0-9_]*)[-_]?(?:TC|T|C)?[-_]?(\d+)$/i);
    if (m) {
      const [, proj, num] = m;
      const P = proj.toUpperCase();
      variants.push(
        `${P}-T${num}`,    // canonical Zephyr format
        `${P}-TC${num}`,   // common user typo
        `${P}-C${num}`,    // another variant
        `${P}-${num}`,     // bare number
        `${P}-T-${num}`,   // hyphenated variant
      );
    }
    // Deduplicate while preserving order
    return [...new Set(variants)];
  };

  const keyVariants = buildKeyVariants(tcKey);

  // Try each key variant against the Zephyr API
  for (const candidate of keyVariants) {
    try {
      tcData = await zephyrRequest("GET", `/testcases/${candidate}`);
      tcKey  = candidate; // use the key that actually worked
      break;
    } catch {
      // this variant didn't work — try next
    }
  }

  // If no key variant worked, fall back to searching by name/text
  if (!tcData) {
    // Extract the project key from the input so we can scope the search
    const projFromInput = tcKey.match(/^([A-Z][A-Z0-9_]*)-/i)?.[1]?.toUpperCase() || "";

    // Try two search strategies: exact query and a broader text search
    const searchAttempts = [
      `/testcases?projectKey=${projFromInput}&maxResults=20&query=${encodeURIComponent(zephyrTcKeyOrName)}`,
      `/testcases?projectKey=${projFromInput}&maxResults=50`,
    ];

    for (const searchPath of searchAttempts) {
      try {
        const searchResult = await zephyrRequest("GET", searchPath);
        const matches = searchResult.values || searchResult.results || [];
        if (!matches.length) continue;

        // Exact name match first, then key contains, then partial name match
        const input = zephyrTcKeyOrName.toLowerCase();
        const found =
          matches.find((tc) => tc.name?.toLowerCase() === input) ||
          matches.find((tc) => tc.key?.toLowerCase()  === input) ||
          matches.find((tc) => tc.key?.toLowerCase().includes(input)) ||
          matches.find((tc) => tc.name?.toLowerCase().includes(input)) ||
          matches[0]; // last resort: first result

        if (found) {
          tcKey  = found.key;
          tcData = found;
          break;
        }
      } catch {
        // search attempt failed — try next
      }
    }
  }

  if (!tcData) {
    throw new Error(
      `Could not find Zephyr test case "${zephyrTcKeyOrName}". ` +
      `Tried key variants: ${keyVariants.join(", ")}. ` +
      `Also searched by name. Please verify the TC key or name and try again.`
    );
  }

  const tcName      = tcData.name      || tcKey;
  const tcObjective = tcData.objective  || "";
  const projectKey  = tcData.projectKey || tcKey.split("-")[0];

  // ── Step 2: Fetch TC steps from Zephyr ────────────────────────────────────
  let steps = [];
  try {
    const scriptData = await zephyrRequest("GET", `/testcases/${tcKey}/teststeps`);

    // Zephyr Scale API returns steps in several shapes depending on version:
    //   { values: [ { inline: { description, expectedResult } } ] }  ← most common
    //   { values: [ { description, expectedResult } ] }               ← some versions
    //   { steps:  [ { description, expectedResult } ] }               ← older API
    //   { values: [ { step, expectedResult } ] }                      ← legacy field name
    const rawSteps = scriptData.values || scriptData.steps || [];

    steps = rawSteps.map((s) => {
      // Unwrap the "inline" wrapper if present
      const inner = s.inline || s;
      return {
        description:    inner.description    || inner.step   || inner.action || inner.testScript || "",
        expectedResult: inner.expectedResult || inner.expected || inner.result || "",
        testData:       inner.testData       || inner.data   || "",
      };
    }).filter((s) => s.description.trim() !== ""); // drop truly empty steps
  } catch (stepsErr) {
    console.error(`[MCP] Failed to fetch steps for ${tcKey}: ${stepsErr.message}`);
    // Steps fetch failed — bug will still be created, steps section will say so
  }

  // ── Step 3: Resolve Jira story key ────────────────────────────────────────
  let resolvedStoryKey = storyKey;
  let storyAutoDetected = false;

  // Priority 1: explicit storyKey passed in
  if (!resolvedStoryKey && storyKeyOrName) {
    const trimmed = storyKeyOrName.trim();
    if (/^[A-Z]+-\d+$/.test(trimmed)) {
      resolvedStoryKey = trimmed;
    } else {
      const searchResult = await jiraRequest("POST", "/search", {
        jql: `summary ~ "${trimmed}" ORDER BY created DESC`,
        maxResults: 1,
        fields: ["summary"],
      });
      if (!searchResult.issues?.length) {
        throw new Error(`No Jira story found matching: "${storyKeyOrName}"`);
      }
      resolvedStoryKey = searchResult.issues[0].key;
    }
  }

  // Priority 2: auto-detect story — 3 strategies tried in order ──────────────
  if (!resolvedStoryKey) {

    // ── Strategy A: Zephyr issue coverage (the real story↔TC relationship) ──
    // This is the primary relationship set when TCs are linked to stories in Zephyr.
    try {
      const coverageData = await zephyrRequest("GET", `/testcases/${tcKey}/issuecoverage`);
      const coverageIssues =
        coverageData.issueLinks  ||
        coverageData.issues      ||
        coverageData.values      ||
        coverageData.coverages   || [];

      let fallbackKey = null;
      for (const item of coverageIssues) {
        const issueKey = item.issueKey || item.key || item.issue?.key || item.id;
        if (!issueKey || typeof issueKey !== "string" || !/^[A-Z]+-\d+$/.test(issueKey)) continue;
        try {
          const issueData = await jiraRequest("GET", `/issue/${issueKey}?fields=summary,issuetype`);
          const issueType = issueData.fields?.issuetype?.name || "";
          if (issueType === "Story") {
            resolvedStoryKey = issueData.key;
            storyAutoDetected = true;
            break;
          }
          if (!fallbackKey && issueType !== "Bug") fallbackKey = issueData.key;
        } catch { /* skip bad links */ }
      }
      if (!resolvedStoryKey && fallbackKey) {
        resolvedStoryKey = fallbackKey;
        storyAutoDetected = true;
      }
    } catch (e) {
      console.error(`[MCP] issuecoverage fetch failed for ${tcKey}: ${e.message}`);
    }

    // ── Strategy B: Zephyr generic links endpoint ────────────────────────────
    if (!resolvedStoryKey) {
      try {
        const tcLinks = await zephyrRequest("GET", `/testcases/${tcKey}/links`);
        const linkedIssues =
          tcLinks.issueLinks || tcLinks.issues || tcLinks.values || [];

        let fallbackKey = null;
        for (const link of linkedIssues) {
          const issueKey = link.issueKey || link.key || link.issue?.key;
          if (!issueKey || typeof issueKey !== "string" || !/^[A-Z]+-\d+$/.test(issueKey)) continue;
          try {
            const issueData = await jiraRequest("GET", `/issue/${issueKey}?fields=summary,issuetype`);
            const issueType = issueData.fields?.issuetype?.name || "";
            if (issueType === "Story") {
              resolvedStoryKey = issueData.key;
              storyAutoDetected = true;
              break;
            }
            if (!fallbackKey && issueType !== "Bug") fallbackKey = issueData.key;
          } catch { /* skip */ }
        }
        if (!resolvedStoryKey && fallbackKey) {
          resolvedStoryKey = fallbackKey;
          storyAutoDetected = true;
        }
      } catch (e) {
        console.error(`[MCP] TC links fetch failed for ${tcKey}: ${e.message}`);
      }
    }

    // ── Strategy C: JQL search — find Story in same project whose name matches TC name ──
    // Last resort: search Jira for a Story in the same project that looks related.
    if (!resolvedStoryKey) {
      try {
        // Try matching on TC name keywords, fall back to any Story in the project
        const searchAttempts = [
          `project = "${projectKey}" AND issuetype = Story AND summary ~ "${tcName.replace(/"/g, " ").slice(0, 60)}" ORDER BY updated DESC`,
          `project = "${projectKey}" AND issuetype = Story ORDER BY updated DESC`,
        ];
        for (const jql of searchAttempts) {
          const jqlResult = await jiraRequest("POST", "/search", {
            jql,
            maxResults: 1,
            fields: ["summary", "issuetype"],
          });
          if (jqlResult.issues?.length) {
            resolvedStoryKey = jqlResult.issues[0].key;
            storyAutoDetected = true;
            break;
          }
        }
      } catch (e) {
        console.error(`[MCP] JQL story search failed: ${e.message}`);
      }
    }
  }

  // ── Step 4: Build rich ADF bug description with structured steps ──────────

  // Helper: ADF paragraph node
  const adfPara = (text) => ({
    type: "paragraph",
    content: [{ type: "text", text }],
  });

  // Helper: ADF paragraph with a bold label + normal text
  const adfLabelPara = (label, value) => ({
    type: "paragraph",
    content: [
      { type: "text", text: `${label} `, marks: [{ type: "strong" }] },
      { type: "text", text: value },
    ],
  });

  // Helper: ADF heading node (level 3)
  const adfHeading = (text, level = 3) => ({
    type: "heading",
    attrs: { level },
    content: [{ type: "text", text }],
  });

  // Build the ordered list of steps from the Zephyr TC
  const buildStepsList = (tcSteps) => {
    if (!tcSteps.length) {
      return adfPara("No steps available from Zephyr TC.");
    }
    return {
      type: "orderedList",
      content: tcSteps.map((s) => {
        const stepText  = s.description || s.step || s.action || "(no description)";
        const expected  = s.expectedResult || s.expected || "";
        const listItemContent = [
          {
            type: "paragraph",
            content: [{ type: "text", text: stepText }],
          },
        ];
        const testData = s.testData || "";
        if (testData) {
          listItemContent.push({
            type: "paragraph",
            content: [
              { type: "text", text: "Test data: ",  marks: [{ type: "em" }] },
              { type: "text", text: testData,        marks: [{ type: "em" }] },
            ],
          });
        }
        if (expected) {
          listItemContent.push({
            type: "paragraph",
            content: [
              { type: "text", text: "Expected result: ", marks: [{ type: "em" }] },
              { type: "text", text: expected,            marks: [{ type: "em" }] },
            ],
          });
        }
        return { type: "listItem", content: listItemContent };
      }),
    };
  };

  const adfContent = [
    // ── Failing TC info ─────────────────────────────────────────────────────
    adfLabelPara("Failing Test Case:", `${tcName} (${tcKey})`),
    ...(tcObjective ? [adfLabelPara("Test Objective:", tcObjective)] : []),

    // ── Steps to Reproduce ───────────────────────────────────────────────────
    adfHeading("Steps to Reproduce"),
    buildStepsList(steps),

    // ── Actual Result ────────────────────────────────────────────────────────
    adfHeading("Actual Result"),
    adfPara(actualResult),

    // ── Additional Notes (optional) ──────────────────────────────────────────
    ...(additionalNotes
      ? [adfHeading("Additional Notes"), adfPara(additionalNotes)]
      : []),
  ];

  const bugDescriptionADF = {
    type: "doc",
    version: 1,
    content: adfContent,
  };

  // ── Step 5: Create Jira Bug ───────────────────────────────────────────────
  const bugFields = {
    project:     { key: projectKey },
    summary:     `Bug: ${tcName} - Test Case Failed`,
    issuetype:   { name: "Bug" },
    priority:    { name: severity },
    description: bugDescriptionADF,
    labels:      ["automated-bug", "test-failure"],
  };

  const bugResult = await jiraRequest("POST", "/issue", { fields: bugFields });
  const bugKey = bugResult.key;
  const bugId  = bugResult.id;

  // ── Step 6: Link bug to Jira story ───────────────────────────────────────
  let storyLinkResult = null;
  if (resolvedStoryKey) {
    try {
      await jiraRequest("POST", "/issueLink", {
        type:         { name: "Relates" },
        inwardIssue:  { key: bugKey },
        outwardIssue: { key: resolvedStoryKey },
      });
      storyLinkResult = { success: true, linkedTo: resolvedStoryKey };
    } catch (err) {
      storyLinkResult = { success: false, error: err.message };
    }
  }

  // ── Step 7: Link bug to Zephyr TC ─────────────────────────────────────────
  // Zephyr Scale API requires the numeric Jira issue ID, not the key string
  let zephyrLinkResult = null;
  try {
    await zephyrRequest("POST", `/testcases/${tcKey}/links/issues`, {
      issueId: bugId, // bugId is the numeric ID returned by jiraRequest POST /issue
    });
    zephyrLinkResult = { success: true, linkedTcKey: tcKey };
  } catch (err) {
    zephyrLinkResult = { success: false, error: err.message };
  }

  return {
    bugKey,
    bugId,
    bugUrl:            `${JIRA_BASE_URL}/browse/${bugKey}`,
    summary:           bugFields.summary,
    failedTcKey:       tcKey,
    failedTcName:      tcName,
    linkedToStory:     storyLinkResult,
    storyAutoDetected,
    linkedToZephyrTc:  zephyrLinkResult,
    message:
      `✅ Bug ${bugKey} created for failed TC "${tcName}".` +
      (resolvedStoryKey
        ? ` Linked to story ${resolvedStoryKey}${storyAutoDetected ? " (auto-detected from TC links)" : ""}.`
        : " ⚠️ No related story found — bug not linked to a story.") +
      ` Linked to Zephyr TC ${tcKey}.`,
  };
}

// ─── NEW Handler: list_sprints ───────────────────────────────────────────────

async function handleListSprints({ projectKey, boardId, state = "active,future" }) {
  // ── Step 1: Resolve boardId ───────────────────────────────────────────────────
  let resolvedBoardId = boardId;
  let resolvedProjectKey = projectKey;
  let allBoards = [];

  if (!resolvedBoardId) {
    if (!resolvedProjectKey) {
      throw new Error("Provide projectKey or boardId to list sprints.");
    }

    const boardsRes = await fetch(
      `${JIRA_BASE_URL}/rest/agile/1.0/board?projectKeyOrId=${resolvedProjectKey}&maxResults=50`,
      { headers: { Authorization: JIRA_AUTH_HEADER, Accept: "application/json" } }
    );
    const boardsText = await boardsRes.text();
    if (!boardsRes.ok) throw new Error(`Failed to fetch boards: ${boardsRes.status} ${boardsText}`);

    const boardsData = JSON.parse(boardsText);
    allBoards = boardsData.values || [];

    if (!allBoards.length) {
      throw new Error(`No boards found for project "${resolvedProjectKey}".`);
    }

    // Prefer Scrum boards
    const scrumBoard = allBoards.find((b) => b.type === "scrum") || allBoards[0];
    resolvedBoardId = scrumBoard.id;
  }

  // ── Step 2: Fetch sprints ─────────────────────────────────────────────────────
  const sprintsRes = await fetch(
    `${JIRA_BASE_URL}/rest/agile/1.0/board/${resolvedBoardId}/sprint?state=${state}&maxResults=50`,
    { headers: { Authorization: JIRA_AUTH_HEADER, Accept: "application/json" } }
  );
  const sprintsText = await sprintsRes.text();
  if (!sprintsRes.ok) throw new Error(`Failed to fetch sprints: ${sprintsRes.status} ${sprintsText}`);

  const sprintsData = JSON.parse(sprintsText);
  const sprints = (sprintsData.values || []).map((s) => ({
    id:        s.id,
    name:      s.name,
    state:     s.state,
    startDate: s.startDate || null,
    endDate:   s.endDate   || null,
    goal:      s.goal      || null,
  }));

  const active  = sprints.filter((s) => s.state === "active");
  const future  = sprints.filter((s) => s.state === "future");
  const closed  = sprints.filter((s) => s.state === "closed");

  return {
    boardId:   resolvedBoardId,
    projectKey: resolvedProjectKey || null,
    totalSprints: sprints.length,
    active,
    future,
    closed,
    // Clear recommendation for the AI
    recommendation:
      active.length
        ? `Active sprint exists: "${active[0].name}" (id: ${active[0].id}).`
        : future.length
        ? `${future.length} future sprint(s) found.`
        : `No active or future sprints found.`,
  };
}

// ─── NEW Handler: add_stories_to_sprint ─────────────────────────────────────

async function handleAddStoriesToSprint({
  sprintId,
  sprintName,
  boardId,
  projectKey,
  stories = [],
}) {
  // ── Step 1: Resolve sprintId if not provided ──────────────────────────────────
  let resolvedSprintId = sprintId;
  let resolvedSprintInfo = null;
  let matchingSprints = [];

  if (!resolvedSprintId) {
    if (!sprintName) {
      throw new Error("Provide either sprintId or sprintName to identify the sprint.");
    }

    // Need a boardId to list sprints — auto-detect if not provided
    let resolvedBoardId = boardId;
    if (!resolvedBoardId) {
      // Derive project key from stories if not given
      let resolvedProjectKey = projectKey;
      if (!resolvedProjectKey) {
        const firstKey = stories.find((s) => /^[A-Z][A-Z0-9_]+-\d+$/i.test(s.trim()));
        if (firstKey) resolvedProjectKey = firstKey.trim().split("-")[0].toUpperCase();
      }
      if (!resolvedProjectKey) {
        throw new Error(
          "Cannot find sprint: no sprintId, no boardId, no projectKey, and no Jira keys in stories. " +
          "Please provide sprintId or boardId."
        );
      }

      // Fetch boards for the project
      const boardsRes = await fetch(
        `${JIRA_BASE_URL}/rest/agile/1.0/board?projectKeyOrId=${resolvedProjectKey}&maxResults=50`,
        { headers: { Authorization: JIRA_AUTH_HEADER, Accept: "application/json" } }
      );
      const boardsText = await boardsRes.text();
      if (!boardsRes.ok) throw new Error(`Failed to fetch boards: ${boardsRes.status} ${boardsText}`);
      const boardsData = JSON.parse(boardsText);
      const boards = boardsData.values || [];
      if (!boards.length) {
        throw new Error(`No boards found for project "${resolvedProjectKey}". Please provide boardId manually.`);
      }
      // Prefer Scrum boards
      const scrumBoard = boards.find((b) => b.type === "scrum") || boards[0];
      resolvedBoardId = scrumBoard.id;
    }

    // Fetch sprints for the board (active + future, also check closed)
    const sprintsRes = await fetch(
      `${JIRA_BASE_URL}/rest/agile/1.0/board/${resolvedBoardId}/sprint?state=active,future,closed&maxResults=100`,
      { headers: { Authorization: JIRA_AUTH_HEADER, Accept: "application/json" } }
    );
    const sprintsText = await sprintsRes.text();
    if (!sprintsRes.ok) throw new Error(`Failed to fetch sprints: ${sprintsRes.status} ${sprintsText}`);
    const sprintsData = JSON.parse(sprintsText);
    const allSprints  = sprintsData.values || [];

    // Match by name (case-insensitive, partial match)
    matchingSprints = allSprints.filter((s) =>
      s.name.toLowerCase().includes(sprintName.toLowerCase())
    );

    if (!matchingSprints.length) {
      const available = allSprints.map((s) => `"${s.name}" (id: ${s.id}, state: ${s.state})`).join(", ");
      throw new Error(
        `No sprint found matching "${sprintName}". ` +
        `Available sprints on board ${resolvedBoardId}: ${available || "none"}`
      );
    }

    if (matchingSprints.length > 1) {
      // Multiple matches — pick active first, then future, then most recent
      const active  = matchingSprints.find((s) => s.state === "active");
      const future  = matchingSprints.find((s) => s.state === "future");
      resolvedSprintInfo = active || future || matchingSprints[matchingSprints.length - 1];
    } else {
      resolvedSprintInfo = matchingSprints[0];
    }

    resolvedSprintId = resolvedSprintInfo.id;
  }

  // ── Step 2: Fetch sprint info if we only had an ID ────────────────────────────
  if (!resolvedSprintInfo) {
    const sprintRes = await fetch(
      `${JIRA_BASE_URL}/rest/agile/1.0/sprint/${resolvedSprintId}`,
      { headers: { Authorization: JIRA_AUTH_HEADER, Accept: "application/json" } }
    );
    const sprintText = await sprintRes.text();
    if (!sprintRes.ok) {
      throw new Error(`Sprint id ${resolvedSprintId} not found: ${sprintRes.status} ${sprintText}`);
    }
    resolvedSprintInfo = JSON.parse(sprintText);
  }

  // Warn if trying to add to a closed sprint
  if (resolvedSprintInfo.state === "closed") {
    throw new Error(
      `Sprint "${resolvedSprintInfo.name}" (id: ${resolvedSprintId}) is already CLOSED. ` +
      `You can only add stories to active or future sprints.`
    );
  }

  // ── Step 3: Resolve each story to a Jira key ─────────────────────────────────
  const resolvedKeys  = [];
  const resolveErrors = [];

  for (const story of stories) {
    const trimmed = story.trim();
    if (/^[A-Z][A-Z0-9_]+-\d+$/i.test(trimmed)) {
      // Validate the key actually exists
      try {
        await jiraRequest("GET", `/issue/${trimmed.toUpperCase()}?fields=summary`);
        resolvedKeys.push(trimmed.toUpperCase());
      } catch {
        resolveErrors.push({ story: trimmed, error: `Issue "${trimmed}" not found in Jira.` });
      }
    } else {
      // Resolve by summary text
      try {
        const searchResult = await jiraRequest("POST", "/search", {
          jql: `summary ~ "${trimmed.replace(/"/g, '\\"')}" ORDER BY created DESC`,
          maxResults: 1,
          fields: ["summary"],
        });
        if (!searchResult.issues?.length) {
          resolveErrors.push({ story: trimmed, error: "No matching Jira issue found." });
        } else {
          resolvedKeys.push(searchResult.issues[0].key);
        }
      } catch (err) {
        resolveErrors.push({ story: trimmed, error: err.message });
      }
    }
  }

  if (!resolvedKeys.length) {
    throw new Error(
      `No valid stories could be resolved. Errors: ${resolveErrors.map((e) => e.error).join("; ")}`
    );
  }

  // ── Step 4: Move issues into the sprint ───────────────────────────────────────
  const addedKeys = [];
  const addErrors = [];

  const moveRes = await fetch(
    `${JIRA_BASE_URL}/rest/agile/1.0/sprint/${resolvedSprintId}/issue`,
    {
      method:  "POST",
      headers: {
        Authorization:  JIRA_AUTH_HEADER,
        "Content-Type": "application/json",
        Accept:         "application/json",
      },
      body: JSON.stringify({ issues: resolvedKeys }),
    }
  );
  const moveText = await moveRes.text();

  if (moveRes.status === 204) {
    addedKeys.push(...resolvedKeys);
  } else if (moveRes.status === 207) {
    try {
      const partial = JSON.parse(moveText);
      const errors  = partial.errors || {};
      for (const key of resolvedKeys) {
        if (errors[key]) addErrors.push({ key, error: errors[key] });
        else addedKeys.push(key);
      }
    } catch {
      addedKeys.push(...resolvedKeys);
    }
  } else {
    throw new Error(`Failed to add issues to sprint (HTTP ${moveRes.status}): ${moveText}`);
  }

  // ── Step 5: Verify issues appear in the sprint ────────────────────────────────
  let verifiedInSprint = [];
  try {
    const verifyRes = await fetch(
      `${JIRA_BASE_URL}/rest/agile/1.0/sprint/${resolvedSprintId}/issue?maxResults=100&fields=summary`,
      { headers: { Authorization: JIRA_AUTH_HEADER, Accept: "application/json" } }
    );
    if (verifyRes.ok) {
      const verifyData = JSON.parse(await verifyRes.text());
      verifiedInSprint = (verifyData.issues || []).map((i) => i.key);
    }
  } catch { /* non-blocking */ }

  return {
    sprintId:        resolvedSprintId,
    sprintName:      resolvedSprintInfo.name,
    sprintState:     resolvedSprintInfo.state,
    sprintUrl:       `${JIRA_BASE_URL}/jira/software/projects/${resolvedSprintInfo.originBoardId ? "" : ""}boards`,
    addedToSprint:   addedKeys,
    verifiedInSprint,
    resolveErrors,
    addErrors,
    ...(matchingSprints.length > 1 && {
      warning: `Multiple sprints matched "${sprintName}". Auto-selected: "${resolvedSprintInfo.name}" (${resolvedSprintInfo.state}). Others: ${matchingSprints.filter((s) => s.id !== resolvedSprintId).map((s) => `"${s.name}" id:${s.id}`).join(", ")}`,
    }),
    message:
      `✅ Added ${addedKeys.length} issue(s) to sprint "${resolvedSprintInfo.name}" (id: ${resolvedSprintId}, state: ${resolvedSprintInfo.state}). ` +
      `${verifiedInSprint.length} total issues now in sprint.` +
      (resolveErrors.length ? ` ⚠️ ${resolveErrors.length} story/ies could not be resolved.` : "") +
      (addErrors.length     ? ` ❌ ${addErrors.length} issue(s) failed to move.` : ""),
  };
}

// ─── Handler: manage_sprint_stories ────────────────────────────────────────

async function handleManageSprintStories({
  sprintName,
  stories = [],
  projectKey,
  boardId,
  goal,
  startDate,
  endDate,
}) {
  // ── Step 1: Resolve project key from stories if not given ────────────────────
  let resolvedProjectKey = projectKey;
  if (!resolvedProjectKey) {
    const firstKey = stories.find((s) => /^[A-Z][A-Z0-9_]+-\d+$/i.test(s.trim()));
    if (firstKey) resolvedProjectKey = firstKey.trim().split('-')[0].toUpperCase();
  }

  // ── Step 2: Resolve boardId ──────────────────────────────────────────────────
  let resolvedBoardId = boardId;
  let boardInfo = null;
  if (!resolvedBoardId) {
    if (!resolvedProjectKey) {
      throw new Error('Provide projectKey, boardId, or Jira keys in stories so the board can be detected.');
    }
    // Fetch ALL boards for the project — no type filter
    const boardsRes = await fetch(
      JIRA_BASE_URL + '/rest/agile/1.0/board?projectKeyOrId=' + resolvedProjectKey + '&maxResults=50',
      { headers: { Authorization: JIRA_AUTH_HEADER, Accept: 'application/json' } }
    );
    const boardsData = JSON.parse(await boardsRes.text());
    const boards = boardsData.values || [];
    if (!boards.length) throw new Error('No boards found for project "' + resolvedProjectKey + '".');

    // Prefer Scrum board — if none, probe each board for existing sprints
    const scrumBoard = boards.find((b) => b.type === 'scrum');
    if (scrumBoard) {
      resolvedBoardId = scrumBoard.id;
      boardInfo = scrumBoard;
    } else {
      let boardWithSprints = null;
      for (const b of boards) {
        try {
          const testRes = await fetch(
            JIRA_BASE_URL + '/rest/agile/1.0/board/' + b.id + '/sprint?maxResults=1',
            { headers: { Authorization: JIRA_AUTH_HEADER, Accept: 'application/json' } }
          );
          if (testRes.ok) {
            const testData = JSON.parse(await testRes.text());
            if ((testData.values || []).length > 0 || testData.total > 0) {
              boardWithSprints = b;
              break;
            }
          }
        } catch (_) { /* try next */ }
      }
      // Use board that has sprints, or fall back to first board and let Jira decide
      const chosen = boardWithSprints || boards[0];
      resolvedBoardId = chosen.id;
      boardInfo = chosen;
    }
  }

  // Fetch board info if we only had the id
  if (!boardInfo) {
    const br = await fetch(
      JIRA_BASE_URL + '/rest/agile/1.0/board/' + resolvedBoardId,
      { headers: { Authorization: JIRA_AUTH_HEADER, Accept: 'application/json' } }
    );
    boardInfo = JSON.parse(await br.text());
  }

  // ── Step 3: Check if sprint with this name already exists ────────────────────
  const sprintsRes = await fetch(
    JIRA_BASE_URL + '/rest/agile/1.0/board/' + resolvedBoardId + '/sprint?state=active,future,closed&maxResults=100',
    { headers: { Authorization: JIRA_AUTH_HEADER, Accept: 'application/json' } }
  );
  const sprintsData = JSON.parse(await sprintsRes.text());
  const allSprints  = sprintsData.values || [];

  const existingSprint = allSprints.find(
    (s) => s.name.toLowerCase() === sprintName.toLowerCase()
  );

  let sprintId;
  let sprintRecord;
  let action; // 'found' | 'created'

  if (existingSprint) {
    // ── Sprint EXISTS — use it ────────────────────────────────────────────────
    if (existingSprint.state === 'closed') {
      throw new Error(
        'Sprint "' + existingSprint.name + '" (id: ' + existingSprint.id + ') is CLOSED. ' +
        'Cannot add stories to a closed sprint. Available sprints: ' +
        allSprints.filter((s) => s.state !== 'closed').map((s) => '"' + s.name + '" (id:' + s.id + ', ' + s.state + ')').join(', ')
      );
    }
    sprintId     = existingSprint.id;
    sprintRecord = existingSprint;
    action       = 'found';
  } else {
    // ── Sprint does NOT exist — create it ─────────────────────────────────────
    const payload = { name: sprintName, originBoardId: resolvedBoardId };
    if (goal)      payload.goal      = goal;
    if (startDate) payload.startDate = startDate;
    if (endDate)   payload.endDate   = endDate;

    const createRes = await fetch(JIRA_BASE_URL + '/rest/agile/1.0/sprint', {
      method: 'POST',
      headers: { Authorization: JIRA_AUTH_HEADER, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const createText = await createRes.text();
    if (!createRes.ok) throw new Error('Failed to create sprint: ' + createRes.status + ' ' + createText);

    sprintRecord = JSON.parse(createText);
    sprintId     = sprintRecord.id;
    action       = 'created';

    // Verify sprint was actually created
    const verifyRes = await fetch(
      JIRA_BASE_URL + '/rest/agile/1.0/sprint/' + sprintId,
      { headers: { Authorization: JIRA_AUTH_HEADER, Accept: 'application/json' } }
    );
    if (!verifyRes.ok) throw new Error('Sprint creation could not be verified for id ' + sprintId);
    sprintRecord = JSON.parse(await verifyRes.text());
  }

  // ── Step 4: Resolve each story to a Jira key ────────────────────────────────
  const resolvedKeys  = [];
  const resolveErrors = [];

  for (const story of stories) {
    const trimmed = story.trim();
    if (/^[A-Z][A-Z0-9_]+-\d+$/i.test(trimmed)) {
      try {
        await jiraRequest('GET', '/issue/' + trimmed.toUpperCase() + '?fields=summary');
        resolvedKeys.push(trimmed.toUpperCase());
      } catch {
        resolveErrors.push({ story: trimmed, error: 'Issue "' + trimmed + '" not found in Jira.' });
      }
    } else {
      try {
        const sr = await jiraRequest('POST', '/search', {
          jql: 'summary ~ "' + trimmed.replace(/"/g, '\"') + '" ORDER BY created DESC',
          maxResults: 1,
          fields: ['summary'],
        });
        if (!sr.issues?.length) {
          resolveErrors.push({ story: trimmed, error: 'No matching Jira issue found.' });
        } else {
          resolvedKeys.push(sr.issues[0].key);
        }
      } catch (err) {
        resolveErrors.push({ story: trimmed, error: err.message });
      }
    }
  }

  if (!resolvedKeys.length) {
    throw new Error('No valid stories could be resolved. Errors: ' + resolveErrors.map((e) => e.error).join('; '));
  }

  // ── Step 5: Add issues to sprint ────────────────────────────────────────────
  const addedKeys = [];
  const addErrors = [];

  const moveRes = await fetch(
    JIRA_BASE_URL + '/rest/agile/1.0/sprint/' + sprintId + '/issue',
    {
      method: 'POST',
      headers: { Authorization: JIRA_AUTH_HEADER, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ issues: resolvedKeys }),
    }
  );
  const moveText = await moveRes.text();

  if (moveRes.status === 204) {
    addedKeys.push(...resolvedKeys);
  } else if (moveRes.status === 207) {
    try {
      const partial = JSON.parse(moveText);
      const errors  = partial.errors || {};
      for (const key of resolvedKeys) {
        if (errors[key]) addErrors.push({ key, error: errors[key] });
        else addedKeys.push(key);
      }
    } catch { addedKeys.push(...resolvedKeys); }
  } else {
    throw new Error('Failed to add issues to sprint (HTTP ' + moveRes.status + '): ' + moveText);
  }

  // ── Step 6: Verify issues appear in sprint ───────────────────────────────────
  let verifiedInSprint = [];
  try {
    const vr = await fetch(
      JIRA_BASE_URL + '/rest/agile/1.0/sprint/' + sprintId + '/issue?maxResults=200&fields=summary',
      { headers: { Authorization: JIRA_AUTH_HEADER, Accept: 'application/json' } }
    );
    if (vr.ok) {
      const vd = JSON.parse(await vr.text());
      verifiedInSprint = (vd.issues || []).map((i) => i.key);
    }
  } catch { /* non-blocking */ }

  const actionLabel = action === 'found' ? 'Found existing' : 'Created new';

  return {
    action,
    sprintId,
    sprintName:      sprintRecord.name,
    sprintState:     sprintRecord.state,
    boardId:         resolvedBoardId,
    boardName:       boardInfo.name || ('Board ' + resolvedBoardId),
    addedToSprint:   addedKeys,
    verifiedInSprint,
    resolveErrors,
    addErrors,
    message:
      actionLabel + ' sprint "' + sprintRecord.name + '" (id: ' + sprintId + '). ' +
      addedKeys.length + ' issue(s) added. ' +
      verifiedInSprint.length + ' total issues now in sprint.' +
      (resolveErrors.length ? ' ⚠️ ' + resolveErrors.length + ' story/ies could not be resolved.' : '') +
      (addErrors.length     ? ' ❌ ' + addErrors.length + ' issue(s) failed to move.' : ''),
  };
}
// ─── NEW Handler: requirements_to_stories ────────────────────────────────────

async function handleRequirementsToStories({
  projectKey,
  requirements,
  stories = [],
  epicKey,
  defaultPriority = "Medium",
  labels = [],
}) {
  if (!stories?.length && !requirements) {
    throw new Error("Either 'stories' array or 'requirements' text must be provided.");
  }

  let storiesToCreate = stories;

  if (!storiesToCreate?.length && requirements) {
    storiesToCreate = [
      {
        summary:     requirements.split("\n")[0].slice(0, 200) || "Imported Requirement",
        description: requirements,
        priority:    defaultPriority,
      },
    ];
  }

  // ── Resolve story points field ID once for this batch ───────────────────────
  await resolveStoryPointsFieldId();

  // ── Resolve board for backlog placement ───────────────────────────────────────
  let boardId = null;
  try {
    const boardsRes = await fetch(
      `${JIRA_BASE_URL}/rest/agile/1.0/board?projectKeyOrId=${projectKey}&maxResults=50`,
      { headers: { Authorization: JIRA_AUTH_HEADER, Accept: "application/json" } }
    );
    if (boardsRes.ok) {
      const boardsData = JSON.parse(await boardsRes.text());
      const boards = boardsData.values || [];
      const scrumBoard = boards.find((b) => b.type === "scrum") || boards[0];
      if (scrumBoard) boardId = scrumBoard.id;
    }
  } catch { /* non-fatal */ }

  // Fetch the epic link field name once (it varies per Jira instance)
  let epicLinkFieldId = null;
  const resolvedEpicKey = epicKey || null;
  if (resolvedEpicKey) {
    try {
      const fields = await jiraRequest("GET", "/field");
      const epicField =
        fields.find((f) => f.name === "Epic Link") ||
        fields.find((f) => f.key === "customfield_10014") ||
        fields.find((f) => (f.schema?.custom || "").includes("gh-epic-link")) ||
        fields.find((f) => f.name?.toLowerCase().includes("epic link"));
      if (epicField) epicLinkFieldId = epicField.id || epicField.key;
    } catch {
      // Non-fatal — just skip epic linking if field can't be resolved
    }
  }

  const created = [];
  const failed  = [];

  for (const story of storiesToCreate) {
    try {
      const storyEpicKey = story.epicKey || resolvedEpicKey;
      const storyLabels  = [...new Set([...(labels || []), ...(story.labels || [])])];
      const priority     = story.priority || defaultPriority;

      // ── Short title: strip "As a [role], I want..." if passed as summary ──────
      const rawSummary = story.summary || "Untitled Story";
      let storyTitle = rawSummary
        .replace(/^as an?\s+\w[\w\s]*?,\s*/i, "")   // strip "As a user, "
        .replace(/\s+so that.*/i, "")                 // strip "so that..." tail
        .replace(/\s+in order to.*/i, "")             // strip "in order to..." tail
        .trim();
      if (storyTitle.length > 80) storyTitle = storyTitle.slice(0, 77) + "...";

      // ── Full description: move "As a..." sentence + acceptance criteria here ──
      let fullDescription = story.description || "";
      // If the raw summary had "As a..." but description is empty, move it there
      if (!fullDescription && rawSummary !== storyTitle) {
        fullDescription = rawSummary;
      }

      const fields = {
        project:   { key: projectKey },
        summary:   storyTitle,
        issuetype: { name: "Story" },
      };

      if (fullDescription)               fields.description = textToADF(fullDescription);
      if (priority)                      fields.priority    = { name: priority };
      if (story.assigneeAccountId)       fields.assignee    = { accountId: story.assigneeAccountId };
      if (storyLabels.length)            fields.labels      = storyLabels;

      applyStoryPoints(fields, story.storyPoints);

      if (storyEpicKey && epicLinkFieldId) {
        fields[epicLinkFieldId] = storyEpicKey;
      }

      const result = await createIssueWithFallback(fields);

      created.push({
        key:     result.key,
        summary: storyTitle,
        url:     `${JIRA_BASE_URL}/browse/${result.key}`,
        priority,
        labels:  storyLabels,
        epicKey: storyEpicKey || null,
      });
    } catch (err) {
      failed.push({ summary: story.summary, error: err.message });
    }
  }

  // ── Move all created stories to the board backlog ─────────────────────────────
  let backlogResult = { status: "skipped", reason: "No board found for project." };
  if (boardId && created.length > 0) {
    const issueKeys = created.map((s) => s.key);
    try {
      const backlogRes = await fetch(
        `${JIRA_BASE_URL}/rest/agile/1.0/backlog/issue`,
        {
          method: "POST",
          headers: {
            Authorization:  JIRA_AUTH_HEADER,
            "Content-Type": "application/json",
            Accept:         "application/json",
          },
          body: JSON.stringify({ issues: issueKeys }),
        }
      );
      if (backlogRes.status === 204) {
        backlogResult = { status: "success", boardId, moved: issueKeys.length };
      } else {
        const errText = await backlogRes.text();
        backlogResult = { status: "failed", boardId, message: `HTTP ${backlogRes.status}: ${errText}` };
      }
    } catch (err) {
      backlogResult = { status: "error", message: err.message };
    }
  }

  return {
    projectKey,
    boardId,
    totalRequested: storiesToCreate.length,
    totalCreated:   created.length,
    totalFailed:    failed.length,
    backlog:        backlogResult,
    created,
    failed,
    message:
      `✅ ${created.length} of ${storiesToCreate.length} stories created successfully in project ${projectKey}. ` +
      `Backlog: ${backlogResult.status === "success" ? `✅ ${backlogResult.moved} stories added to backlog.` : backlogResult.message || backlogResult.reason}` +
      (failed.length ? ` ⚠️ ${failed.length} story/ies failed — see 'failed' for details.` : ""),
  };
}

// ─── NEW Handler: srs_to_stories ─────────────────────────────────────────────

async function handleSrsToStories({
  projectKey,
  srsDocument,
  parsedStories = [],
  epicKey,
  defaultPriority = "Medium",
  additionalLabels = [],
}) {
  if (!parsedStories?.length) {
    throw new Error(
      "parsedStories array is required and must be populated by the calling LLM after analyzing the srsDocument. " +
      "Please re-invoke with the decomposed stories array."
    );
  }

  // ── Step 0: Resolve story points field ID once for this batch ───────────────
  await resolveStoryPointsFieldId();

  // ── Step 1: Resolve the board ID for this project (needed to move to backlog) ──
  let boardId = null;
  try {
    const boardsRes = await fetch(
      `${JIRA_BASE_URL}/rest/agile/1.0/board?projectKeyOrId=${projectKey}&maxResults=50`,
      { headers: { Authorization: JIRA_AUTH_HEADER, Accept: "application/json" } }
    );
    if (boardsRes.ok) {
      const boardsData = JSON.parse(await boardsRes.text());
      const boards = boardsData.values || [];
      // Prefer Scrum board so backlog is supported; fall back to first board
      const scrumBoard = boards.find((b) => b.type === "scrum") || boards[0];
      if (scrumBoard) boardId = scrumBoard.id;
    }
  } catch {
    // Non-fatal — backlog move will be skipped if board can't be resolved
  }

  // ── Step 2: Fetch the epic link field name once ───────────────────────────────
  let epicLinkFieldId = null;
  const resolvedEpicKey = epicKey || null;
  if (resolvedEpicKey) {
    try {
      const fields = await jiraRequest("GET", "/field");
      const epicField =
        fields.find((f) => f.name === "Epic Link") ||
        fields.find((f) => f.key === "customfield_10014") ||
        fields.find((f) => (f.schema?.custom || "").includes("gh-epic-link")) ||
        fields.find((f) => f.name?.toLowerCase().includes("epic link"));
      if (epicField) epicLinkFieldId = epicField.id || epicField.key;
    } catch {
      // Non-fatal — skip epic linking
    }
  }

  const created = [];
  const failed  = [];
  const featureGroups = {};

  // ── Step 3: Create each story ─────────────────────────────────────────────────
  for (const story of parsedStories) {
    try {
      const storyEpicKey = story.epicKey || resolvedEpicKey;
      const storyLabels  = [...new Set([
        ...(additionalLabels || []),
        ...(story.labels || []),
        "srs-import",
      ])];
      const priority = story.priority || defaultPriority;

      // ── Build Jira summary: short name only (3-8 words) ─────────────────────
      // Support both 'name' (new field) and 'summary' (legacy fallback)
      const rawName = story.name || story.summary || "Untitled Story";
      // If the caller accidentally passed a full "As a..." sentence as the name,
      // truncate it to the first meaningful phrase (before comma or "so that")
      let storyTitle = rawName
        .replace(/^as an?\s+\w[\w\s]*?,\s*/i, "")   // strip "As a user, "
        .replace(/\s+so that.*/i, "")                 // strip "so that..." tail
        .replace(/\s+in order to.*/i, "")             // strip "in order to..." tail
        .trim();
      // Cap at 80 chars for Jira summary field
      if (storyTitle.length > 80) storyTitle = storyTitle.slice(0, 77) + "...";

      // ── Build full description: user story + acceptance criteria only ─────────
      let fullDescription = story.description || "";
      if (!fullDescription && rawName !== storyTitle) {
        fullDescription = rawName;
      }

      // Prepend requirement reference if present
      if (story.requirementRef) {
        fullDescription = `*Requirement Reference:* ${story.requirementRef}\n\n${fullDescription}`;
      }

      // Story points go into the dedicated Jira field only — not the description

      const fields = {
        project:   { key: projectKey },
        summary:   storyTitle,
        issuetype: { name: "Story" },
      };

      if (fullDescription)          fields.description = textToADF(fullDescription);
      if (priority)                 fields.priority    = { name: priority };
      if (storyLabels.length)       fields.labels      = storyLabels;
      if (story.assigneeAccountId)  fields.assignee    = { accountId: story.assigneeAccountId };

      applyStoryPoints(fields, story.storyPoints);

      if (storyEpicKey && epicLinkFieldId) {
        fields[epicLinkFieldId] = storyEpicKey;
      }

      const result = await createIssueWithFallback(fields);

      created.push({
        key:            result.key,
        id:             result.id,
        summary:        storyTitle,
        url:            `${JIRA_BASE_URL}/browse/${result.key}`,
        priority,
        storyPoints:    story.storyPoints || null,
        labels:         storyLabels,
        epicKey:        storyEpicKey || null,
        requirementRef: story.requirementRef || null,
      });

      // Group by feature label for summary
      const featureLabel = (story.labels || []).find((l) => l !== "srs-import") || "general";
      if (!featureGroups[featureLabel]) featureGroups[featureLabel] = [];
      featureGroups[featureLabel].push({ key: result.key, summary: storyTitle });

    } catch (err) {
      failed.push({ summary: story.name || story.summary, error: err.message });
    }
  }

  // ── Step 4: Move ALL created stories to the board backlog in one API call ─────
  let backlogResult = { status: "skipped", reason: "No board found for project." };

  if (boardId && created.length > 0) {
    const issueKeys = created.map((s) => s.key);
    try {
      // POST /rest/agile/1.0/backlog/issue — moves issues to the board backlog
      const backlogRes = await fetch(
        `${JIRA_BASE_URL}/rest/agile/1.0/backlog/issue`,
        {
          method: "POST",
          headers: {
            Authorization:  JIRA_AUTH_HEADER,
            "Content-Type": "application/json",
            Accept:         "application/json",
          },
          body: JSON.stringify({ issues: issueKeys }),
        }
      );

      if (backlogRes.status === 204) {
        backlogResult = {
          status:  "success",
          boardId,
          moved:   issueKeys.length,
          message: `All ${issueKeys.length} stories moved to backlog on board ${boardId}.`,
        };
      } else {
        const errText = await backlogRes.text();
        // Fallback: try rank/move one by one using the agile rank endpoint
        let movedCount = 0;
        for (const key of issueKeys) {
          try {
            const rankRes = await fetch(
              `${JIRA_BASE_URL}/rest/agile/1.0/issue/rank`,
              {
                method: "PUT",
                headers: {
                  Authorization:  JIRA_AUTH_HEADER,
                  "Content-Type": "application/json",
                  Accept:         "application/json",
                },
                body: JSON.stringify({
                  issues: [key],
                  rankCustomFieldId: 10019, // default Jira rank field
                }),
              }
            );
            if (rankRes.ok || rankRes.status === 204) movedCount++;
          } catch { /* continue */ }
        }
        backlogResult = {
          status:  movedCount > 0 ? "partial" : "failed",
          boardId,
          moved:   movedCount,
          message: movedCount > 0
            ? `${movedCount}/${issueKeys.length} stories moved to backlog via rank fallback.`
            : `Backlog move failed (HTTP ${backlogRes.status}): ${errText}. Stories were created but may appear in project view, not backlog.`,
        };
      }
    } catch (err) {
      backlogResult = {
        status:  "error",
        boardId,
        message: `Backlog move threw an error: ${err.message}. Stories were created successfully.`,
      };
    }
  }

  // ── Step 5: Build grouped summary and return ──────────────────────────────────
  const groupedSummary = Object.entries(featureGroups).map(([feature, stories]) => ({
    feature,
    count: stories.length,
    stories,
  }));

  // ── Step 6: Compute total story points summary ───────────────────────────────
  const totalStoryPoints = created.reduce((sum, s) => sum + (s.storyPoints || 0), 0);
  const estimationSummary = created.map((s) => ({
    key:         s.key,
    summary:     s.summary,
    storyPoints: s.storyPoints || 0,
  }));

  return {
    projectKey,
    boardId,
    totalRequested:    parsedStories.length,
    totalCreated:      created.length,
    totalFailed:       failed.length,
    totalStoryPoints,
    estimationSummary,
    backlog:           backlogResult,
    groupedByFeature:  groupedSummary,
    created,
    failed,
    message:
      `✅ ${created.length} of ${parsedStories.length} stories created in project ${projectKey}. ` +
      `Total estimated capacity: ${totalStoryPoints} story points. ` +
      `Backlog: ${backlogResult.status === "success" ? `✅ All ${backlogResult.moved} stories added to backlog (board ${boardId}).` : backlogResult.message}` +
      (failed.length ? ` ⚠️ ${failed.length} story/ies failed — see 'failed' for details.` : "") +
      ` Stories grouped into ${groupedSummary.length} feature(s): ${groupedSummary.map((g) => `${g.feature} (${g.count})`).join(", ")}.`,
  };
}

// ─── Smart issue creator: auto-retries without story points if field is missing ──

async function createIssueWithFallback(fields) {
  try {
    return await jiraRequest("POST", "/issue", { fields });
  } catch (err) {
    const msg = err.message || "";
    // Jira returns 400 with "is not on the appropriate screen" or "customfield_10016"
    // or "story_points" when the field isn't enabled on this project's screen
    const isStoryPointsError =
      /story.?points|customfield_1001[0-9]|not on the appropriate screen|field.*not.*screen|screen.*field/i.test(msg);

    if (isStoryPointsError) {
      // Retry stripping ALL known story point field variants
      const retryFields = { ...fields };
      delete retryFields["story_points"];
      delete retryFields["customfield_10016"];
      delete retryFields["customfield_10028"];
      delete retryFields["customfield_10004"];
      if (_storyPointsFieldId) delete retryFields[_storyPointsFieldId];
      console.error("[MCP] Story points field rejected by Jira — retrying without it.");
      return await jiraRequest("POST", "/issue", { fields: retryFields });
    }

    throw err; // re-throw unrelated errors
  }
}

// ─── Story Points field auto-resolver ──────────────────────────────────────────────

// Cache: undefined = not yet fetched, null = field not found, string = field key
let _storyPointsFieldId = undefined;

async function resolveStoryPointsFieldId() {
  if (_storyPointsFieldId !== undefined) return _storyPointsFieldId;
  try {
    const allFields = await jiraRequest("GET", "/field");

    // Exact name matches — covers every known Jira variant
    // "Story point estimate" = Jira next-gen (team-managed) projects  <-- seen in screenshot
    // "Story Points"         = Jira classic software projects
    // "Estimation"           = some custom configurations
    const candidate =
      allFields.find((f) => f.name === "Story point estimate") ||
      allFields.find((f) => f.name === "Story Points") ||
      allFields.find((f) => f.name === "Story points") ||
      allFields.find((f) => f.name === "Story Point Estimate") ||
      allFields.find((f) => f.name === "Estimation") ||
      allFields.find((f) => f.name?.toLowerCase().includes("story point")) ||
      allFields.find((f) => f.key  === "customfield_10016") ||
      allFields.find((f) => f.key  === "customfield_10028") ||
      allFields.find((f) => f.key  === "customfield_10004") ||
      allFields.find((f) => f.key  === "story_points");

    _storyPointsFieldId = candidate ? (candidate.key || candidate.id) : null;
    console.error(`[MCP] Story point field resolved to: "${_storyPointsFieldId}" (name: "${candidate?.name || "not found"}")`);
  } catch (err) {
    console.error(`[MCP] Story points field lookup failed: ${err.message}`);
    _storyPointsFieldId = null;
  }
  return _storyPointsFieldId;
}

// Apply story points — sets ONLY the resolved field (clean, no noise)
function applyStoryPoints(fields, points) {
  if (points === undefined || points === null) return;
  if (_storyPointsFieldId) {
    // Use the exact field discovered for this Jira instance
    fields[_storyPointsFieldId] = points;
  } else {
    // Fallback: try all known IDs — createIssueWithFallback will strip bad ones
    fields["customfield_10016"] = points;
    fields["customfield_10028"] = points;
    fields["customfield_10004"] = points;
    fields["story_points"]      = points;
  }
}

// ─── ADF helpers ──────────────────────────────────────────────────────────────

function textToADF(text) {
  return {
    type: "doc",
    version: 1,
    content: text.split("\n\n").map((para) => ({
      type: "paragraph",
      content: [{ type: "text", text: para }],
    })),
  };
}

function extractTextFromADF(adf) {
  if (!adf) return "";
  if (typeof adf === "string") return adf;

  const extractNode = (node) => {
    if (!node) return "";
    if (node.type === "text") return node.text || "";
    if (node.content) return node.content.map(extractNode).join(" ");
    return "";
  };

  return extractNode(adf).trim();
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: "jira-zephyr-mcp-server", version: "3.5.5" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case "list_sprints":                 result = await handleListSprints(args);               break;
      case "add_stories_to_sprint":        result = await handleAddStoriesToSprint(args);        break;
      case "manage_sprint_stories":         result = await handleManageSprintStories(args);        break;
      case "srs_to_stories":           result = await handleSrsToStories(args);          break;
      case "requirements_to_stories":   result = await handleRequirementsToStories(args); break;
      case "jira_search_issues":        result = await handleSearchIssues(args);          break;
      case "jira_get_issue":            result = await handleGetIssue(args);              break;
      case "jira_create_issue":         result = await handleCreateIssue(args);           break;
      case "jira_update_issue":         result = await handleUpdateIssue(args);           break;
      case "jira_add_comment":          result = await handleAddComment(args);            break;
      case "jira_get_comments":         result = await handleGetComments(args);           break;
      case "debug_teststeps":           result = await handleDebugTeststeps(args);        break;
      case "generate_in_zephyr":        result = await handleGenerateInZephyr(args);      break;
      case "link_zephyr_tcs_to_story":  result = await handleLinkZephyrTcsToStory(args);  break;
      case "create_test_cycle":         result = await handleCreateTestCycle(args);        break;
      case "create_bug":                result = await handleCreateBug(args);              break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Jira + Zephyr Scale MCP server v3.5.5 running on stdio");

// ─── Automation Workflow ──────────────────────────────────────────────────────
//
//  Two autonomous triggers are set up:
//
//  1. WEBHOOK  POST /webhook/story-created
//     Called by a Jira Automation rule whenever a Story is created.
//     → Fetches the story → asks Claude (Anthropic API) to generate TCs
//     → pushes them to Zephyr → links them to the story
//     → posts a Jira comment confirming the TCs were created
//
//  2. NIGHTLY CRON  every day at 00:00
//     Finds all Stories in status "To Do" that have NO linked Zephyr TCs yet.
//     → For each story: same AI → Zephyr pipeline as the webhook
//
//  WEBHOOK SETUP (Jira Automation):
//    Trigger  : Issue Created  (filter: issuetype = Story)
//    Action   : Send web request
//    URL      : http://<your-server-ip>:3001/webhook/story-created
//    Method   : POST
//    Body     : {"issueKey": "{{issue.key}}"}
//
// ─────────────────────────────────────────────────────────────────────────────

const WEBHOOK_PORT = process.env.WEBHOOK_PORT || 3001;

// ── Core: AI-powered TC generation pipeline ───────────────────────────────────

// ─── Helper: TC title → valid Java class name ─────────────────────────────────
function toJavaClassName(title = "") {
  return (
    title
      .replace(/[^a-zA-Z0-9 _]/g, "")
      .split(/[\s_]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join("") || "AutomatedTest"
  );
}

// ─── Helper: update TC execution in Zephyr ────────────────────────────────────
async function updateZephyrExecutionStatus(tcKey, cycleId, status, comment) {
  let executionId = null;
  try {
    const runs = await zephyrRequest(
      "GET",
      `/testexecutions?testCaseKey=${tcKey}&testCycleKey=${cycleId}&maxResults=10`
    );
    const execs = runs.values || runs.results || [];
    if (execs.length > 0) executionId = execs[0].id;
  } catch { /* will create instead */ }

  const zStatus = { PASS: "Pass", FAIL: "Fail", BLOCKED: "Blocked" }[status?.toUpperCase()] || "Fail";

  if (executionId) {
    await zephyrRequest("PUT", `/testexecutions/${executionId}`, { statusName: zStatus, comment: comment || "" });
  } else {
    await zephyrRequest("POST", "/testexecutions", {
      projectKey:   tcKey.split("-")[0],
      testCaseKey:  tcKey,
      testCycleKey: cycleId,
      statusName:   zStatus,
      comment:      comment || "",
    });
  }
}

// ─── Helper: generate Selenium Java script via Claude ─────────────────────────
async function generateSeleniumScript(tcKey, tc, storyRef) {
  const className = toJavaClassName(tc.title);
  const stepsText = (tc.steps || [])
    .map((s, i) =>
      `Step ${i + 1}: ${s.step}` +
      (s.testData ? `\n  Test Data: ${s.testData}` : "") +
      `\n  Expected: ${s.expectedResult}`
    )
    .join("\n\n");

  const APP_URL = "https://demo.guru99.com/V4/";

  const prompt = `You are a senior QA automation engineer. Generate a complete compilable Selenium WebDriver + Java test class using JUnit 5.

Test Case: ${tcKey} — ${tc.title}
Story: ${storyRef}
Class Name: ${className}
App URL: ${APP_URL}
Objective: ${tc.objective || ""}
Preconditions: ${tc.preconditions || ""}

Steps:
${stepsText}

Rules:
- Package: automation.tests
- Class name: ${className}
- JUnit 5: @Test @BeforeEach @AfterEach
- WebDriverManager for ChromeDriver
- Headless setup:
    boolean headless = Boolean.parseBoolean(System.getProperty("headless","true"));
    ChromeOptions opts = new ChromeOptions();
    if (headless) opts.addArguments("--headless=new","--no-sandbox","--disable-dev-shm-usage");
    driver = new ChromeDriver(opts);
- WebDriverWait for waits — NO Thread.sleep()
- App URL: ${APP_URL}
- Guru99 selectors: username=id("uid"), password=id("password"), login=name("btnLogin")
- Keep the class SHORT and SIMPLE — max 80 lines total
- Each test method max 15 lines
- CRITICAL: The Java file MUST be complete and compilable — never truncate, always close all braces
- Return ONLY raw Java — no markdown.`;

  const raw = await anthropicRequest([{ role: "user", content: prompt }], { maxTokens: 6000 });
  return raw.replace(/```java|```/gi, "").trim();
}

// ─── Helper: build pom.xml ────────────────────────────────────────────────────
function buildPomXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>automation</groupId>
  <artifactId>selenium-tests</artifactId>
  <version>1.0.0</version>
  <properties>
    <maven.compiler.source>17</maven.compiler.source>
    <maven.compiler.target>17</maven.compiler.target>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    <selenium.version>4.18.1</selenium.version>
    <junit5.version>5.10.2</junit5.version>
    <wdm.version>5.8.0</wdm.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.seleniumhq.selenium</groupId>
      <artifactId>selenium-java</artifactId>
      <version>\${selenium.version}</version>
    </dependency>
    <dependency>
      <groupId>io.github.bonigarcia</groupId>
      <artifactId>webdrivermanager</artifactId>
      <version>\${wdm.version}</version>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter-api</artifactId>
      <version>\${junit5.version}</version>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter-engine</artifactId>
      <version>\${junit5.version}</version>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>org.junit.platform</groupId>
      <artifactId>junit-platform-launcher</artifactId>
      <version>1.10.2</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>3.2.5</version>
        <configuration>
          <includes>
            <include>**/*Test.java</include>
            <include>**/Test*.java</include>
            <include>**/*.java</include>
          </includes>
          <systemPropertyVariables>
            <headless>true</headless>
          </systemPropertyVariables>
          <failIfNoTests>false</failIfNoTests>
          <testFailureIgnore>true</testFailureIgnore>
        </configuration>
      </plugin>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-compiler-plugin</artifactId>
        <version>3.13.0</version>
        <configuration>
          <release>17</release>
        </configuration>
      </plugin>
    </plugins>
  </build>
</project>`;
}

// ─── Helper: run Maven locally + update Zephyr ───────────────────────────────
async function runSeleniumLocally(issueKey, scriptMap) {
  const projectKey = issueKey.split("-")[0];

  // 1. Create Zephyr test cycle
  let cycleId = "";
  try {
    const cycle = await zephyrRequest("POST", "/testcycles", {
      projectKey,
      name:   `Auto — ${issueKey} — ${new Date().toISOString().slice(0, 10)}`,
      status: { name: "Not Executed" },
    });
    cycleId = cycle.id || cycle.key || "";
    console.error(`[LOCAL] Zephyr test cycle created: ${cycleId}`);
  } catch (e) {
    console.error(`[LOCAL] Could not create test cycle: ${e.message}`);
  }

  // className → tcKey for result mapping
  const tcKeyMap = {};
  for (const [tcKey, { className }] of Object.entries(scriptMap)) {
    tcKeyMap[className] = tcKey;
  }

  // 2. Write Maven project to temp folder
  const workDir = join(os.tmpdir(), `selenium-${issueKey}-${Date.now()}`);
  const testDir = join(workDir, "src", "test", "java", "automation", "tests");
  mkdirSync(testDir, { recursive: true });
  writeFileSync(join(workDir, "pom.xml"), buildPomXml(), "utf-8");

  for (const [, { javaSource, className }] of Object.entries(scriptMap)) {
    writeFileSync(join(testDir, `${className}.java`), javaSource, "utf-8");
    console.error(`[LOCAL] Wrote ${className}.java`);
  }

  // 3. Run mvn test
  console.error(`[LOCAL] Running mvn test...`);
  const mvnCmd = process.platform === "win32" ? "mvn.cmd" : "mvn";
  let mvnExitCode = 0;

  await new Promise((res) => {
    const mvn = spawn(mvnCmd, ["test", "-B", "-Dheadless=true"], {
      cwd: workDir, env: { ...process.env, headless: "true" }, shell: true,
    });
    mvn.stdout.on("data", (d) => console.error(`[MVN] ${d.toString().trimEnd()}`));
    mvn.stderr.on("data", (d) => console.error(`[MVN] ${d.toString().trimEnd()}`));
    mvn.on("close", (code) => { mvnExitCode = code || 0; res(); });
    mvn.on("error", (err)  => { console.error(`[MVN] ${err.message}`); mvnExitCode = 1; res(); });
  });

  // 4. Parse Surefire XML
  const surefireDir = join(workDir, "target", "surefire-reports");
  const testResults = [];

  if (existsSync(surefireDir)) {
    for (const f of readdirSync(surefireDir).filter((f) => f.endsWith(".xml"))) {
      try {
        const parsed = await parseStringPromise(readFileSync(join(surefireDir, f), "utf-8"), { explicitArray: false });
        const suite  = parsed.testsuite;
        if (!suite) continue;
        const tcs = Array.isArray(suite.testcase) ? suite.testcase : suite.testcase ? [suite.testcase] : [];
        for (const tc of tcs) {
          const className    = (tc.$.classname || "").split(".").pop();
          const status       = tc.skipped ? "BLOCKED" : (tc.failure || tc.error) ? "FAIL" : "PASS";
          const errorMessage = tc.failure?._ || tc.error?._ || "";
          testResults.push({ className, status, errorMessage });
        }
      } catch (e) { console.error(`[LOCAL] XML parse error: ${e.message}`); }
    }
  } else {
    console.error("[LOCAL] No surefire-reports — Maven may have failed to compile");
  }

  console.error(`[LOCAL] ${testResults.length} test result(s) parsed`);

  // 5. Update Zephyr
  let pass = 0, fail = 0, blocked = 0;
  for (const { className, status, errorMessage } of testResults) {
    const tcKey = tcKeyMap[className];
    if (!tcKey || !cycleId) continue;
    try {
      await updateZephyrExecutionStatus(
        tcKey, cycleId, status,
        status === "PASS" ? "Local Selenium run passed ✅"
          : `Local Selenium run failed ❌${errorMessage ? ": " + errorMessage.slice(0, 200) : ""}`
      );
      if      (status === "PASS")    pass++;
      else if (status === "FAIL")    fail++;
      else                           blocked++;
      console.error(`[LOCAL] Zephyr: ${tcKey} → ${status}`);
    } catch (e) {
      console.error(`[LOCAL] Zephyr update failed for ${tcKey}: ${e.message}`);
    }
  }

  // 6. Post results comment on Jira story
  const icon    = fail === 0 && testResults.length > 0 ? "✅" : "❌";
  const summary = fail === 0 && testResults.length > 0 ? "All tests passed."
    : testResults.length === 0 ? "Tests could not run — check Java/Maven setup."
    : `${fail} test(s) failed.`;

  const finalComment =
    `${icon} *Local Selenium Results for ${issueKey}*\n\n` +
    `• ✅ Passed:  ${pass}\n• ❌ Failed:  ${fail}\n• ⏸ Blocked: ${blocked}\n\n` +
    `${summary}\n` +
    (cycleId ? `Zephyr cycle *${cycleId}* updated.\n` : "") +
    `Source: Local Maven + Selenium WebDriver headless Chrome.`;

  try {
    await jiraRequest("POST", `/issue/${issueKey}/comment`, { body: textToADF(finalComment) });
    console.error(`[LOCAL] Results comment posted on ${issueKey}`);
  } catch (e) {
    console.error(`[LOCAL] Comment failed: ${e.message}`);
  }

  // 7. Cleanup
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ok */ }

  return { cycleId, pass, fail, blocked };
}

// ─── Main pipeline ────────────────────────────────────────────────────────────
async function autoGenerateTCsForStory(issueKey) {
  console.error(`[AUTO] Starting TC generation for ${issueKey}...`);

  // 1. Fetch the Jira story
  const issue = await jiraRequest("GET", `/issue/${issueKey}?fields=summary,description,issuetype,status`);
  const summary     = issue.fields?.summary     || "";
  const description = extractTextFromADF(issue.fields?.description) || "";
  const issueType   = issue.fields?.issuetype?.name || "";

  if (issueType !== "Story") {
    console.error(`[AUTO] Skipping ${issueKey} — not a Story (type: ${issueType})`);
    return { skipped: true, reason: `Not a Story (${issueType})` };
  }

  // 2. Ask Claude to generate test cases as JSON
  const prompt = `You are a QA engineer. Generate exactly 5 test cases for this Jira story.

Story Key: ${issueKey}
Summary: ${summary}
Description: ${description.slice(0, 500)}

CRITICAL RULES:
- Return ONLY a raw JSON array, nothing else
- No markdown, no backticks, no explanation
- Keep each field SHORT (under 100 chars)
- Each step: max 3 steps, each line under 80 chars
- Exactly 5 test cases

Format:
[{"title":"string","type":"positive","priority":"High","description":"string","objective":"string","preconditions":"string","steps":[{"step":"string","testData":"","expectedResult":"string"}]}]`;

  let testCases;
  try {
    const aiResponse = await anthropicRequest(
      [{ role: "user", content: prompt }],
      { maxTokens: 8000, system: "Return only valid JSON arrays. No markdown. No explanation. Keep all text values short." }
    );
    const cleaned = aiResponse.replace(/```json|```/gi, "").trim();
    // Try to fix truncated JSON by finding last complete object
    let jsonStr = cleaned;
    try {
      testCases = JSON.parse(jsonStr);
    } catch {
      // Find last complete TC by looking for last }] or },
      const lastComplete = jsonStr.lastIndexOf("},");
      if (lastComplete > 0) {
        jsonStr = jsonStr.slice(0, lastComplete + 1) + "]";
        testCases = JSON.parse(jsonStr);
        console.error(`[AUTO] JSON was truncated — recovered ${testCases.length} TCs`);
      } else {
        throw new Error("JSON could not be recovered");
      }
    }
    console.error(`[AUTO] Claude generated ${testCases.length} TCs for ${issueKey}`);
  } catch (err) {
    console.error(`[AUTO] AI generation failed for ${issueKey}: ${err.message}`);
    throw new Error(`AI TC generation failed: ${err.message}`);
  }

  // 3. Push TCs to Zephyr and link to story
  const result = await handleGenerateInZephyr({ issueKey, testCases });
  console.error(`[AUTO] Created ${result.totalCreated} TCs in Zephyr for ${issueKey}`);

  // 4. Post initial comment confirming TC creation
  const tcKeys = (result.createdKeys || []).join(", ");
  const comment =
    `🔄 *Automated QA:* ${result.totalCreated} test case(s) generated in Zephyr Scale.\n` +
    `TC Keys: ${tcKeys}\n` +
    `Now generating Selenium scripts and running locally...`;
  try {
    await jiraRequest("POST", `/issue/${issueKey}/comment`, { body: textToADF(comment) });
  } catch (err) {
    console.error(`[AUTO] Could not post comment: ${err.message}`);
  }

  // 5. Generate Selenium Java scripts per TC
  const scriptMap = {};
  for (const item of (result.created || [])) {
    const tcKey = item.zephyrKey;
    const tc    = item.tc || testCases.find((t) => t.title === item.title) || {};
    try {
      const javaSource = await generateSeleniumScript(tcKey, tc, issueKey);
      const className  = toJavaClassName(tc.title || item.title);
      scriptMap[tcKey] = { javaSource, className };
      console.error(`[AUTO] Script generated: ${className}.java for ${tcKey}`);
    } catch (e) {
      console.error(`[AUTO] Script gen failed for ${tcKey}: ${e.message}`);
    }
  }

  // 6. Run mvn test locally + update Zephyr
  if (Object.keys(scriptMap).length > 0) {
    try {
      await runSeleniumLocally(issueKey, scriptMap);
    } catch (e) {
      console.error(`[AUTO] Local run failed: ${e.message}`);
      try {
        await jiraRequest("POST", `/issue/${issueKey}/comment`, {
          body: textToADF(`❌ Selenium run failed: ${e.message}\nCheck Java + Maven are installed.`),
        });
      } catch { /* ok */ }
    }
  } else {
    console.error(`[AUTO] No scripts generated — skipping local run`);
  }

  return {
    issueKey,
    totalCreated: result.totalCreated,
    tcKeys: result.createdKeys || [],
    scriptsGenerated: Object.keys(scriptMap).length,
    message: `✅ Auto-generated ${result.totalCreated} TCs + ran Selenium for ${issueKey}`,
  };
}

// ── 1. Webhook Server ─────────────────────────────────────────────────────────

const webhookApp = express();
webhookApp.use(express.json());

// Health check
webhookApp.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "jira-zephyr-mcp-automation", time: new Date().toISOString() });
});

// Main webhook — called by Jira Automation on Story creation
webhookApp.post("/webhook/story-created", async (req, res) => {
  const { issueKey } = req.body;

  if (!issueKey) {
    return res.status(400).json({ error: "Missing issueKey in request body" });
  }

  console.error(`[WEBHOOK] Received story-created event for ${issueKey}`);

  // Respond immediately so Jira doesn't time out
  res.json({ status: "accepted", issueKey, message: "TC generation started" });

  // Run pipeline asynchronously
  try {
    const result = await autoGenerateTCsForStory(issueKey);
    console.error(`[WEBHOOK] Done: ${JSON.stringify(result)}`);
  } catch (err) {
    console.error(`[WEBHOOK] Pipeline failed for ${issueKey}: ${err.message}`);
  }
});

// Start webhook server
webhookApp.listen(WEBHOOK_PORT, () => {
  console.error(`[WEBHOOK] Listening on port ${WEBHOOK_PORT}`);
  console.error(`[WEBHOOK] Endpoint: POST http://localhost:${WEBHOOK_PORT}/webhook/story-created`);
  console.error(`[WEBHOOK] Health:   GET  http://localhost:${WEBHOOK_PORT}/health`);
});

// ── 2. Nightly Cron Job ───────────────────────────────────────────────────────
//  Runs every night at midnight.
//  Finds all Stories with status "To Do" that haven't been processed yet
//  (detected by absence of a "Automated QA" comment).

cron.schedule("0 0 * * *", async () => {
  console.error("[CRON] Nightly TC generation job started...");

  try {
    // Fetch all "To Do" Stories across all projects
    const searchResult = await jiraRequest(
      "GET",
      `/search?jql=${encodeURIComponent('issuetype = Story AND status = "To Do" ORDER BY created DESC')}&maxResults=50&fields=summary,description,comment`
    );

    const stories = searchResult.issues || [];
    console.error(`[CRON] Found ${stories.length} "To Do" stories to process`);

    let processed = 0;
    let skipped   = 0;

    for (const story of stories) {
      const issueKey = story.key;

      // Skip stories that already have an auto-generated comment
      const comments = story.fields?.comment?.comments || [];
      const alreadyProcessed = comments.some((c) =>
        extractTextFromADF(c.body)?.includes("Automated QA")
      );

      if (alreadyProcessed) {
        console.error(`[CRON] Skipping ${issueKey} — already processed`);
        skipped++;
        continue;
      }

      try {
        await autoGenerateTCsForStory(issueKey);
        processed++;
        // Small delay between stories to avoid rate limiting
        await new Promise((r) => setTimeout(r, 2000));
      } catch (err) {
        console.error(`[CRON] Failed for ${issueKey}: ${err.message}`);
      }
    }

    console.error(`[CRON] Done. Processed: ${processed}, Skipped: ${skipped}`);
  } catch (err) {
    console.error(`[CRON] Job failed: ${err.message}`);
  }
}, {
  scheduled: true,
  timezone: "Africa/Cairo",
});

console.error("[CRON] Nightly job scheduled — runs every day at 00:00 Cairo time");
