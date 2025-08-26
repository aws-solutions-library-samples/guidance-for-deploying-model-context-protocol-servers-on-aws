import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { validateCognitoToken } from "./oauth-cognito.js";
import { z } from "zod";
import express, { Request, Response, NextFunction } from "express";

const NWS_API_BASE = "https://api.weather.gov";
const USER_AGENT = "weather-app/1.0";

const getServer = () => {
  // Create server instance
  const server = new McpServer({
    name: "weather",
    version: "1.0.0",
    capabilities: {
      resources: {},
      tools: {},
    },
  });

  // Helper function for making NWS API requests
  async function makeNWSRequest<T>(url: string): Promise<T | null> {
    const headers = {
      "User-Agent": USER_AGENT,
      Accept: "application/geo+json",
    };

    try {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      console.error("Error making NWS request:", error);
      return null;
    }
  }

  interface AlertFeature {
    properties: {
      event?: string;
      areaDesc?: string;
      severity?: string;
      status?: string;
      headline?: string;
    };
  }

  // Format alert data
  function formatAlert(feature: AlertFeature): string {
    const props = feature.properties;
    return [
      `Event: ${props.event || "Unknown"}`,
      `Area: ${props.areaDesc || "Unknown"}`,
      `Severity: ${props.severity || "Unknown"}`,
      `Status: ${props.status || "Unknown"}`,
      `Headline: ${props.headline || "No headline"}`,
      "---",
    ].join("\n");
  }

  interface ForecastPeriod {
    name?: string;
    temperature?: number;
    temperatureUnit?: string;
    windSpeed?: string;
    windDirection?: string;
    shortForecast?: string;
  }

  interface AlertsResponse {
    features: AlertFeature[];
  }

  interface PointsResponse {
    properties: {
      forecast?: string;
    };
  }

  interface ForecastResponse {
    properties: {
      periods: ForecastPeriod[];
    };
  }

  // Register weather tools
  server.tool(
    "get_alerts",
    "Get weather alerts for a state",
    {
      state: z
        .string()
        .length(2)
        .describe("Two-letter state code (e.g. CA, NY)"),
    },
    async ({ state }) => {
      const stateCode = state.toUpperCase();
      const alertsUrl = `${NWS_API_BASE}/alerts?area=${stateCode}`;
      const alertsData = await makeNWSRequest<AlertsResponse>(alertsUrl);

      if (!alertsData) {
        return {
          content: [
            {
              type: "text",
              text: "Failed to retrieve alerts data",
            },
          ],
        };
      }

      const features = alertsData.features || [];
      if (features.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No active alerts for ${stateCode}`,
            },
          ],
        };
      }

      const formattedAlerts = features.map(formatAlert);
      const alertsText = `Active alerts for ${stateCode}:\n\n${formattedAlerts.join(
        "\n"
      )}`;

      return {
        content: [
          {
            type: "text",
            text: alertsText,
          },
        ],
      };
    }
  );

  server.tool(
    "get_forecast",
    "Get weather forecast for a location",
    {
      latitude: z
        .number()
        .min(-90)
        .max(90)
        .describe("Latitude of the location"),
      longitude: z
        .number()
        .min(-180)
        .max(180)
        .describe("Longitude of the location"),
    },
    async ({ latitude, longitude }) => {
      // Get grid point data
      const pointsUrl = `${NWS_API_BASE}/points/${latitude.toFixed(
        4
      )},${longitude.toFixed(4)}`;
      const pointsData = await makeNWSRequest<PointsResponse>(pointsUrl);

      if (!pointsData) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to retrieve grid point data for coordinates: ${latitude}, ${longitude}. This location may not be supported by the NWS API (only US locations are supported).`,
            },
          ],
        };
      }

      const forecastUrl = pointsData.properties?.forecast;
      if (!forecastUrl) {
        return {
          content: [
            {
              type: "text",
              text: "Failed to get forecast URL from grid point data",
            },
          ],
        };
      }

      // Get forecast data
      const forecastData = await makeNWSRequest<ForecastResponse>(forecastUrl);
      if (!forecastData) {
        return {
          content: [
            {
              type: "text",
              text: "Failed to retrieve forecast data",
            },
          ],
        };
      }

      const periods = forecastData.properties?.periods || [];
      if (periods.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No forecast periods available",
            },
          ],
        };
      }

      // Format forecast periods
      const formattedForecast = periods.map((period: ForecastPeriod) =>
        [
          `${period.name || "Unknown"}:`,
          `Temperature: ${period.temperature || "Unknown"}°${
            period.temperatureUnit || "F"
          }`,
          `Wind: ${period.windSpeed || "Unknown"} ${
            period.windDirection || ""
          }`,
          `${period.shortForecast || "No forecast available"}`,
          "---",
        ].join("\n")
      );

      const forecastText = `Forecast for ${latitude}, ${longitude}:\n\n${formattedForecast.join(
        "\n"
      )}`;

      return {
        content: [
          {
            type: "text",
            text: forecastText,
          },
        ],
      };
    }
  );

  return server;
};

