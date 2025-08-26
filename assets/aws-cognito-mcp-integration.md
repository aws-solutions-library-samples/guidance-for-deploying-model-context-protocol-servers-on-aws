# AWS Cognito Integration with MCP Server

This document illustrates the technical architecture of AWS Cognito integration with MCP servers using OAuth 2.0 Protected Resource Metadata (RFC9728) and StreamableHTTP transport, implementing the 2025-06-18 MCP specification.

## OAuth 2.0 Protected Resource Flow

The complete Authorization flow proceeds as follows:

```mermaid
sequenceDiagram
    participant User as User-Agent (Browser)
    participant Client as Client
    participant MCP as MCP Server (Resource Server)
    participant AS as Authorization Server

    Note over Client,AS: Initial MCP request triggers OAuth flow
    Client->>MCP: MCP request without token
    MCP-->>Client: HTTP 401 Unauthorized with WWW-Authenticate header

    Note over Client: Extract resource_metadata URL from WWW-Authenticate
    Client->>MCP: Request Protected Resource Metadata
    MCP-->>Client: Return metadata

    Note over Client: Parse metadata and extract authorization server(s)<br/>Client determines AS to use
    Client->>AS: GET /.well-known/openid-configuration
    AS-->>Client: Authorization server metadata response

    Note over Client: Client uses pre-configured credentials<br/>(No dynamic client registration)

    Note over Client: Generate PKCE parameters<br/>Include resource parameter
    Client->>User: Open browser with authorization URL + code_challenge + resource
    User->>AS: Authorization request with resource parameter

    Note over AS: User authorizes
    AS->>User: Redirect to callback with authorization code
    User->>Client: Authorization code callback

    Client->>AS: Token request + code_verifier + resource
    AS-->>Client: Access token (+ refresh token)

    Client->>MCP: MCP request with access token
    MCP-->>Client: MCP response

    Note over Client,MCP: MCP communication continues with valid token
```

## Architecture Components

```mermaid
flowchart TD
    %% Client and User Agent
    User["User-Agent (Browser)"]
    Client["MCP Client"]

    %% MCP Server Components
    subgraph "MCP Server on AWS"
        CloudFront["AWS CloudFront<br/>HTTPS Distribution"]
        ALB["Application Load Balancer"]
        ECS["ECS Fargate Cluster / Lambda"]

        subgraph "MCP Server Container"
            MCPEndpoint["MCP StreamableHTTP Endpoint<br/>/mcp"]
            WellKnown["OAuth Protected Resource Metadata<br/>/.well-known/oauth-protected-resource"]
            AuthMiddleware["Authentication Middleware<br/>(Token Validation)"]
            MCPTools["MCP Tools & Resources<br/>(Weather API)"]
        end

        %% Container connections
        MCPEndpoint --- AuthMiddleware
        AuthMiddleware --- MCPTools
        WellKnown -.-> MCPEndpoint
    end

    %% AWS Cognito Components
    subgraph "AWS Cognito (Authorization Server)"
        UserPool["Cognito User Pool"]
        AppClient["App Client<br/>with OIDC scopes"]
        Domain["Cognito Domain<br/>{prefix}.auth.{region}.amazoncognito.com"]
        WellKnownAS["/.well-known/openid-configuration"]

        %% Cognito internal connections
        UserPool --- AppClient
        UserPool --- Domain
        UserPool --- WellKnownAS
    end

    %% AWS Supporting Services
    subgraph "Supporting AWS Services"
        SSM["SSM Parameter Store<br/>- HTTPS URLs<br/>- User Pool IDs<br/>- Client Credentials"]
        WAF["AWS WAF"]
    end

    %% External connections
    User <--> Client
    User <--> CloudFront
    User <--> Domain

    %% AWS Architecture flow
    Client <--> CloudFront
    CloudFront <--> ALB
    ALB <--> ECS
    WAF -.-> CloudFront

    %% Authentication flow
    AuthMiddleware <--> UserPool
    Client <--> WellKnown
    Client <--> WellKnownAS
    AuthMiddleware -..-> SSM
    ECS -..-> SSM

    %% CDK Deployment components
    subgraph "CDK Deployment"
        VPCStack["VPC Stack<br/>- VPC<br/>- Subnets<br/>- Security Groups"]
        SecurityStack["Security Stack<br/>- User Pool<br/>- App Client"]
        CloudFrontWAFStack["CloudFront WAF Stack<br/>- WAF Web ACL<br/>- (us-east-1 only)"]
        MCPServerStack["MCP Server Stack<br/>- Fargate/Lambda Service<br/>- CloudFront<br/>- ALB"]
        CrossRegionSync["Cross-Region<br/>Parameter Sync"]

        VPCStack --> MCPServerStack
        SecurityStack --> MCPServerStack
        CloudFrontWAFStack --> MCPServerStack
        CloudFrontWAFStack --> CrossRegionSync
    end

    %% Environment Variables Configuration
    subgraph "Container Environment"
        EnvVars["Environment Variables<br/>- COGNITO_USER_POOL_ID<br/>- COGNITO_CLIENT_ID<br/>- COGNITO_CLIENT_SECRET<br/>- BASE_URL"]
    end

    MCPServerStack --> EnvVars
    EnvVars --> AuthMiddleware

    %% Legend
    classDef aws fill:#FF9900,stroke:#232F3E,color:white
    classDef mcp fill:#1D3557,stroke:#457B9D,color:white
    class UserPool,AppClient,Domain,WellKnownAS,CloudFront,ALB,ECS,SSM,WAF,CrossRegionSync aws
    class MCPEndpoint,WellKnown,AuthMiddleware,MCPTools,Client aws

    %% Style for CDK stacks
    classDef cdkStack fill:#232F3E,stroke:#FF9900,color:white
    class VPCStack,SecurityStack,CloudFrontWAFStack,MCPServerStack cdkStack
```

