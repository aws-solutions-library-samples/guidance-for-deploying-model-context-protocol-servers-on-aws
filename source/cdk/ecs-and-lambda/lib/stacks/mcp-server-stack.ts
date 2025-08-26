import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as path from "path";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53targets from "aws-cdk-lib/aws-route53-targets";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import { McpFargateServerConstruct } from "../constructs/mcp-fargate-server-construct";
import { NagSuppressions } from "cdk-nag";
import { McpLambdaServerlessConstruct } from "../constructs/mcp-lambda-serverless-construct";
import { getAllowedCountries } from "../constants/geo-restrictions";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";

export interface MCPServerStackProps extends cdk.StackProps {
  /**
   * Suffix to append to resource names
   */
  resourceSuffix: string;
  vpc: ec2.IVpc;
}

/**
 * Combined stack for MCP platform and servers to avoid circular dependencies
 */
export class MCPServerStack extends cdk.Stack {
  public readonly albSecurityGroup: ec2.SecurityGroup;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly cluster: ecs.Cluster;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: MCPServerStackProps) {
    super(scope, id, props);

    // Get CloudFront WAF ARN from SSM (written by CloudFrontWafStack)
    const cloudFrontWafArnParam =
      ssm.StringParameter.fromStringParameterAttributes(
        this,
        "CloudFrontWafArnParam",
        {
          parameterName: `/mcp/cloudfront-waf-arn-${props.resourceSuffix}`,
        }
      );

    // Get Cognito User Pool ID from SSM (written by SecurityStack)
    const userPoolIdParam = ssm.StringParameter.fromStringParameterAttributes(
      this,
      "UserPoolIdParam",
      {
        parameterName: `/mcp/cognito/user-pool-id-${props.resourceSuffix}`,
      }
    );

    // Get Cognito User Pool Client ID from SSM (written by SecurityStack)
    const userPoolClientIdParam =
      ssm.StringParameter.fromStringParameterAttributes(
        this,
        "UserPoolClientIdParam",
        {
          parameterName: `/mcp/cognito/user-pool-client-id-${props.resourceSuffix}`,
        }
      );

    // Create shared ECS cluster for all MCP servers
    this.cluster = new ecs.Cluster(this, "MCPCluster", {
      vpc: props.vpc,
      //containerInsights: true,
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
    });

    // Add suppression for Container Insight (Deprecated) not be enabled while Container Insight V2 is enabled
    NagSuppressions.addResourceSuppressions(this.cluster, [
      {
        id: "AwsSolutions-ECS4",
        reason:
          "Container Insights V2 is Enabled with Enhanced capabilities, the Nag findings is about Container Insights (v1) which is deprecated",
      },
    ]);

    // Create context parameter for optional certificate ARN and custom domain
    const certificateArn = this.node.tryGetContext("certificateArn");
    const customDomain = this.node.tryGetContext("customDomain");

    // Validate that if certificate is provided, custom domain must also be provided
    if (certificateArn && !customDomain) {
      throw new Error(
        "Custom domain name must be provided when using a certificate. While CloudFront's default domain will support HTTPS, " +
          "the Application Load Balancer HTTPS listener and origin configuration require both a valid certificate and matching custom domain name."
      );
    }

    // Create HTTP and HTTPS security groups for the ALB
    const httpSecurityGroup = new ec2.SecurityGroup(
      this,
      `HttpSecurityGroup-${props.resourceSuffix}`,
      {
        vpc: props.vpc,
        allowAllOutbound: true,
        description: `HTTP Security group for MCP-Server Stack ALB`,
      }
    );

    const httpsSecurityGroup = new ec2.SecurityGroup(
      this,
      `HttpsSecurityGroup-${props.resourceSuffix}`,
      {
        vpc: props.vpc,
        allowAllOutbound: true,
        description: `HTTPS Security group for MCP-Server Stack ALB`,
      }
    );

    const cloudFrontPrefixList = ec2.PrefixList.fromLookup(
      this,
      "CloudFrontOriginFacing",
      {
        prefixListName: "com.amazonaws.global.cloudfront.origin-facing",
      }
    );

    // Add ingress rules to appropriate security group
    httpSecurityGroup.addIngressRule(
      ec2.Peer.prefixList(cloudFrontPrefixList.prefixListId),
      ec2.Port.tcp(80),
      "Allow HTTP traffic from CloudFront edge locations"
    );

    httpsSecurityGroup.addIngressRule(
      ec2.Peer.prefixList(cloudFrontPrefixList.prefixListId),
      ec2.Port.tcp(443),
      "Allow HTTPS traffic from CloudFront edge locations"
    );

    // Use the appropriate security group based on certificate presence
    this.albSecurityGroup = certificateArn
      ? httpsSecurityGroup
      : httpSecurityGroup;

    // Create S3 bucket for ALB and CloudFront access logs with proper encryption and lifecycle rules
    const accessLogsBucket = new cdk.aws_s3.Bucket(this, "AccessLogsBucket", {
      encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: cdk.aws_s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For dev environment (use RETAIN for prod)
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(30), // Retain logs for 30 days
        },
      ],
      serverAccessLogsPrefix: "server-access-logs/", // Separate prefix for server access logs
      objectOwnership: cdk.aws_s3.ObjectOwnership.BUCKET_OWNER_PREFERRED, // Required for CloudFront logging
    });

    // Create Application Load Balancer dedicated to this MCP server
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(
      this,
      `ApplicationLoadBalancer`,
      {
        vpc: props.vpc,
        internetFacing: true,
        securityGroup: this.albSecurityGroup,
        http2Enabled: true,
      }
    );

    // Enable access logging to S3
    this.loadBalancer.logAccessLogs(accessLogsBucket);

    const paramName = `/mcp/https-url`;

    // ****************************************************************
    // Model Context Prototcol Server(s) built on ECS Fargate
    // ****************************************************************

    // Deploy the NodeJs weather server with CloudFront
    const weatherNodeJsServer = new McpFargateServerConstruct(
      this,
      "WeatherNodeJsServer",
      {
        platform: {
          vpc: props.vpc,
          cluster: this.cluster,
        },
        serverName: "WeatherNodeJs",
        serverPath: path.join(
          __dirname,
          "../../servers/sample-ecs-weather-streamablehttp-stateless-nodejs-express"
        ),
        healthCheckPath: "/weather-nodejs/",
        environment: {
          PORT: "8080",
          BASE_PATH: "/weather-nodejs",
          AWS_REGION: this.region,
          COGNITO_USER_POOL_ID: userPoolIdParam.stringValue,
          COGNITO_CLIENT_ID: userPoolClientIdParam.stringValue,
        },
        albSecurityGroup: this.albSecurityGroup,
        urlParameterName: paramName,
      }
    );

    // ****************************************************************
    // Model Context Prototcol Server(s) built on Lambda
    // ****************************************************************

    // Deploy the NodeJS weather server using Streamable HTTP Transport (according to 2025-03-26 specification)
    const weatherLambda = new lambda.DockerImageFunction(
      this,
      "WeatherNodeJsLambda",
      {
        code: lambda.DockerImageCode.fromImageAsset(
          path.join(
            __dirname,
            "../../servers/sample-lambda-weather-streamablehttp-stateless-nodejs-express"
          ),
          { platform: Platform.LINUX_AMD64 }
        ),
        timeout: cdk.Duration.minutes(1),
        memorySize: 1024,
        environment: {
          COGNITO_USER_POOL_ID: userPoolIdParam.stringValue,
          COGNITO_CLIENT_ID: userPoolClientIdParam.stringValue,
          PORT: "8080",
        },
        vpc: props.vpc,
      }
    );

    const weatherNodeJsLambdaServer = new McpLambdaServerlessConstruct(
      this,
      "WeatherNodeJsLambdaServer",
      {
        vpc: props.vpc,
        function: weatherLambda,
      }
    );

    // Add suppression for Lambda basic execution role
    NagSuppressions.addResourceSuppressions(
      weatherLambda,
      [
        {
          id: "AwsSolutions-IAM4",
          reason:
            "Lambda function requires basic VPC and CloudWatch Logs permissions through managed policy",
          appliesTo: [
            "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
            "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
          ],
        },
      ],
      true
    );

    // Create either HTTP or HTTPS listener based on certificate presence
    const listener = certificateArn
      ? this.loadBalancer.addListener("HttpsListener", {
          port: 443,
          protocol: elbv2.ApplicationProtocol.HTTPS,
          certificates: [
            acm.Certificate.fromCertificateArn(
              this,
              "AlbCertificate",
              certificateArn
            ),
          ],
          open: false,
          defaultAction: elbv2.ListenerAction.fixedResponse(404, {
            contentType: "text/plain",
            messageBody: "No matching route found",
          }),
        })
      : this.loadBalancer.addListener("HttpListener", {
          port: 80,
          protocol: elbv2.ApplicationProtocol.HTTP,
          open: false,
          defaultAction: elbv2.ListenerAction.fixedResponse(404, {
            contentType: "text/plain",
            messageBody: "No matching route found",
          }),
        });

    // Add routing rules to the listener

    listener.addAction("WeatherNodeJsRoute", {
      priority: 21,
      conditions: [elbv2.ListenerCondition.pathPatterns(["/weather-nodejs/*"])],
      action: elbv2.ListenerAction.forward([weatherNodeJsServer.targetGroup]),
    });

    // Add a rule to route auth-related paths to the auth server
    listener.addAction("WeatherNodeJsLambdaRoute", {
      priority: 22, // Lower number means higher priority
      conditions: [
        elbv2.ListenerCondition.pathPatterns(["/weather-nodejs-lambda/*"]),
      ],
      action: elbv2.ListenerAction.forward([
        weatherNodeJsLambdaServer.targetGroup,
      ]),
    });

    // Create CloudFront distribution with protocol matching ALB listener
    const albOrigin = new origins.LoadBalancerV2Origin(this.loadBalancer, {
      protocolPolicy: certificateArn
        ? cloudfront.OriginProtocolPolicy.HTTPS_ONLY
        : cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
      httpsPort: 443,
      connectionAttempts: 3,
      connectionTimeout: cdk.Duration.seconds(10),
      readTimeout: cdk.Duration.seconds(30),
      keepaliveTimeout: cdk.Duration.seconds(5),
    });

    const geoRestriction = cloudfront.GeoRestriction.allowlist(
      ...getAllowedCountries()
    );

    // Create the CloudFront distribution with conditional properties
    if (customDomain && certificateArn) {
      // With custom domain and certificate
      const certificate = acm.Certificate.fromCertificateArn(
        this,
        `MCPServerStackCertificate`,
        certificateArn
      );

      this.distribution = new cloudfront.Distribution(
        this,
        `MCPServerStackDistribution`,
        {
          defaultBehavior: {
            origin: albOrigin,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
            cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
            viewerProtocolPolicy:
              cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
          },
          domainNames: [customDomain],
          certificate: certificate,
          enabled: true,
          minimumProtocolVersion:
            cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
          httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
          priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
          comment: `CloudFront distribution for MCP-Server Stack with custom domain`,
          geoRestriction,
          webAclId: cloudFrontWafArnParam.stringValue,
          logBucket: accessLogsBucket,
          logFilePrefix: "cloudfront-logs/",
        }
      );
    } else {
      // Default CloudFront domain
      this.distribution = new cloudfront.Distribution(
        this,
        `MCPServerStackDistribution`,
        {
          defaultBehavior: {
            origin: albOrigin,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
            cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
            viewerProtocolPolicy:
              cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
          },
          enabled: true,
          httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
          priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
          comment: `CloudFront distribution for MCP-Server stack`,
          geoRestriction,
          webAclId: cloudFrontWafArnParam.stringValue,
          logBucket: accessLogsBucket,
          logFilePrefix: "cloudfront-logs/",
        }
      );
    }

    // Add suppressions for CloudFront TLS warnings
    NagSuppressions.addResourceSuppressions(this.distribution, [
      {
        id: "AwsSolutions-CFR4",
        reason:
          "Development environment using default CloudFront certificate without custom domain - TLS settings are managed by CloudFront",
      },
      {
        id: "AwsSolutions-CFR5",
        reason:
          "Development environment using HTTP-only communication to ALB origin which is internal to VPC",
      },
    ]);

    // Create Route 53 records if custom domain is provided
    if (customDomain && certificateArn) {
      // Look up the hosted zone
      const hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
        domainName: customDomain,
      });

      // Create A record for the custom domain
      new route53.ARecord(this, "McpServerARecord", {
        zone: hostedZone,
        recordName: customDomain,
        target: route53.RecordTarget.fromAlias(
          new route53targets.CloudFrontTarget(this.distribution)
        ),
      });
    }

    // Set the HTTPS URL
    const httpsUrl =
      customDomain && certificateArn
        ? `https://${customDomain}`
        : `https://${this.distribution.distributionDomainName}`;

    // Output CloudFront distribution details
    new cdk.CfnOutput(this, "CloudFrontDistributions", {
      value: httpsUrl,
      description: "CloudFront HTTPS URLs for all MCP servers",
    });
  }
}
