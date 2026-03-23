import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import "dotenv/config";
import express, { Request, Response } from "express";
import { z } from "zod";
import chalk from "chalk";
import axios from "axios";
import * as cheerio from "cheerio";

// ============================================================================
// 1. Core Logic: Tailwind & Figma Utilities
// ============================================================================

const getTailwindClass = (pixelValue: string, prefix: string, breakpoint?: string): string => {
  const pixels = parseInt(pixelValue.replace("px", ""));
  if (isNaN(pixels)) return "unknown";

  const tailwindValue = pixels / 4;
  const standardScale = [
    0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 
    11, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 96
  ];

  let baseClass = standardScale.includes(tailwindValue) 
    ? `${prefix}-${tailwindValue}` 
    : `${prefix}-[${pixels}px]`;

  return breakpoint ? `${breakpoint}:${baseClass}` : baseClass;
};

const parseFigmaUrl = (url: string) => {
  const fileKeyMatch = url.match(/\/design\/([a-zA-Z0-9]+)/) || url.match(/\/file\/([a-zA-Z0-9]+)/);
  const nodeIdMatch = url.match(/node-id=([a-zA-Z0-9%:-]+)/);
  
  return {
    fileKey: fileKeyMatch ? fileKeyMatch[1] : null,
    nodeId: nodeIdMatch ? decodeURIComponent(nodeIdMatch[1]) : null,
  };
};

// ============================================================================
// 2. MCP Server Configuration
// ============================================================================

const server = new McpServer({
  name: "universal-ui-auditor",
  version: "2.1.0",
});

const FIGMA_API_URL = "https://api.figma.com/v1";

// ----------------------------------------------------------------------------
// Tool: Professional UI Audit (Token-on-Demand)
// ----------------------------------------------------------------------------
server.registerTool(
  "audit_ui_consistency",
  {
    title: "Universal UI Audit",
    description: "Compare live site styles against Figma using your own Figma Access Token",
    inputSchema: {
      liveUrl: z.string().url().describe("The URL of the live site to audit"),
      selector: z.string().describe("CSS Selector of the element (e.g., '.primary-button')"),
      figmaUrl: z.string().url().describe("The Figma link to the design element"),
      figmaToken: z.string().describe("Your Personal Figma Access Token (Generate in Figma Settings)"),
      breakpoint: z.enum(["sm", "md", "lg", "xl", "2xl"]).optional().describe("Tailwind breakpoint prefix"),
    },
  },
  async ({ liveUrl, selector, figmaUrl, figmaToken, breakpoint }) => {
    const { fileKey, nodeId } = parseFigmaUrl(figmaUrl);
    if (!fileKey || !nodeId) return { content: [{ type: "text", text: "Error: Invalid Figma URL format." }] };

    try {
      console.log(chalk.blue(`[Audit] Fetching Figma node using provided token...`));
      
      // 1. Fetch Design Specs from Figma using the user's provided token
      const figmaRes = await axios.get(`${FIGMA_API_URL}/files/${fileKey}/nodes?ids=${nodeId}`, {
        headers: { "X-Figma-Token": figmaToken }
      });
      
      const node = figmaRes.data.nodes[nodeId].node;
      const figmaPadding = `${node.paddingTop || 0}px`;
      const expectedClass = getTailwindClass(figmaPadding, "p", breakpoint);

      // 2. Fetch Live Site HTML
      console.log(chalk.blue(`[Audit] Scraping live site: ${liveUrl}`));
      const { data: html } = await axios.get(liveUrl, { timeout: 8000 });
      const $ = cheerio.load(html);
      const element = $(selector);

      if (!element.length) return { content: [{ type: "text", text: `Error: Element "${selector}" not found.` }] };

      const classes = element.attr("class") || "";
      const isMatch = classes.includes(expectedClass);

      // 3. Generate Report
      const statusIcon = isMatch ? "✅" : "❌";
      return {
        content: [{ 
          type: "text", 
          text: `### ${statusIcon} UI Consistency Audit\n` +
                `- **Selector:** \`${selector}\`\n` +
                `- **Figma Spec:** ${figmaPadding}\n` +
                `- **Required Tailwind Class:** \`${expectedClass}\`\n` +
                `- **Current Live Classes:** \`${classes}\`\n` +
                `- **Verdict:** ${isMatch ? "Perfect Match!" : `Update required to \`${expectedClass}\`.`}`
        }],
        structuredContent: { isMatch, expectedClass, actualClasses: classes },
      };
    } catch (error: any) {
      const errorMessage = error.response?.status === 403 
        ? "Invalid Figma Token provided." 
        : error.message;
      console.error(chalk.red(`[Error] ${errorMessage}`));
      return { content: [{ type: "text", text: `Audit Failed: ${errorMessage}` }] };
    }
  }
);

// ============================================================================
// 3. Express Server Setup
// ============================================================================

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "healthy" }));

app.post("/mcp", async (req: Request, res: Response) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    console.log(chalk.gray("[System] Transport Disconnected"));
    transport.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(chalk.bold.green("\n🚀 Universal UI Auditor MCP v2.1.0"));
  console.log(chalk.cyan(`   Listening on: http://localhost:${port}/mcp`));
  console.log(chalk.yellow(`   Note: This server requires users to provide their own Figma Token.\n`));
});