const app = express();
app.use(express.json());

/**
 * Get WWW-Authenticate header for 401 responses.
 */
function getWWWAuthenticateHeader(req: Request): string {
  // Check X-Forwarded-Proto from ALB/CloudFront, fallback to req.protocol for local testing
  const protocol = req.get("X-Forwarded-Proto") || req.protocol;
  const baseUrl = process.env.BASE_URL || `${protocol}://${req.get("host")}`;
  const val = `Bearer realm="mcp-server", resource_metadata="${baseUrl}/weather-nodejs-lambda/.well-known/oauth-protected-resource"`;
  console.log(val);
  return val;
}

/**
 * Send a 401 Unauthorized response with the appropriate WWW-Authenticate header.
 */
function sendUnauthorizedResponse(req: Request, res: Response): void {
  res.setHeader("WWW-Authenticate", getWWWAuthenticateHeader(req));
  res.status(401).json({
    jsonrpc: "2.0",
    error: {
      code: -32600,
      message: "Unauthorized. Valid authentication credentials required.",
    },
    id: null,
  });
}

/**
 * Middleware to authenticate requests using Cognito tokens.
 */
const authMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return sendUnauthorizedResponse(req, res);
  }

  const token = authHeader.substring(7); // Remove 'Bearer ' prefix

  // Check if token is actually present after "Bearer "
  if (!token || token.trim() === "") {
    return sendUnauthorizedResponse(req, res);
  }

  try {
    const { isValid } = await validateCognitoToken(token);
    if (!isValid) {
      return sendUnauthorizedResponse(req, res);
    }
  } catch (error) {
    console.error("Token validation error:", error);
    return sendUnauthorizedResponse(req, res);
  }

  next();
};

/**
 * OAuth 2.0 Protected Resource Metadata endpoint.
 * Implements RFC9728 specification.
 */
app.get(
  "/weather-nodejs-lambda/.well-known/oauth-protected-resource",
  (req: Request, res: Response) => {
    const region = process.env.AWS_REGION || "us-west-2";
    const user_pool_id = process.env.COGNITO_USER_POOL_ID;
    const baseUrl = process.env.BASE_URL || `https://${req.get("host")}`;

    res.json({
      resource: `${baseUrl}/weather-nodejs-lambda/mcp`,
      authorization_servers: [
        `https://cognito-idp.${region}.amazonaws.com/${user_pool_id}`,
      ],
      bearer_methods_supported: ["header"],
      scopes_supported: ["openid", "email", "profile"], // adjust as needed
    });
  }
);

// Health check
app.get("/weather-nodejs-lambda/", async (req: Request, res: Response) => {
  res.status(200).json({
    status: "healthy",
    service: "weather-nodejs-lambda",
  });
});

// Apply authentication middleware to MCP endpoints
app.use("/weather-nodejs-lambda/mcp", authMiddleware);

app.post("/weather-nodejs-lambda/mcp", async (req: Request, res: Response) => {
  // In stateless mode, create a new instance of transport and server for each request
  // to ensure complete isolation. A single instance would cause request ID collisions
  // when multiple clients connect concurrently.

  try {
    const server = getServer();
    const transport: StreamableHTTPServerTransport =
      new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
    res.on("close", () => {
      console.log("Request closed");
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
});

// SSE notifications not supported in stateless mode
app.get("/weather-nodejs-lambda/mcp", async (req: Request, res: Response) => {
  console.log("Received GET MCP request");
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    })
  );
});

// Session termination not needed in stateless mode
app.delete(
  "/weather-nodejs-lambda/mcp",
  async (req: Request, res: Response) => {
    console.log("Received DELETE MCP request");
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed.",
        },
        id: null,
      })
    );
  }
);

// Start the server
const PORT = process.env.PORT || 3001;
app.listen(PORT);
