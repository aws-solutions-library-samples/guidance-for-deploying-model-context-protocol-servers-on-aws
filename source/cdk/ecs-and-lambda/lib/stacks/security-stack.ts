import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { NagSuppressions } from "cdk-nag";
import { StandardThreatProtectionMode } from "aws-cdk-lib/aws-cognito";

export interface SecurityStackProps extends cdk.StackProps {
  /**
   * The VPC where resources will be deployed
   */
  vpc: ec2.IVpc;

  /**
   * Resource suffix for unique naming
   */
  resourceSuffix: string;
  domainSuffix: string;
}

export class SecurityStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly appClientClientCredentials: cognito.UserPoolClient;
  public readonly appClientUser: cognito.UserPoolClient;
  public readonly webAcl: wafv2.CfnWebACL;

  constructor(scope: Construct, id: string, props: SecurityStackProps) {
    super(scope, id, props);

    // Create Cognito User Pool
    this.userPool = new cognito.UserPool(this, "MCPServerUserPool", {
      userPoolName: "mcp-server-user-pool",
      selfSignUpEnabled: true, // Allow users to sign up
      featurePlan: cognito.FeaturePlan.PLUS,
      standardThreatProtectionMode: StandardThreatProtectionMode.FULL_FUNCTION,
      signInAliases: {
        username: true,
        email: true,
      },
      autoVerify: {
        email: true,
      },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For demo purposes only

      // Enable MFA configuration with TOTP only
      mfa: cognito.Mfa.REQUIRED, // Allow users to enable MFA
      mfaSecondFactor: {
        sms: false,
        otp: true, // Enable TOTP only
      },
    });

    // Add domain for hosted UI
    const domainPrefix = `mcp-server-${props.domainSuffix}`;

    this.userPool.addDomain("CognitoDomain", {
      cognitoDomain: {
        domainPrefix,
      },
    });

    // Create resource server for OAuth scopes
    const resourceServer = this.userPool.addResourceServer(
      "MCPResourceServer",
      {
        identifier: "mcp-server",
        scopes: [
          {
            scopeName: "read",
            scopeDescription: "Read access to MCP Server",
          },
          {
            scopeName: "write",
            scopeDescription: "Write access to MCP Server",
          },
        ],
      }
    );

    // Create app client for interactive user authentication
    this.appClientUser = this.userPool.addClient("mcp-user-client", {
      userPoolClientName: "mcp-user-client",
      generateSecret: true,
      authFlows: {
        userPassword: true,
        adminUserPassword: true,
        userSrp: true,
      },
      accessTokenValidity: cdk.Duration.minutes(60), // default is 60 minutes
      idTokenValidity: cdk.Duration.minutes(60), // default is 60 minutes
      refreshTokenValidity: cdk.Duration.days(30), // default is 30 days
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: true,
        },
        scopes: [
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.PROFILE,
          cognito.OAuthScope.resourceServer(resourceServer, {
            scopeName: "read",
            scopeDescription: "Read access to MCP Server",
          }),
          cognito.OAuthScope.resourceServer(resourceServer, {
            scopeName: "write",
            scopeDescription: "Write access to MCP Server",
          }),
        ],
        callbackUrls: [
          "http://localhost:2299/callback", // for local development/testing with sample-auth-python server
        ],
      },
      preventUserExistenceErrors: true,
    });

    // Create WAF Web ACL
    this.webAcl = new wafv2.CfnWebACL(this, "MCPServerWAF", {
      name: "mcp-server-waf",
      defaultAction: { allow: {} },
      scope: "REGIONAL",
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "MCPServerWAF",
        sampledRequestsEnabled: true,
      },
      rules: [
        // AWS Managed Rules - Core rule set
        {
          name: "AWS-AWSManagedRulesCommonRuleSet",
          priority: 10,
          statement: {
            managedRuleGroupStatement: {
              name: "AWSManagedRulesCommonRuleSet",
              vendorName: "AWS",
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "AWS-AWSManagedRulesCommonRuleSet",
            sampledRequestsEnabled: true,
          },
        },
        // Rate-based rule to prevent DDoS
        {
          name: "RateLimitRule",
          priority: 20,
          statement: {
            rateBasedStatement: {
              limit: 1000,
              aggregateKeyType: "IP",
            },
          },
          action: { block: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "RateLimitRule",
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    // Output Client ID and endpoint
    new cdk.CfnOutput(this, "UserPoolId", {
      value: this.userPool.userPoolId,
      description: "The ID of the Cognito User Pool",
    });

    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: this.appClientUser.userPoolClientId,
      description: "The Client ID for the Cognito User Pool Client",
    });

    // Store the user pool ID in SSM for later use in MCP server stack
    new ssm.StringParameter(this, "UserPoolIdParameter", {
      parameterName: `/mcp/cognito/user-pool-id-${props.resourceSuffix}`,
      description: "The user pool ID for user authentication",
      stringValue: this.userPool.userPoolId,
    });

    // Store the app client ID in SSM for later use in MCP server stack
    new ssm.StringParameter(this, "UserPoolClientIdParameter", {
      parameterName: `/mcp/cognito/user-pool-client-id-${props.resourceSuffix}`,
      description: "The user pool client ID for user authentication",
      stringValue: this.appClientUser.userPoolClientId,
    });

    // Add suppressions for CDK nag rules
    NagSuppressions.addStackSuppressions(this, [
      {
        id: "AwsSolutions-IAM4",
        reason:
          "SSM Parameter custom resource Lambda function requires basic execution role for CloudWatch logs",
        appliesTo: [
          "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        ],
      },
      {
        id: "AwsSolutions-L1",
        reason:
          "SSM Parameter custom resource Lambda function uses runtime defined by L2 construct",
      },
    ]);
  }
}