## Key Implementation Details

### OAuth 2.0 Protected Resource Metadata (RFC9728)

The MCP server implements OAuth 2.0 Protected Resource Metadata specification:

- **Endpoint**: `/.well-known/oauth-protected-resource`
- **Purpose**: Advertises OAuth configuration and authorization servers
- **Content**: JSON metadata including resource identifier and supported authorization servers

### WWW-Authenticate Header

When unauthorized requests are made to the MCP endpoint:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="mcp-server", resource_metadata="https://example.com/.well-known/oauth-protected-resource"
```

### StreamableHTTP Transport

- **Protocol**: HTTP/HTTPS with JSON-RPC 2.0 over POST requests
- **Stateless**: Each request creates a new server instance for concurrent client support
- **Authentication**: Bearer token validation on each request
- **Endpoints**:
  - `POST /mcp` - Main MCP communication endpoint
  - `GET /.well-known/oauth-protected-resource` - OAuth metadata endpoint

### Token Validation Flow

1. Client makes MCP request without authentication
2. Server responds with 401 and WWW-Authenticate header
3. Client discovers OAuth metadata from protected resource endpoint
4. Client performs OAuth authorization code flow with PKCE
5. Client includes resource parameter in OAuth requests
6. Client makes authenticated MCP requests with bearer token
7. Server validates token against AWS Cognito User Pool

### Environment Configuration

The MCP server requires these environment variables:

- `COGNITO_USER_POOL_ID` - AWS Cognito User Pool identifier
- `COGNITO_CLIENT_ID` - OAuth client identifier (optional for public clients)
- `COGNITO_CLIENT_SECRET` - OAuth client secret (for confidential clients)
- `BASE_URL` - Base URL for generating OAuth metadata
- `AWS_REGION` - AWS region for Cognito integration

### Deployment Architecture

- **VPC Stack**: Creates VPC, subnets, and security groups for network infrastructure
- **Security Stack**: Creates Cognito User Pool and App Client for authentication
- **CloudFront WAF Stack**: Creates WAF Web ACL for CloudFront (deployed in us-east-1 only)
- **MCP Server Stack**: Deploys Fargate service or Lambda function, CloudFront distribution, and Application Load Balancer
- **Cross-Region Sync**: Synchronizes CloudFront WAF parameters across AWS regions

### Client Implementation

The Python client demonstrates:

- **Pre-configured Client Credentials**: Uses static client ID/secret (no dynamic client registration)
- **PKCE Flow**: Proof Key for Code Exchange for enhanced security
- **Resource Parameters**: Including resource identifier in OAuth requests
- **Token Management**: Automatic token refresh and storage
- **Interactive Interface**: Command-line interface for testing MCP tools

### Important Limitations

- **No Dynamic Client Registration (DCR)**: This implementation does not support dynamic client registration. Client credentials must be pre-configured in AWS Cognito and provided via environment variables.

This implementation follows the 2025-06-18 MCP specification with full OAuth 2.0 Protected Resource support, enabling secure and standards-compliant authentication for MCP servers deployed on AWS.
